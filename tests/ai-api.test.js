// T-603 /api/v1 transcription & AI endpoints (run: cd api && npm run test:ai)
//
// Real PostgreSQL. Every trigger must answer 202 with a job row and NEVER run
// transcription in the API process; gates are paywalls; a non-owner sees 404;
// GET /transcript exposes the real status model; /status projects the pipeline.
// Section H drives the auto-processing chain through a real single-PUT upload
// completion (needs MinIO) — rows only, gated like the legacy auto-process.
//
// SKIPS LOUDLY without PostgreSQL; AI_API_TESTS_REQUIRED=1 makes that a failure.
'use strict';

const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const API_DIR = path.join(ROOT, 'api');
const express = require(path.join(API_DIR, 'node_modules', 'express'));
const { loadEnv, createPool, createClient, createRepositories, withTransaction: rawTx } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));
const { createAiRouter, createUploadRouter } = require(path.join(API_DIR, 'src', 'index.js'));
const { transcriptBody, LANG_RE } = require(path.join(API_DIR, 'src', 'ai.router.js'));
const W = require(path.join(ROOT, 'worker', 'src', 'index.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.AI_API_TESTS_REQUIRED === '1';
const MINIO = process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100';
const RUN = crypto.randomBytes(3).toString('hex');
const REASON = 'T-603 ai api test';
const silent = { info() {}, warn() {}, error() {}, debug() {} };

(async () => {
  console.log('T-603 /api/v1 transcription & AI endpoint tests');
  ok(LANG_RE.test('ur') && LANG_RE.test('pt-BR') && !LANG_RE.test('english') && !LANG_RE.test('x'), 'language codes are validated as ISO-639-1/-2 (+ optional region)');
  const shape = transcriptBody(null, [], true);
  ok(shape.status === 'none' && shape.configured === true && shape.segments.length === 0 && shape.text === '', 'no transcript → status none');
  ok(transcriptBody({ status: 'done', text: '', language: 'en', source: 'groq' }, [], false).note === 'no_speech', 'done with zero segments → note no_speech');

  let env = null, pgUp = false, pool = null;
  try { env = loadEnv({ appEnv: 'test' }); } catch (e) { console.log('  env:', e.message); }
  if (env) { pool = createPool({ env, max: 6 }); try { await pool.query('select 1'); pgUp = true; } catch {} }
  if (!pgUp) {
    console.log('\n  SKIPPED — PostgreSQL unreachable');
    if (REQUIRED) { fail += 1; console.log('  FAIL: AI_API_TESTS_REQUIRED=1 but PostgreSQL is unavailable'); }
    if (pool) await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; return;
  }
  const db = createClient(pool);
  const repositories = () => createRepositories(db);
  const repos = repositories();
  const withTransaction = (fn) => rawTx(fn, db);
  // Users keyed like the identity bridge expects (usr_<legacy id>).
  const legacy = { alice: `a${RUN}`, bob: `b${RUN}` };
  const pg = (u) => `usr_${legacy[u]}`;
  for (const u of ['alice', 'bob']) await db.execute(sql`INSERT INTO users (id,email,name,password_hash) VALUES (${pg(u)}, ${`${u}-${RUN}@example.com`}, ${u}, 'x')`);
  const rid = (k) => `rec_t603api_${k}_${RUN}`;
  const mkRec = async (k, owner = 'alice', { status = 'uploaded', withSource = true, title = 'Screen recording' } = {}) => {
    await db.execute(sql`INSERT INTO recordings (id,user_id,title,status,source_kind,privacy) VALUES (${rid(k)}, ${pg(owner)}, ${title}, ${status}, 'extension', 'unlisted')`);
    if (withSource) await db.execute(sql`INSERT INTO video_assets (id,recording_id,kind,storage_key,status,size_bytes,counts_toward_quota) VALUES (${`ast_${k}_${RUN}`}, ${rid(k)}, 'source', ${`sources/${rid(k)}/source.webm`}, 'ready', 1000, true)`);
    return rid(k);
  };

  let currentUser = null, features = { transcriptionEnabled: true, aiDocsEnabled: true }, configured = true;
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => {
    if (!currentUser) return res.status(401).json({ error: { code: 'unauthorized', message: 'no' } });
    req.userId = currentUser; req.id = 'req_test'; next();
  };
  const entitlements = { isFeatureEnabled: async (f) => !!features[f] };
  app.use('/api/v1', createAiRouter({ repositories, withTransaction, requireAuth, entitlements, configured: () => configured, logger: silent }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const api = async (method, p, { as, body } = {}) => {
    if (as !== undefined) currentUser = as;
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const job = (key) => repos.jobs.findByDedupeKey(key);
  const rec = (id) => repos.recordings.getSystem(id, REASON);

  try {
    console.log('\nA. Gates and ownership');
    const A = await mkRec('a');
    ok((await api('POST', `/recordings/${A}/transcribe`, { as: null })).status === 401, 'unauthenticated → 401');
    ok((await api('POST', `/recordings/${A}/transcribe`, { as: legacy.bob })).status === 404, 'another user\'s recording → 404 (indistinguishable from missing)');
    ok((await api('GET', `/recordings/${A}/transcript`, { as: legacy.bob })).status === 404 && (await api('GET', `/recordings/${A}/status`, { as: legacy.bob })).status === 404, 'transcript/status are owner-only too');
    features = { transcriptionEnabled: false, aiDocsEnabled: false };
    const locked = await api('POST', `/recordings/${A}/transcribe`, { as: legacy.alice });
    ok(locked.status === 403 && locked.body.error.code === 'feature_locked' && locked.body.error.upgradeRequired === true && locked.body.error.details.feature === 'transcriptionEnabled', 'transcription gate is a paywall: 403 feature_locked + upgradeRequired');
    features = { transcriptionEnabled: true, aiDocsEnabled: true };
    configured = false;
    const unconf = await api('POST', `/recordings/${A}/transcribe`, { as: legacy.alice });
    ok(unconf.status === 501 && unconf.body.error.code === 'transcription_unconfigured', 'no provider → 501 transcription_unconfigured');
    configured = true;
    ok((await api('POST', `/recordings/${A}/transcribe`, { as: legacy.alice, body: { language: 'english' } })).body.error.code === 'invalid_request', 'a non-ISO language is rejected');
    const R = await mkRec('rec', 'alice', { status: 'recording' });
    const notYet = await api('POST', `/recordings/${R}/transcribe`, { as: legacy.alice });
    ok(notYet.status === 409 && notYet.body.error.code === 'not_transcribable', 'a recording still being recorded cannot be transcribed');
    const NS = await mkRec('nosrc', 'alice', { withSource: false });
    ok((await api('POST', `/recordings/${NS}/transcribe`, { as: legacy.alice })).body.error.code === 'not_transcribable', 'no media yet → 409');
    ok(!(await job(`stt:${A}`)) && !(await job(`stt:${R}`)), 'refused requests create no job rows');

    console.log('\nB. POST /transcribe → 202 rows');
    const t1 = await api('POST', `/recordings/${A}/transcribe`, { as: legacy.alice, body: { language: 'ur' } });
    const j1 = await job(`stt:${A}`);
    ok(t1.status === 202 && t1.body.jobId === j1.id && t1.body.status === 'queued' && t1.body.reused === false, '202 {jobId} with a queued job row');
    ok(j1.queue === 'transcribe' && j1.recordingId === A && j1.payload.trigger === 'manual' && j1.payload.language === 'ur' && j1.payload.aiDocs === true && j1.enqueuedAt === null, 'the row carries the manual trigger, the language override and the AI-docs entitlement; unstamped for the relay');
    const tr1 = await repos.transcripts.getForPublicWatch(A);
    ok(tr1 && tr1.status === 'queued' && tr1.spokenLangOverride === 'ur' && (await rec(A)).aiStatus === 'queued', 'transcript row queued with the override; ai_status queued');
    const t2 = await api('POST', `/recordings/${A}/transcribe`, { as: legacy.alice });
    ok(t2.status === 202 && t2.body.jobId === j1.id && t2.body.reused === true, 'a second request while queued reuses the same job (dedupe)');
    // Simulate the worker finishing.
    await repos.jobs.markActiveSystem(j1.id, REASON); await repos.jobs.markCompletedSystem(j1.id, { segments: 2 }, REASON);
    await withTransaction(async (tx) => {
      const t = await tx.transcripts.upsertSystem(A, { status: 'done', language: 'urdu', text: 'سلام دنیا hello', source: 'groq', spokenLangOverride: 'ur' }, REASON);
      await tx.transcripts.replaceSegmentsSystem(t.id, [{ idx: 0, start: 0, end: 1.5, text: 'سلام دنیا', language: 'urdu' }, { idx: 1, start: 1.5, end: 3, text: 'hello', language: 'english' }], REASON);
    });
    await repos.recordings.updateSystem(A, { aiStatus: 'done' }, REASON);
    const t3 = await api('POST', `/recordings/${A}/transcribe`, { as: legacy.alice });
    const j3 = await job(`stt:${A}`);
    ok(t3.status === 202 && j3.id === j1.id && j3.status === 'queued' && j3.attempts === 0 && j3.enqueuedAt === null && t3.body.reused === false, 're-transcribing a finished recording requeues the SAME logical job (attempts reset)');
    ok((await repos.transcripts.getForPublicWatch(A)).status === 'queued' && (await rec(A)).aiStatus === 'queued', 'the transcript goes back to queued');
    await repos.jobs.markActiveSystem(j1.id, REASON); await repos.jobs.markCompletedSystem(j1.id, { segments: 2 }, REASON);
    await repos.transcripts.upsertSystem(A, { status: 'done', language: 'urdu', text: 'سلام دنیا hello', source: 'groq', spokenLangOverride: 'ur' }, REASON);
    await repos.recordings.updateSystem(A, { aiStatus: 'done' }, REASON);

    console.log('\nC. GET /transcript status model');
    const g = await api('GET', `/recordings/${A}/transcript`, { as: legacy.alice });
    ok(g.status === 200 && g.body.status === 'done' && g.body.language === 'urdu' && g.body.segments.length === 2 && g.body.segments[0].start === 0 && g.body.segments[1].language === 'english' && g.body.source === 'groq' && g.body.spokenLang === 'ur' && g.body.configured === true, 'done: language, mixed-language segments with numeric times, source, override');
    const N = await mkRec('none');
    const gn = await api('GET', `/recordings/${N}/transcript`, { as: legacy.alice });
    ok(gn.body.status === 'none' && gn.body.text === '' && gn.body.segments.length === 0, 'no transcript → none');
    const F = await mkRec('failed');
    await repos.transcripts.upsertSystem(F, { status: 'failed', error: 'no_source' }, REASON);
    const gf = await api('GET', `/recordings/${F}/transcript`, { as: legacy.alice });
    ok(gf.body.status === 'failed' && gf.body.error === 'no_source' && gf.body.text === '', 'failed: the error code is exposed, no stale text');
    const Q = await mkRec('nospeech');
    await repos.transcripts.upsertSystem(Q, { status: 'done', text: '', language: 'english', source: 'groq' }, REASON);
    ok((await api('GET', `/recordings/${Q}/transcript`, { as: legacy.alice })).body.note === 'no_speech', 'done with no segments → note no_speech (a valid outcome)');

    console.log('\nD. DELETE /transcribe');
    const d1 = await api('DELETE', `/recordings/${F}/transcribe`, { as: legacy.alice });
    const d2 = await api('DELETE', `/recordings/${F}/transcribe`, { as: legacy.alice });
    ok(d1.body.ok === true && d1.body.removed === 1 && d2.body.ok === true && d2.body.removed === 0 && (await api('GET', `/recordings/${F}/transcript`, { as: legacy.alice })).body.status === 'none', 'delete clears the transcript and is idempotent');

    console.log('\nE. Translate: cache or 202');
    features = { transcriptionEnabled: true, aiDocsEnabled: false };
    ok((await api('POST', `/recordings/${A}/transcript/translate`, { as: legacy.alice, body: { lang: 'es' } })).body.error.code === 'feature_locked', 'translation needs AI docs');
    features = { transcriptionEnabled: true, aiDocsEnabled: true };
    ok((await api('POST', `/recordings/${A}/transcript/translate`, { as: legacy.alice, body: { lang: 'spanish' } })).status === 400, 'lang must be a code');
    ok((await api('POST', `/recordings/${N}/transcript/translate`, { as: legacy.alice, body: { lang: 'es' } })).body.error.code === 'transcript_required', 'no transcript → 409 transcript_required');
    const tr = await api('POST', `/recordings/${A}/transcript/translate`, { as: legacy.alice, body: { lang: 'es' } });
    ok(tr.status === 202 && (await job(`translate:${A}:es`)).payload.lang === 'es', 'uncached → 202 with a translate job');
    const tA = await repos.transcripts.getForPublicWatch(A);
    await repos.transcripts.putTranslationSystem(tA.id, 'es', [{ idx: 0, start: 0, end: 1.5, text: 'hola mundo' }], REASON);
    const tr2 = await api('POST', `/recordings/${A}/transcript/translate`, { as: legacy.alice, body: { lang: 'es' } });
    ok(tr2.status === 200 && tr2.body.cached === true && tr2.body.segments[0].text === 'hola mundo', 'cached → 200 from the cache, no job');

    console.log('\nF. AI triggers → 202');
    features = { transcriptionEnabled: true, aiDocsEnabled: false };
    ok((await api('POST', `/recordings/${A}/summary`, { as: legacy.alice })).body.error.code === 'feature_locked' && (await api('POST', `/recordings/${A}/chapters`, { as: legacy.alice })).body.error.code === 'feature_locked', 'summary/chapters need AI docs');
    const ta = await api('POST', `/recordings/${A}/title/auto`, { as: legacy.alice });
    ok(ta.status === 202 && (await job(`ai_title:${A}`)).payload.trigger === 'manual' && (await rec(A)).aiStatus === 'queued', 'title/auto needs only transcription: 202, manual trigger, ai_status queued');
    features = { transcriptionEnabled: true, aiDocsEnabled: true };
    ok((await api('POST', `/recordings/${A}/summary`, { as: legacy.alice })).status === 202 && (await api('POST', `/recordings/${A}/chapters`, { as: legacy.alice })).status === 202, 'summary/chapters → 202');
    ok((await api('POST', `/recordings/${N}/title/auto`, { as: legacy.alice })).body.error.code === 'transcript_required', 'AI triggers need a done transcript');
    ok((await api('POST', `/recordings/${A}/summary`, { as: legacy.alice })).body.reused === true, 'a queued AI job is reused, not duplicated');

    console.log('\nG. GET /status');
    const st = await api('GET', `/recordings/${A}/status`, { as: legacy.alice });
    ok(st.status === 200 && st.body.status === 'uploaded' && st.body.aiStatus === 'queued' && st.body.transcript.status === 'done', 'status projects recording status, ai_status and transcript status');
    ok(st.body.jobs.some((j) => j.queue === 'transcribe' && j.status === 'completed') && st.body.jobs.some((j) => j.queue === 'ai_title' && j.status === 'queued') && st.body.assets.some((a) => a.kind === 'source' && a.status === 'ready'), 'jobs and assets are listed (no storage keys, no payloads)');
    ok(st.body.jobs.every((j) => j.payload === undefined) && JSON.stringify(st.body).indexOf('sources/') === -1, 'nothing internal leaks');

    console.log('\nH. Auto-processing chain after a v1 upload (rows only)');
    let storageUp = false;
    try { storageUp = (await fetch(`${MINIO}/minio/health/live`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
    if (!storageUp) {
      console.log(`  SKIPPED H — no object storage at ${MINIO}`);
      if (REQUIRED) { fail += 1; console.log('  FAIL: AI_API_TESTS_REQUIRED=1 but MinIO is unavailable'); }
    } else {
      const storagePkg = require(path.join(ROOT, 'storage', 'src', 'index.js'));
      const provider = storagePkg.createStorageProvider({ appEnv: 'test' });
      let autoOn = true, canT = true, canDocs = false;
      const upApp = express();
      upApp.use(express.json());
      upApp.use('/api/v1', createUploadRouter({
        repositories, withTransaction, storage: provider, keys: storagePkg.keys, requireAuth, logger: silent,
        autoProcess: { enabled: () => autoOn, transcriptionEnabled: async () => canT, aiDocsEnabled: async () => canDocs },
      }));
      const upServer = upApp.listen(0, '127.0.0.1');
      await new Promise((r) => upServer.once('listening', r));
      const ubase = `http://127.0.0.1:${upServer.address().port}/api/v1`;
      const uapi = async (method, p, body, headers = {}) => { const res = await fetch(ubase + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }); let json = null; try { json = await res.json(); } catch {} return { status: res.status, body: json }; };
      const bytes = Buffer.alloc(2048, 7);
      const uploadAndComplete = async (k, clientDuration) => {
        await db.execute(sql`INSERT INTO recordings (id,user_id,title,status,source_kind,privacy) VALUES (${rid(k)}, ${pg('alice')}, 'Screen recording', 'recording', 'extension', 'unlisted')`);
        currentUser = legacy.alice;
        const s = await uapi('POST', '/uploads', { recordingId: rid(k), mimeType: 'video/webm', mode: 'single', sizeBytes: bytes.length }, { 'Idempotency-Key': `k-${k}-${RUN}` });
        if (s.status !== 201) return { status: s.status, body: s.body };
        // The URL is signed over Content-Type + Content-Length (T-305): send exactly those.
        const put = await fetch(s.body.uploadUrl, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'video/webm' } });
        if (!put.ok) return { status: put.status, put: true };
        return uapi('POST', `/uploads/${s.body.uploadSessionId}/complete`, { parts: [], clientDuration });
      };
      const c1 = await uploadAndComplete('up1', 12);
      ok(c1.status === 200 && c1.body && c1.body.status === 'uploaded', `a single-PUT upload completes (got ${c1.status} ${JSON.stringify(c1.body || c1)})`);
      const auto1 = await job(`stt:${rid('up1')}`);
      ok(auto1 && auto1.status === 'queued' && auto1.payload.trigger === 'auto' && auto1.payload.aiDocs === false && auto1.payload.language === '', 'completion enqueues the auto transcribe job (trigger auto, no AI docs for this user)');
      ok((await repos.transcripts.getForPublicWatch(rid('up1'))).status === 'queued' && (await rec(rid('up1'))).aiStatus === 'queued' && (await job(`probe:${rid('up1')}`)), 'transcript + ai_status queued alongside the probe row — all in the completion transaction');
      canDocs = true;
      const c2 = await uploadAndComplete('up2', 2);
      ok(c2.status === 200 && !(await job(`stt:${rid('up2')}`)) && (await rec(rid('up2'))).aiStatus === 'none', 'a clip under 3 s is not auto-transcribed');
      canT = false;
      const c3 = await uploadAndComplete('up3', 30);
      ok(c3.status === 200 && !(await job(`stt:${rid('up3')}`)), 'without the transcription entitlement nothing is enqueued');
      canT = true; autoOn = false;
      const c4 = await uploadAndComplete('up4', 30);
      ok(c4.status === 200 && !(await job(`stt:${rid('up4')}`)) && (await job(`probe:${rid('up4')}`)), 'AUTO_PROCESS off → probe only');
      autoOn = true;
      const c5 = await uploadAndComplete('up5', 30);
      ok(c5.status === 200 && (await job(`stt:${rid('up5')}`)).payload.aiDocs === true, 'with AI docs the chain payload asks for summary + chapters');
      upServer.close();
      for (const k of ['up1', 'up2', 'up3', 'up4', 'up5']) await provider.deleteObject(`sources/${rid(k)}/source.webm`).catch(() => {});
      const listed = await provider.listObjects(`sources/rec_t603api_`).catch(() => ({ objects: [] }));
      for (const o of listed.objects) await provider.deleteObject(o.key).catch(() => {});
    }
  } finally {
    server.close();
    for (const u of ['alice', 'bob']) await db.execute(sql`delete from users where id = ${pg(u)}`).catch(() => {});
    await pool.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
