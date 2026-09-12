// T-1201 /api/v1 editing endpoints (run: cd api && npm run test:editing)
//
// Real PostgreSQL. Edit sessions (create with the whole-video default,
// timeline validation against owned + ready recordings and probed durations,
// the op log, discard), render enqueue (overwrite / copy — the copy pre-creates
// the output recording and takes a quota reservation; one render per
// recording; the multi-clip Pro paywall and the output-duration limit, both
// recorded as paywall events), the render-job read, remove-silences (202) and
// stitch (202). Nothing is rendered here — the worker does that (tests/render.test.js).
//
// SKIPS LOUDLY without PostgreSQL; EDITING_TESTS_REQUIRED=1 makes that a failure.
'use strict';

const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const API_DIR = path.join(ROOT, 'api');
const express = require(path.join(API_DIR, 'node_modules', 'express'));
const { loadEnv, createPool, createClient, createRepositories, withTransaction: rawTx } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));
const { createEditingRouter, createQuota } = require(path.join(API_DIR, 'src', 'index.js'));
const { validateTimeline, MAX_CLIPS } = require(path.join(API_DIR, 'src', 'editing.router.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.EDITING_TESTS_REQUIRED === '1';
const RUN = crypto.randomBytes(3).toString('hex');
const REASON = 'T-1201 editing api test';
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const MiB = 1024 * 1024;

(async () => {
  console.log('T-1201 editing endpoint tests');
  let env = null, pgUp = false, pool = null;
  try { env = loadEnv({ appEnv: 'test' }); } catch (e) { console.log('  env:', e.message); }
  if (env) { pool = createPool({ env, max: 6 }); try { await pool.query('select 1'); pgUp = true; } catch {} }
  if (!pgUp) {
    console.log('\n  SKIPPED — PostgreSQL unreachable');
    if (REQUIRED) { fail += 1; console.log('  FAIL: EDITING_TESTS_REQUIRED=1 but PostgreSQL is unavailable'); }
    if (pool) await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; return;
  }
  const db = createClient(pool);
  const repositories = () => createRepositories(db);
  const repos = repositories();
  const withTransaction = (fn) => rawTx(fn, db);
  const legacy = { alice: `a${RUN}`, bob: `b${RUN}` };
  const pg = (u) => `usr_${legacy[u]}`;
  for (const u of ['alice', 'bob']) {
    await db.execute(sql`INSERT INTO users (id,email,name,password_hash) VALUES (${pg(u)}, ${`${u}-t1201-${RUN}@example.com`}, ${u}, 'x')`);
    await db.execute(sql`INSERT INTO usage (user_id) VALUES (${pg(u)}) ON CONFLICT DO NOTHING`);
  }
  const rid = (k) => `rec_t1201_${k}_${RUN}`;
  const mkRec = async (k, { owner = 'alice', status = 'ready', duration = 30, sizeBytes = 3 * MiB } = {}) => {
    await db.execute(sql`INSERT INTO recordings (id,user_id,title,status,source_kind,privacy,duration,size_bytes,width,height) VALUES (${rid(k)}, ${pg(owner)}, ${`Edit ${k}`}, ${status}, 'extension', 'unlisted', ${duration}, ${sizeBytes}, 1280, 720)`);
    await db.execute(sql`INSERT INTO video_assets (id,recording_id,kind,variant,storage_key,status,size_bytes,counts_toward_quota,immutable) VALUES (${`ast_${k}_${RUN}`}, ${rid(k)}, 'source', null, ${`sources/${rid(k)}/source.webm`}, 'ready', ${sizeBytes}, true, true)`);
    return rid(k);
  };

  let currentUser = null, stitchOn = true, durationLimit = null;
  const limits = { maxStorageBytes: 5 * 1024 * MiB, maxActiveVideos: 50, minStartBytes: 64 * MiB, maxUploadBytes: 512 * MiB };
  const quota = createQuota({ resolveLimits: async () => limits, logger: silent });
  const entitlements = {
    isFeatureEnabled: async (f) => f === 'clipStitchEnabled' && stitchOn,
    canRecordDuration: async (sec) => (durationLimit !== null && sec > durationLimit ? { allowed: false, code: 'recording_limit', message: `Recordings over ${durationLimit} s need Pro.`, meta: { limit: durationLimit } } : { allowed: true }),
  };
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => { if (!currentUser) return res.status(401).json({ error: { code: 'unauthorized', message: 'no' } }); req.userId = currentUser; req.id = 'req_test'; next(); };
  app.use('/api/v1', createEditingRouter({ repositories, withTransaction, requireAuth, quota, entitlements, logger: silent }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const api = async (method, p, { as, body } = {}) => {
    if (as !== undefined) currentUser = as;
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const code = (r) => r.body && r.body.error && r.body.error.code;
  const job = (key) => repos.jobs.findByDedupeKey(key);
  const ledger = async (u) => (await db.execute(sql`select storage_reserved_bytes v, reserved_video_slots s from usage where user_id = ${pg(u)}`)).rows[0];

  try {
    console.log('\nA. Sessions: create, validate, ops, discard');
    const A = await mkRec('a'); const B = await mkRec('b', { duration: 12 }); const P = await mkRec('p', { status: 'processing' }); const BOB = await mkRec('bob', { owner: 'bob' });
    ok((await api('POST', `/recordings/${A}/edit-sessions`, { as: null, body: {} })).status === 401 && (await api('POST', `/recordings/${A}/edit-sessions`, { as: legacy.bob, body: {} })).status === 404, 'unauthenticated 401; another user\'s recording 404');
    const s1 = await api('POST', `/recordings/${A}/edit-sessions`, { as: legacy.alice, body: {} });
    ok(s1.status === 201 && s1.body.editSessionId.startsWith('eds_') && s1.body.status === 'draft' && s1.body.timeline.length === 1 && s1.body.timeline[0].recordingId === A && s1.body.timeline[0].start === 0 && s1.body.timeline[0].end === 30, 'a session defaults to the whole base video');
    const S = s1.body.editSessionId;
    ok(code(await api('PATCH', `/edit-sessions/${S}`, { as: legacy.alice, body: { timeline: [] } })) === 'invalid_request' && code(await api('PATCH', `/edit-sessions/${S}`, { as: legacy.alice, body: { timeline: [{ recordingId: A, start: 5, end: 2 }] } })) === 'invalid_request', 'an empty timeline or a clip with end ≤ start is 400');
    ok(code(await api('PATCH', `/edit-sessions/${S}`, { as: legacy.alice, body: { timeline: [{ recordingId: A, start: 0, end: 31 }] } })) === 'invalid_request', 'a clip beyond the probed duration is refused');
    ok((await api('PATCH', `/edit-sessions/${S}`, { as: legacy.alice, body: { timeline: [{ recordingId: BOB, start: 0, end: 5 }] } })).status === 404, 'a clip on another owner\'s recording → 404 (never confirmed)');
    ok(code(await api('PATCH', `/edit-sessions/${S}`, { as: legacy.alice, body: { timeline: [{ recordingId: P, start: 0, end: 5 }] } })) === 'recording_not_ready', 'a clip on a recording that is still processing → 409 recording_not_ready');
    ok(code(await api('PATCH', `/edit-sessions/${S}`, { as: legacy.alice, body: { timeline: Array.from({ length: MAX_CLIPS + 1 }, () => ({ recordingId: A, start: 0, end: 1 })) } })) === 'invalid_request', `more than ${MAX_CLIPS} clips is refused`);
    const p1 = await api('PATCH', `/edit-sessions/${S}`, { as: legacy.alice, body: { timeline: [{ recordingId: A, start: 2, end: 10 }, { recordingId: A, start: 20, end: 30.04 }], op: { type: 'split', clipIdx: 0, at: 10 } } });
    ok(p1.status === 200 && p1.body.timeline.length === 2 && p1.body.timeline[1].end === 30, 'PATCH stores the materialised timeline (a 40 ms overrun is snapped to the duration)');
    await api('PATCH', `/edit-sessions/${S}`, { as: legacy.alice, body: { timeline: [{ recordingId: A, start: 2, end: 10 }], op: { type: 'delete', clipIdx: 1 } } });
    const g = await api('GET', `/edit-sessions/${S}`, { as: legacy.alice });
    ok(g.status === 200 && g.body.ops.length === 2 && g.body.ops[0].idx === 0 && g.body.ops[0].op.type === 'split' && g.body.ops[1].op.type === 'delete' && g.body.timeline.length === 1, 'the op log is append-only and ordered; the timeline is the state');
    ok((await api('GET', `/edit-sessions/${S}`, { as: legacy.bob })).status === 404, 'another user cannot read the session');
    ok(code(await api('PATCH', `/edit-sessions/${S}`, { as: legacy.alice, body: { timeline: [{ recordingId: A, start: 0, end: 5 }], op: { type: 5 } } })) === 'invalid_request', 'an op needs a type');
    const s2 = await api('POST', `/recordings/${A}/edit-sessions`, { as: legacy.alice, body: { timeline: [{ recordingId: A, start: 0, end: 5 }] } });
    ok((await api('POST', `/edit-sessions/${s2.body.editSessionId}/discard`, { as: legacy.alice })).body.ok === true && (await api('GET', `/edit-sessions/${s2.body.editSessionId}`, { as: legacy.alice })).body.status === 'discarded' && code(await api('PATCH', `/edit-sessions/${s2.body.editSessionId}`, { as: legacy.alice, body: { timeline: [{ recordingId: A, start: 0, end: 5 }] } })) === 'invalid_state', 'a discarded session cannot be changed');
    const vt = await validateTimeline(repos, { userId: pg('alice') }, A, [{ recordingId: A, start: 0, end: 5 }, { recordingId: B, start: 1, end: 3 }]);
    ok(vt.durationSec === 7 && vt.multiSource === true && vt.recordings.size === 2, 'validateTimeline sums the duration and flags multi-source');

    console.log('\nB. Render enqueue: overwrite');
    ok(code(await api('POST', `/edit-sessions/${S}/render`, { as: legacy.alice, body: { mode: 'sideways' } })) === 'invalid_request', 'mode must be overwrite or copy');
    const r1 = await api('POST', `/edit-sessions/${S}/render`, { as: legacy.alice, body: { mode: 'overwrite' } });
    ok(r1.status === 202 && r1.body.renderJobId.startsWith('rnd_') && r1.body.jobId.startsWith('job_') && r1.body.outputRecordingId === null && r1.body.durationSec === 8, '202 with a render job, a processing job and the timeline duration');
    const pj = await job(`render:${S}:${r1.body.renderJobId}`);
    ok(pj && pj.queue === 'render' && pj.status === 'queued' && pj.maxAttempts === 2 && pj.payload.mode === 'overwrite' && pj.payload.editSessionId === S && pj.payload.timeline.length === 1 && pj.recordingId === A, 'the render row carries the session, mode and timeline; dedupe render:{session}:{renderJob}');
    const rj = await api('GET', `/render-jobs/${r1.body.renderJobId}`, { as: legacy.alice });
    ok(rj.status === 200 && rj.body.status === 'queued' && rj.body.progress === 0 && rj.body.mode === 'overwrite' && rj.body.editSessionId === S, 'GET /render-jobs/:id projects the job (progress from the processing row)');
    ok((await api('GET', `/render-jobs/${r1.body.renderJobId}`, { as: legacy.bob })).status === 404, 'another user cannot read the render job');
    ok((await api('GET', `/edit-sessions/${S}`, { as: legacy.alice })).body.status === 'rendering' && code(await api('PATCH', `/edit-sessions/${S}`, { as: legacy.alice, body: { timeline: [{ recordingId: A, start: 0, end: 5 }] } })) === 'invalid_state' && code(await api('POST', `/edit-sessions/${S}/discard`, { as: legacy.alice })) === 'invalid_state', 'while rendering the session is frozen');
    const s3 = await api('POST', `/recordings/${A}/edit-sessions`, { as: legacy.alice, body: {} });
    ok(code(await api('POST', `/edit-sessions/${s3.body.editSessionId}/render`, { as: legacy.alice, body: { mode: 'overwrite' } })) === 'render_in_progress', 'only one render per recording at a time (409 render_in_progress)');
    await repos.jobs.markActiveSystem(pj.id, REASON);
    await repos.jobs.setProgressSystem(pj.id, 42, REASON);
    ok((await api('GET', `/render-jobs/${r1.body.renderJobId}`, { as: legacy.alice })).body.progress === 42, 'progress streams from processing_jobs.result.progress (an active job)');
    // Let the worker's completion be simulated: session applied, job done.
    await repos.renderJobs.updateSystem(r1.body.renderJobId, { status: 'done' }, REASON);
    await repos.editSessions.setStatusSystem(S, 'applied', REASON);
    ok((await api('GET', `/render-jobs/${r1.body.renderJobId}`, { as: legacy.alice })).body.progress === 100, 'a done job reports 100 %');

    console.log('\nC. Render enqueue: copy takes a quota reservation and pre-creates the output');
    const s4 = await api('POST', `/recordings/${A}/edit-sessions`, { as: legacy.alice, body: { timeline: [{ recordingId: A, start: 0, end: 10 }] } });
    const before = await ledger('alice');
    const r2 = await api('POST', `/edit-sessions/${s4.body.editSessionId}/render`, { as: legacy.alice, body: { mode: 'copy' } });
    ok(r2.status === 202 && r2.body.outputRecordingId && r2.body.outputRecordingId.startsWith('rec_'), `copy → 202 with the pre-created output recording id [${r2.status} ${JSON.stringify(r2.body).slice(0, 300)}]`);
    const out = await repos.recordings.get({ userId: pg('alice') }, r2.body.outputRecordingId);
    ok(out && out.status === 'processing' && out.sourceKind === 'render' && out.title === 'Edit a (edited)' && out.privacy === 'unlisted', 'the output recording is processing, source_kind render, titled "<base> (edited)"');
    const after = await ledger('alice');
    const reservation = await repos.uploads.findReservationByRenderJob({ userId: pg('alice') }, r2.body.renderJobId);
    ok(reservation && reservation.status === 'held' && Number(reservation.reservedBytes) > 0 && Number(after.s) === Number(before.s) + 1 && Number(after.v) === Number(before.v) + Number(reservation.reservedBytes), 'a reservation row bound to the render job; the ledger holds one slot and the bytes');
    ok(Number(reservation.reservedBytes) <= 512 * MiB && Number(reservation.reservedBytes) >= 1 * MiB, 'the reservation is the estimated output (base bytes/second × timeline, +20 %), capped by the plan reserve');
    // Simulate the worker finishing the copy render so the base is free for the next sections.
    await repos.renderJobs.updateSystem(r2.body.renderJobId, { status: 'done' }, REASON);
    await repos.editSessions.setStatusSystem(s4.body.editSessionId, 'applied', REASON);

    console.log('\nD. Paywalls and limits');
    const s5 = await api('POST', `/recordings/${A}/edit-sessions`, { as: legacy.alice, body: { timeline: [{ recordingId: A, start: 0, end: 5 }, { recordingId: B, start: 0, end: 5 }] } });
    ok(s5.status === 201, 'a multi-clip draft is allowed (the gate is at render)');
    stitchOn = false;
    const locked = await api('POST', `/edit-sessions/${s5.body.editSessionId}/render`, { as: legacy.alice, body: { mode: 'copy' } });
    ok(locked.status === 403 && code(locked) === 'feature_locked' && locked.body.error.upgradeRequired === true, `a multi-clip render is a Pro paywall [${locked.status} ${JSON.stringify(locked.body).slice(0, 300)}]`);
    ok((await db.execute(sql`select props from analytics_events where event = 'paywall_hit' and user_id = ${pg('alice')} order by id desc limit 1`)).rows[0].props.trigger === 'clipstitch_attempted', 'the paywall is recorded (T-1003)');
    ok((await api('GET', `/edit-sessions/${s5.body.editSessionId}`, { as: legacy.alice })).body.status === 'draft', 'a refused render leaves the draft intact');
    stitchOn = true;
    durationLimit = 5;
    const tooLong = await api('POST', `/edit-sessions/${s5.body.editSessionId}/render`, { as: legacy.alice, body: { mode: 'overwrite' } });
    ok(tooLong.status === 403 && code(tooLong) === 'recording_limit' && tooLong.body.error.upgradeRequired === true, 'the output-duration entitlement is checked at enqueue (403 recording_limit)');
    durationLimit = null;
    const tightQuota = createQuota({ resolveLimits: async () => ({ ...limits, maxActiveVideos: 1 }), logger: silent });
    const app2 = express(); app2.use(express.json());
    app2.use('/api/v1', createEditingRouter({ repositories, withTransaction, requireAuth, quota: tightQuota, entitlements, logger: silent }));
    const srv2 = app2.listen(0, '127.0.0.1'); await new Promise((r) => srv2.once('listening', r));
    try {
      currentUser = legacy.alice;
      const s6 = await api('POST', `/recordings/${A}/edit-sessions`, { as: legacy.alice, body: { timeline: [{ recordingId: A, start: 0, end: 5 }] } });
      const res = await fetch(`http://127.0.0.1:${srv2.address().port}/api/v1/edit-sessions/${s6.body.editSessionId}/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'copy' }) });
      const body = await res.json();
      ok(res.status === 403 && body.error.code === 'video_limit' && body.error.upgradeRequired === true, 'a copy render past the video limit → 403 video_limit (the same atomic reservation as an upload)');
      ok((await api('GET', `/edit-sessions/${s6.body.editSessionId}`, { as: legacy.alice })).body.status === 'draft' && !(await repos.recordings.list({ userId: pg('alice') }, { limit: 100 })).some((r) => r.status === 'processing' && r.sourceKind === 'render' && r.id !== r2.body.outputRecordingId), 'the refused copy rolled back: draft intact, no stray output recording');
      const hit = (await db.execute(sql`select props from analytics_events where event = 'paywall_hit' and user_id = ${pg('alice')} order by id desc limit 1`)).rows[0];
      ok(hit.props.trigger === 'video_limit_reached', 'the limit refusal is a recorded paywall (video_limit_reached)');
    } finally { srv2.close(); }

    console.log('\nE. remove-silences and stitch');
    ok(code(await api('POST', `/recordings/${P}/remove-silences`, { as: legacy.alice })) === 'recording_not_ready', 'silence removal needs a ready recording');
    const sil = await api('POST', `/recordings/${B}/remove-silences`, { as: legacy.alice });
    const sj = await job(`silence:${B}`);
    ok(sil.status === 202 && sj && sil.body.jobId === sj.id && sj.queue === 'silence_detect' && sj.status === 'queued' && sj.payload.pad === 0.2 && sj.payload.minGap === 0.8, `202 with a silence_detect row (pad 0.2 s, minGap 0.8 s) [${sil.status} ${JSON.stringify(sil.body).slice(0,200)} job=${JSON.stringify(sj && { queue: sj.queue, status: sj.status, payload: sj.payload })}]`);
    ok((await api('POST', `/recordings/${B}/remove-silences`, { as: legacy.alice })).body.reused === true, 'a repeat while queued reuses the row');
    const sst = await api('GET', `/recordings/${B}/remove-silences`, { as: legacy.alice });
    ok(sst.status === 200 && sst.body.jobId === sj.id && sst.body.status === 'queued' && sst.body.result === null && sst.body.error === null, 'GET remove-silences reports the queued job (no result yet)');
    ok(code(await api('GET', `/recordings/${A}/remove-silences`, { as: legacy.alice })) === 'job_not_found' && (await api('GET', `/recordings/${B}/remove-silences`, { as: legacy.bob })).status === 404, 'no detection yet → 404 job_not_found; another owner → 404');
    await repos.jobs.markActiveSystem(sj.id, REASON);
    await repos.jobs.markCompletedSystem(sj.id, { segments: [{ start: 0, end: 4 }, { start: 6, end: 12 }], keptSeconds: 10, removedSeconds: 2, method: 'audio', duration: 12 }, REASON);
    const done = await api('GET', `/recordings/${B}/remove-silences`, { as: legacy.alice });
    ok(done.body.status === 'completed' && done.body.result.segments.length === 2 && done.body.result.removedSeconds === 2 && done.body.result.method === 'audio', 'once the worker is done the result (segments, kept/removed seconds, method) is served');
    await repos.jobs.markFailedSystem(sj.id, 'no_silence: nothing to trim', REASON, { terminal: true });
    ok((await api('GET', `/recordings/${B}/remove-silences`, { as: legacy.alice })).body.error === 'no_silence: nothing to trim', 'a failed detection reports its reason');
    ok(code(await api('POST', '/recordings/stitch', { as: legacy.alice, body: { ids: [A] } })) === 'invalid_request' && (await api('POST', '/recordings/stitch', { as: legacy.alice, body: { ids: [A, BOB] } })).status === 404, 'stitch needs 2–10 owned videos');
    const st = await api('POST', '/recordings/stitch', { as: legacy.alice, body: { ids: [B, A], title: 'My combined video' } });
    ok(st.status === 202 && st.body.editSessionId && st.body.renderJobId && st.body.outputRecordingId && st.body.durationSec === 42, 'stitch → a session over the whole clips + a copy render (202)');
    const stOut = await repos.recordings.get({ userId: pg('alice') }, st.body.outputRecordingId);
    const stSession = await repos.editSessions.get({ userId: pg('alice') }, st.body.editSessionId);
    ok(stOut.title === 'My combined video' && stOut.sourceKind === 'render' && stSession.recordingId === B && stSession.timeline.length === 2 && stSession.timeline[1].recordingId === A && stSession.status === 'rendering', 'the stitch session lives on the first clip with the ordered whole-clip timeline');
  } finally {
    server.close();
    await db.execute(sql`delete from users where id in (${pg('alice')}, ${pg('bob')})`).catch(() => {});
    await pool.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
