// T-403 recovery flow tests (run: cd server && npm run test:recovery)
//
// The recovery module is exercised for real against fake-indexeddb (the
// store) with a scripted uploader and fetch, one scenario per row of the
// docs/05 §8 restart matrix plus the docs/05 §6.1 reconciliation rules. The
// recorder/popup wiring is asserted at source level (they need DOM/chrome.*),
// and the server-side recovery KPI is asserted on the real kpi module. The
// end-to-end resume against the real server, PostgreSQL and MinIO is run in
// the in-app browser and recorded in docs/24.
'use strict';

const fs = require('fs');
const path = require('path');
const FAKE = path.join(__dirname, '..', 'server', 'node_modules', 'fake-indexeddb');
require(path.join(FAKE, 'auto'));
const { IDBFactory } = require(FAKE);
const EXT = path.join(__dirname, '..', 'extension');
const S = require(path.join(EXT, 'recorderStore.js'));
const R = require(path.join(EXT, 'recovery.js'));
const { createKpi } = require(path.join(__dirname, '..', 'server', 'kpi.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const bytes = (n, f = 1) => new Uint8Array(n).fill(f);
const fresh = (now) => S.openStore({ indexedDB: new IDBFactory(), storage: null, now });

/** A scripted uploader: records calls; behaviour per `plan`. */
function fakeUploaderFactory(plan) {
  const calls = { resume: [], begin: [], addChunk: [], finalize: [], fetchHeaders: [] };
  const factory = (opts) => {
    calls.opts = opts;
    const state = { session: null, parts: new Map(), fatal: null };
    const up = {
      state,
      async resume(id) {
        calls.resume.push(id);
        const r = plan.resume ? plan.resume(id) : { ok: false, status: 404 };
        if (r.ok) {
          state.session = { uploadSessionId: id, status: r.serverStatus, recordingId: r.recordingId || null };
          for (const p of (r.parts || [])) state.parts.set(p.partNumber, { partNumber: p.partNumber, size: p.size, etag: p.etag, status: 'uploaded' });
          return { ok: true, diff: { adopted: (r.parts || []).map((p) => p.partNumber), reupload: [], missing: [] } };
        }
        return r;
      },
      async begin(args) {
        calls.begin.push(args);
        const r = plan.begin ? plan.begin(args) : { ok: true };
        if (!r.ok) { state.fatal = r.fatal; return null; }
        state.session = { uploadSessionId: r.uploadSessionId || 'up_new', partSize: 8 * 1024 * 1024 };
        return state.session;
      },
      addChunk(b) { calls.addChunk.push(b.byteLength || b.size); },
      async finalize(a) { calls.finalize.push(a); return plan.finalize ? plan.finalize() : { ok: true, body: { recordingId: 'rec_x' } }; },
    };
    // Capture the recovery header the module injects.
    opts.fetchImpl('https://api/api/v1/probe', { headers: {} }).then((r) => r && calls.fetchHeaders.push(r.headers)).catch(() => {});
    return up;
  };
  return { factory, calls };
}

(async () => {
  console.log('T-403 recovery flow tests');
  let clock = 1_000_000;
  const now = () => clock;
  const server = 'https://api';
  const okFetch = async (url, init) => ({ ok: true, status: 200, headers: init && init.headers, json: async () => ({ id: 'rec_created' }) });

  // ── A. Launch scan (docs/05 §6, §3, §7) ──────────────────────────────────
  console.log('\nA. Scan');
  const st = await fresh(now);
  const dead = await st.createSession({ title: 'dead', userId: 'u1' });
  await st.appendChunk(dead.id, bytes(10));
  const phantom = await st.createSession({ title: 'phantom', userId: 'u1' });   // no chunks, and about to go stale
  clock += 20_000;                                            // heartbeats stale → dead / phantom
  const live = await st.createSession({ title: 'live', userId: 'u1' });
  await st.appendChunk(live.id, bytes(10));
  clock += 1_000;
  let scan = await R.scan({ store: st, now, currentUserId: 'u1' });
  ok(scan.live && scan.live.id === live.id, 'a session with a live heartbeat is reported as LIVE (refuse to start)');
  ok(scan.recoverable.length === 1 && scan.recoverable[0].id === dead.id, 'the dead session is recoverable; the live one is not listed');
  ok(scan.deleted.includes(phantom.id) && (await st.getSession(phantom.id)) === null, 'a zero-chunk session is deleted as a phantom, not offered');
  ok(scan.recoverable[0].ownedByCurrentUser === true, 'owned by the current user');
  await st.updateSession(live.id, { status: 'stopped' });
  const other = await st.createSession({ title: 'other', userId: 'u2' });
  await st.appendChunk(other.id, bytes(5));
  await st.updateSession(other.id, { status: 'failed' });
  scan = await R.scan({ store: st, now, currentUserId: 'u1' });
  ok(!scan.live && scan.recoverable.length === 3, 'a stopped session and a failed one are recoverable; nothing is live');
  ok(scan.recoverable[0].id === other.id && scan.recoverable[2].id === dead.id, 'newest first (docs/05 §6.2)');
  ok(scan.recoverable.find((s) => s.id === other.id).ownedByCurrentUser === false, 'another account\'s session is flagged (Download/Discard only)');
  // GC: 7 days.
  clock += S.GC_AGE_MS + 1;
  const young = await st.createSession({ title: 'young', userId: 'u1' }); await st.appendChunk(young.id, bytes(1));
  clock += 20_000;                                            // young is dead (recoverable), not live, and far from 7 days old
  scan = await R.scan({ store: st, now, currentUserId: 'u1' });
  ok(scan.recoverable.length === 1 && scan.recoverable[0].id === young.id && scan.deleted.length >= 3, 'sessions untouched for 7 days are garbage-collected at launch');
  const d = await R.describe(st, scan.recoverable[0]);
  ok(d.durationSec === 1 && d.sizeBytes === 1 && d.totalParts === 0 && typeof d.recordedAt === 'number', 'describe() gives the card its facts (duration = chunkCount seconds)');
  st.close();

  // ── B. Resume — crash mid-recording with a valid server session ──────────
  console.log('\nB. Resume with a valid server session (server view wins)');
  {
    const store = await fresh(now);
    const s = await store.createSession({ title: 'mid', userId: 'u1', recordingId: 'rec_1', uploadSessionId: 'up_1' });
    for (let i = 0; i < 6; i += 1) await store.appendChunk(s.id, bytes(100, i));
    // Local rows: part 1 (seq 0..2) uploaded with etag; part 2 (seq 3..4) inflight — its PUT actually succeeded (crash before etag write).
    await store.upsertPart(s.id, { partNumber: 1, firstSeq: 0, lastSeq: 2, size: 300, status: 'uploaded', etag: 'e1' });
    await store.upsertPart(s.id, { partNumber: 2, firstSeq: 3, lastSeq: 4, size: 200, status: 'inflight' });
    clock += 20_000;
    const { factory, calls } = fakeUploaderFactory({
      resume: () => ({ ok: true, serverStatus: 'active', parts: [{ partNumber: 1, size: 300, etag: 'e1' }, { partNumber: 2, size: 200, etag: 'e2' }] }),
    });
    const out = await R.resumeSession({ store, session: s, server, token: 't', createUploader: factory, fetchImpl: okFetch, currentUserId: 'u1' });
    ok(out.kind === 'saved' && out.watchUrl === 'https://veorec.com/watch/rec_1', 'the upload completes and yields the watch link');
    ok(calls.resume[0] === 'up_1' && calls.begin.length === 0, 'the existing server session was resumed, no new one created');
    ok(calls.addChunk.length === 1, 'ONLY the chunk not covered by server-held parts was fed (seq 5) — nothing re-uploaded');
    ok(calls.finalize.length === 1 && calls.finalize[0].clientDuration === 6, 'finalize called with the duration hint');
    ok((await store.getSession(s.id)) === null, 'the local session is deleted after the server confirmed completion');
    ok(calls.fetchHeaders[0] && calls.fetchHeaders[0]['X-VeoRec-Recovery'] === '1', 'every /api/v1 call is tagged X-VeoRec-Recovery: 1');
    store.close();
  }

  // ── C. Crash between server-complete and local delete ────────────────────
  console.log('\nC. Already saved');
  {
    const store = await fresh(now);
    const s = await store.createSession({ title: 'done', userId: 'u1', recordingId: 'rec_2', uploadSessionId: 'up_2' });
    await store.appendChunk(s.id, bytes(10));
    const { factory, calls } = fakeUploaderFactory({ resume: () => ({ ok: true, serverStatus: 'completed' }) });
    const out = await R.resumeSession({ store, session: s, server, token: 't', createUploader: factory, fetchImpl: okFetch });
    ok(out.kind === 'already_saved' && out.watchUrl.endsWith('rec_2'), 'a completed server session → "already saved" with the watch link');
    ok(calls.addChunk.length === 0 && calls.finalize.length === 0, 'nothing is uploaded again (idempotent completion)');
    ok((await store.getSession(s.id)) === null, 'local data deleted');
    store.close();
  }

  // ── D. Expired server session → fresh session, all chunks ────────────────
  console.log('\nD. Expired → fresh');
  {
    const store = await fresh(now);
    const s = await store.createSession({ title: 'exp', userId: 'u1', recordingId: 'rec_3', uploadSessionId: 'up_old' });
    for (let i = 0; i < 4; i += 1) await store.appendChunk(s.id, bytes(50));
    await store.upsertPart(s.id, { partNumber: 1, firstSeq: 0, lastSeq: 1, size: 100, status: 'uploaded', etag: 'stale' });
    const { factory, calls } = fakeUploaderFactory({ resume: () => ({ ok: false, status: 410 }), begin: () => ({ ok: true, uploadSessionId: 'up_fresh' }) });
    const out = await R.resumeSession({ store, session: s, server, token: 't', createUploader: factory, fetchImpl: okFetch });
    ok(out.kind === 'saved', 'an expired session is recovered through a fresh one');
    ok(calls.begin.length === 1 && calls.begin[0].recordingId === 'rec_3', 'the fresh session reuses the same recording');
    ok(calls.addChunk.length === 4, 'ALL chunks are fed — the stale local part is not trusted');
    store.close();
  }

  // ── E. Recorded offline: no recordingId, no session ──────────────────────
  console.log('\nE. Offline recording');
  {
    const store = await fresh(now);
    const s = await store.createSession({ title: 'offline', userId: 'u1' });
    for (let i = 0; i < 3; i += 1) await store.appendChunk(s.id, bytes(10));
    const posts = [];
    const fetchImpl = async (url, init) => { if (/\/recordings$/.test(url)) posts.push(init); return okFetch(url, init); };
    const { factory, calls } = fakeUploaderFactory({ begin: () => ({ ok: true }) });
    const out = await R.resumeSession({ store, session: s, server, token: 't', createUploader: factory, fetchImpl });
    ok(out.kind === 'saved' && out.recordingId === 'rec_created', 'a recording row is created first, then uploaded');
    ok(posts.length === 1 && /Idempotency-Key/.test(JSON.stringify(posts[0].headers)) && posts[0].headers['X-VeoRec-Recovery'] === '1',
      'the create is idempotent and tagged as recovery');
    ok(calls.resume.length === 0 && calls.addChunk.length === 3, 'no resume attempted; all chunks fed');
    store.close();
  }

  // ── F. Keep-data outcomes: auth, quota, failure, cross-account ───────────
  console.log('\nF. Keep-data outcomes');
  {
    const store = await fresh(now);
    const mk = async (title, extra = {}) => { const s = await store.createSession({ title, userId: 'u1', ...extra }); await store.appendChunk(s.id, bytes(10)); return s; };
    // 401 on resume
    let s = await mk('auth', { uploadSessionId: 'up_a', recordingId: 'rec_a' });
    let f = fakeUploaderFactory({ resume: () => ({ ok: false, status: 401 }) });
    let out = await R.resumeSession({ store, session: s, server, token: 't', createUploader: f.factory, fetchImpl: okFetch });
    ok(out.kind === 'auth_required' && (await store.getSession(s.id)).status === 'failed', '401 → auth_required; data kept as failed');
    // 403 quota at begin
    s = await mk('quota');
    f = fakeUploaderFactory({ begin: () => ({ ok: false, fatal: { status: 403, code: 'storage_limit', message: 'limit' } }) });
    out = await R.resumeSession({ store, session: s, server, token: 't', createUploader: f.factory, fetchImpl: okFetch });
    ok(out.kind === 'quota' && out.code === 'storage_limit' && (await store.getSession(s.id)), 'quota verdict → data kept, Download/Discard remain');
    // finalize fails
    s = await mk('fail');
    f = fakeUploaderFactory({ begin: () => ({ ok: true }), finalize: () => ({ ok: false, status: 500, body: {} }) });
    out = await R.resumeSession({ store, session: s, server, token: 't', createUploader: f.factory, fetchImpl: okFetch });
    ok(out.kind === 'failed' && (await store.getSession(s.id)).status === 'failed' && (await store.getChunks(s.id)).length === 1, 'a failed upload keeps every chunk');
    // cross-account
    s = await mk('cross', { userId: 'u2' });
    f = fakeUploaderFactory({});
    out = await R.resumeSession({ store, session: s, server, token: 't', createUploader: f.factory, fetchImpl: okFetch, currentUserId: 'u1' });
    ok(out.kind === 'cross_account' && f.calls.begin.length === 0 && f.calls.resume.length === 0, 'another account\'s session is never uploaded');
    // network failure creating the recording
    s = await mk('net');
    f = fakeUploaderFactory({});
    out = await R.resumeSession({ store, session: s, server, token: 't', createUploader: f.factory, fetchImpl: async () => { throw new Error('offline'); } });
    ok(out.kind === 'failed' && (await store.getSession(s.id)), 'a network failure keeps the data');
    store.close();
  }

  // ── G. Download and discard ──────────────────────────────────────────────
  console.log('\nG. Download / Discard');
  {
    const store = await fresh(now);
    const s = await store.createSession({ title: 'dl', userId: 'u1', uploadSessionId: 'up_d' });
    for (let i = 0; i < 3; i += 1) await store.appendChunk(s.id, bytes(4, i + 1));
    await store.updateSession(s.id, { clientDuration: 2.5 });
    const fixed = [];
    const saved = [];
    const out = await R.downloadSession({ store, session: await store.getSession(s.id),
      fixWebmDuration: async (blob, ms) => { fixed.push(ms); return blob; },
      saveAs: async (blob, name) => { saved.push({ name, size: blob.size, bytes: new Uint8Array(await blob.arrayBuffer()) }); } });
    ok(saved.length === 1 && saved[0].size === 12 && /veorec-recovered-.*\.webm$/.test(saved[0].name), 'download assembles the chunks into a .webm');
    ok(saved[0].bytes[0] === 1 && saved[0].bytes[4] === 2 && saved[0].bytes[8] === 3, 'in seq order');
    ok(fixed[0] === 2500, 'fixWebmDuration is applied with the client duration');
    ok(out.seconds === 2.5 && (await store.getSession(s.id)), 'the recording is KEPT after a download');
    const deletes = [];
    await R.discardSession({ store, session: s, server, token: 't', fetchImpl: async (url, init) => { deletes.push({ url, method: init.method }); return { ok: true }; } });
    ok(deletes.length === 1 && deletes[0].method === 'DELETE' && /\/api\/v1\/uploads\/up_d$/.test(deletes[0].url), 'discard aborts the server session best-effort');
    ok((await store.getSession(s.id)) === null && (await store.getChunks(s.id)).length === 0, 'and deletes the local data');
    const s2 = await store.createSession({ title: 'nosess', userId: 'u1' });
    await R.discardSession({ store, session: s2, server, token: 't', fetchImpl: async () => { throw new Error('boom'); } });
    ok((await store.getSession(s2.id)) === null, 'a failing server abort does not stop the local discard');
    store.close();
  }

  // ── H. Wiring (source level) ─────────────────────────────────────────────
  console.log('\nH. Wiring');
  const rec = fs.readFileSync(path.join(EXT, 'recorder.js'), 'utf8');
  const html = fs.readFileSync(path.join(EXT, 'recorder.html'), 'utf8');
  const popup = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8');
  const code = rec.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const scripts = html.match(/<script src="([^"]+)"><\/script>/g).map((x) => x.match(/"([^"]+)"/)[1]);
  ok(scripts.indexOf('recovery.js') > scripts.indexOf('uploader.js') && scripts.indexOf('recovery.js') < scripts.indexOf('recorder.js'), 'recovery.js loads after uploader.js and before recorder.js');
  ok(/id="recoveryCard"/.test(html), 'the recovery card container exists');
  ok(/const verdict = await runRecoveryScan\(\)[\s\S]*?if \(!verdict\.proceed\) return;[\s\S]*?beginRecording\(\)\.catch\(onStartError\)/.test(code), 'the launch scan runs BEFORE auto-start and gates it (T-307 adds the quota pre-flight between them)');
  ok(/if \(result\.live\)[\s\S]*?already running in another VeoRec window/.test(rec), 'a live session elsewhere refuses to start with a plain message');
  ok(/mk\('⬆ Resume upload'/.test(rec) && /mk\('⬇ Download'/.test(rec) && /mk\('🗑 Discard'/.test(rec), 'Resume / Download / Discard actions');
  ok(/if \(d\.ownedByCurrentUser\) mk\('⬆ Resume upload'/.test(code), 'Resume is offered only for the current user\'s sessions');
  ok(/publishRecoverable\(result\.recoverable\.length\)/.test(code) && /recoverable: \{ count, at: Date\.now\(\) \}/.test(code), 'the count is published for the popup badge');
  ok(/fixWebmDuration: \(typeof fixWebmDuration === 'function' \? fixWebmDuration : null\)/.test(code), 'local download uses fixWebmDuration');
  ok(/window\.confirm\('Discard this unfinished recording\?/.test(rec), 'discard asks first');
  ok(/out\.kind === 'auth_required'/.test(code) && /nothing was lost/.test(rec), 'auth failure keeps the data and says so');
  ok(/out\.kind === 'quota'/.test(code) && /Delete a video & retry/.test(rec), 'a quota verdict keeps Download / Delete a video & retry (T-307 made them explicit buttons)');
  ok(/showRecoverableBadge\(data\.recoverable\)/.test(popup) && /unsaved recording/.test(popup) && /recorder\.html\?recover=1/.test(popup), 'the popup shows a recovered-recordings badge that opens the recorder');
  ok(/chrome\.storage\.onChanged\.addListener/.test(popup) && /changes\.recoverable/.test(popup), 'the badge updates live');

  // ── I. Server-side recovery KPI ──────────────────────────────────────────
  console.log('\nI. Recovery KPI');
  const lines = [];
  const kpi = createKpi({ info: (o) => lines.push(o), warn() {}, error() {}, debug() {}, child() { return this; } }, { snapshotIntervalMs: 0 });
  let req = {}; kpi.uploadStarted(req, { path: 'v1', recovery: true }); kpi.uploadFinished(req, 'success', { path: 'v1' });
  req = {}; kpi.uploadStarted(req, { path: 'v1', recovery: true }); kpi.uploadFinished(req, 'error', { path: 'v1', code: 'x' });
  req = {}; kpi.uploadStarted(req, { path: 'v1' }); kpi.uploadFinished(req, 'success', { path: 'v1' });
  const c = kpi._counters;
  ok(c.recoveryAttempt === 2 && c.recoverySuccess === 1 && c.recoveryFailure === 1, 'recovery attempts/successes/failures are counted from the tagged uploads');
  ok(c.uploadV1Attempt === 3, 'and still count in the pooled v1 totals');
  ok(lines.some((l) => l.kpi === 'upload_finished' && l.recovery === true) && lines.some((l) => l.kpi === 'upload_finished' && l.recovery === false), 'upload lines carry recovery:true/false');
  kpi.snapshot();
  const snap = lines.find((l) => l.kpi === 'kpi_snapshot');
  ok(snap.recovery && snap.recovery.effectivenessPct === 50, 'the snapshot reports recovery effectiveness (successes / attempts)');
  kpi._stop();
  const idx = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  ok(/recovery: r\.get\('X-VeoRec-Recovery'\) === '1'/.test(idx), 'the server tags telemetry from the X-VeoRec-Recovery header (the router stays telemetry-agnostic)');

  // ── J. Boundaries ────────────────────────────────────────────────────────
  console.log('\nJ. Boundaries');
  const rsrc = fs.readFileSync(path.join(EXT, 'recovery.js'), 'utf8');
  const rcode = rsrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok(!/chrome\./.test(rcode) && !/document\./.test(rcode) && !/window\./.test(rcode), 'recovery.js knows no DOM and no chrome.*');
  const deletions = (rcode.match(/deleteSession\(/g) || []).length;
  const inScan = /if \(!s\.chunkCount\) \{[\s\S]*?deleteSession\(s\.id\)/.test(rcode);
  const inSaved = /const finishSaved = async[\s\S]*?deleteSession\(session\.id\)/.test(rcode);
  const inDiscard = /async function discardSession[\s\S]*?deleteSession\(session\.id\)/.test(rcode);
  ok(deletions === 3 && inScan && inSaved && inDiscard,
    'local data is deleted only for a zero-chunk phantom, on server-confirmed completion, or on explicit discard');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
