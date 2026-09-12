// T-706 legacy re-processing backfill (run: cd api && npm run test:backfill-pipeline)
//
// Real PostgreSQL. The pipeline gap query and stats, the throttled dry-run /
// apply queue-fill (new rows, in-flight detection, requeue of settled probe
// rows, include-failed), the admin progress endpoint + backfill trigger, and
// the CLI. No media is processed here — the worker fleet does that.
//
// SKIPS LOUDLY without PostgreSQL; BACKFILL_TESTS_REQUIRED=1 makes that a failure.
'use strict';

const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const API_DIR = path.join(ROOT, 'api');
const express = require(path.join(API_DIR, 'node_modules', 'express'));
const { loadEnv, createPool, createClient, createRepositories, withTransaction: rawTx } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));
const { pipelineStats, queueFill } = require(path.join(DB_DIR, 'src', 'maintenance', 'pipeline-backfill.js'));
const { createAdminJobsRouter } = require(path.join(API_DIR, 'src', 'index.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.BACKFILL_TESTS_REQUIRED === '1';
const RUN = crypto.randomBytes(3).toString('hex');
const REASON = 'T-706 backfill test';
const silent = { info() {}, warn() {}, error() {}, debug() {} };

(async () => {
  console.log('T-706 pipeline backfill tests');
  let env = null, pgUp = false, pool = null;
  try { env = loadEnv({ appEnv: 'test' }); } catch (e) { console.log('  env:', e.message); }
  if (env) { pool = createPool({ env, max: 6 }); try { await pool.query('select 1'); pgUp = true; } catch {} }
  if (!pgUp) {
    console.log('\n  SKIPPED — PostgreSQL unreachable');
    if (REQUIRED) { fail += 1; console.log('  FAIL: BACKFILL_TESTS_REQUIRED=1 but PostgreSQL is unavailable'); }
    if (pool) await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; return;
  }
  const db = createClient(pool);
  // A clean slate: stats count the whole table.
  await db.execute(sql`truncate table video_assets, upload_parts, upload_sessions, processing_jobs, transcripts, recordings, folders, usage, users restart identity cascade`);
  const repositories = () => createRepositories(db);
  const repos = repositories();
  const withTransaction = (fn) => rawTx(fn, db);
  const U = `usr_t706_${RUN}`;
  await db.execute(sql`INSERT INTO users (id,email,name,password_hash) VALUES (${U}, ${`t706-${RUN}@example.com`}, 'T706', 'x')`);
  const rid = (k) => `rec_t706_${k}_${RUN}`;
  const mk = async (k, { status = 'processing', failureCode = null, deleted = false, source = true, mp4 = false, poster = false } = {}) => {
    await db.execute(sql`INSERT INTO recordings (id,user_id,title,status,failure_code,source_kind,privacy,deleted_at,created_at) VALUES (${rid(k)}, ${U}, ${k}, ${status}, ${failureCode}, 'extension', 'unlisted', ${deleted ? new Date() : null}, ${new Date(Date.now() - 100000 + Object.keys(mk.seen).length * 1000)})`);
    mk.seen[k] = 1;
    const asset = (kind, variant, key) => db.execute(sql`INSERT INTO video_assets (id,recording_id,kind,variant,storage_key,status,counts_toward_quota) VALUES (${`ast_${k}_${kind}_${RUN}`}, ${rid(k)}, ${kind}, ${variant}, ${key}, 'ready', ${kind === 'source'})`);
    if (source) await asset('source', null, `sources/${rid(k)}/source.webm`);
    if (mp4) await asset('mp4', 'main', `derived/${rid(k)}/mp4/video.mp4`);
    if (poster) await asset('poster', null, `derived/${rid(k)}/poster/poster.jpg`);
    return rid(k);
  };
  mk.seen = {};
  const job = (key) => repos.jobs.findByDedupeKey(key);

  try {
    console.log('\nA. Stats and the gap query');
    const c1 = await mk('c1', { status: 'ready', mp4: true, poster: true });
    const p1 = await mk('p1');
    const p2 = await mk('p2', { status: 'uploaded', mp4: true });
    const p3 = await mk('p3', { status: 'ready', poster: true });
    const f1 = await mk('f1', { status: 'failed', failureCode: 'probe_invalid' });
    const r1 = await mk('r1', { status: 'rejected_limit', failureCode: 'recording_limit' });
    await mk('d1', { deleted: true });
    await mk('n1', { status: 'uploaded', source: false });
    const inflight = await mk('in', {});
    await repos.jobs.enqueue({ queue: 'probe', dedupeKey: `probe:${inflight}`, recordingId: inflight, payload: {} });
    const s = await pipelineStats({ repositories });
    // Active = not deleted: c1 p1 p2 p3 f1 r1 n1 in (8); with source = all but n1 (7);
    // pending = source without MP4+poster in uploaded/processing/ready: p1 p2 p3 in (4).
    ok(s.totalActive === 8 && s.withSource === 7 && s.complete === 1 && s.pending === 4 && s.failed === 1 && s.rejected === 1 && s.probeInFlight === 1, `stats: ${JSON.stringify(s)}`);
    ok(s.completePercent === Math.round((1 / 7) * 1000) / 10, 'completion percent = complete / with-source');
    const gaps = await repos.recordings.listPipelineGapsSystem({ limit: 50 }, REASON);
    ok(gaps.map((g) => g.id).sort().join() === [p1, p2, p3].sort().join(), 'gaps = recordings with a source but no MP4 + poster, excluding failed/rejected/deleted/no-source/in-flight');
    ok((await repos.recordings.listPipelineGapsSystem({ limit: 2 }, REASON)).length === 2, 'limit throttles the batch');
    const withFailed = await repos.recordings.listPipelineGapsSystem({ limit: 50, includeFailed: true }, REASON);
    ok(withFailed.some((g) => g.id === f1) && !withFailed.some((g) => g.id === r1) && withFailed.length === 4, 'includeFailed adds failed(probe_invalid/transcode_failed) recordings, never rejected ones');

    console.log('\nB. Queue-fill: dry run, apply, in-flight, requeue');
    const dry = await queueFill({ repositories, withTransaction, limit: 10, logger: silent });
    ok(dry.dryRun === true && dry.scanned === 3 && dry.enqueued === 0 && dry.recordingIds.length === 3 && !(await job(`probe:${p1}`)), 'the default is a dry run: nothing written');
    const applied = await queueFill({ repositories, withTransaction, limit: 10, apply: true, logger: silent });
    const jp1 = await job(`probe:${p1}`);
    ok(applied.enqueued === 3 && applied.requeued === 0 && jp1 && jp1.status === 'queued' && jp1.payload.trigger === 'backfill' && jp1.maxAttempts === 5 && jp1.enqueuedAt === null, 'apply queues a probe row per gap (trigger backfill, 5 attempts, unstamped for the relay)');
    const again = await queueFill({ repositories, withTransaction, limit: 10, apply: true, logger: silent });
    ok(again.scanned === 0 && again.enqueued === 0, 'a second run finds nothing: in-flight recordings are not gaps');
    const s2 = await pipelineStats({ repositories });
    ok(s2.probeInFlight === 4 && s2.pending === 4, 'stats show the queued probes (pending recordings stay pending until their assets land)');
    // A settled (completed) probe whose recording still lacks MP4 + poster is requeued.
    await repos.jobs.markActiveSystem(jp1.id, REASON); await repos.jobs.markCompletedSystem(jp1.id, {}, REASON);
    const third = await queueFill({ repositories, withTransaction, limit: 10, apply: true, logger: silent });
    ok(third.scanned === 1 && third.requeued === 1 && (await job(`probe:${p1}`)).status === 'queued' && (await job(`probe:${p1}`)).attempts === 0, 'a settled probe row is requeued with attempts reset');
    const limited = await queueFill({ repositories, withTransaction, limit: 1, apply: true, includeFailed: true, logger: silent });
    ok(limited.scanned === 1 && limited.enqueued === 1 && (await job(`probe:${f1}`)), 'includeFailed retries a failed recording; the limit caps the run');
    const bad = await queueFill({ repositories, withTransaction: async () => { throw new Error('db down'); }, limit: 10, apply: true, includeFailed: true, logger: silent });
    ok(bad.errors === 0 && bad.scanned === 0, 'nothing left → nothing attempted (no errors)');

    console.log('\nC. Admin progress endpoint + backfill trigger');
    const app = express();
    app.use(express.json());
    const requireAuth = (req, res, next) => { const u = req.get('x-user'); if (!u) return res.status(401).json({ error: { code: 'unauthorized' } }); req.userId = u; next(); };
    app.use('/api/v1', createAdminJobsRouter({ repositories, withTransaction, requireAuth, isAdmin: (req) => req.userId === 'admin1', logger: silent }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const api = async (method, p, { as, body } = {}) => { const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(as ? { 'x-user': as } : {}) }, body: body ? JSON.stringify(body) : undefined }); let json = null; try { json = await res.json(); } catch {} return { status: res.status, body: json }; };
    try {
      ok((await api('GET', '/admin/pipeline', { as: 'user9' })).status === 403 && (await api('GET', '/admin/pipeline')).status === 401, 'admin-only');
      const st = await api('GET', '/admin/pipeline', { as: 'admin1' });
      ok(st.status === 200 && st.body.totalActive === 8 && st.body.complete === 1 && typeof st.body.completePercent === 'number' && st.body.probeInFlight >= 4, 'GET /admin/pipeline returns the progress numbers');
      ok((await api('POST', '/admin/pipeline/backfill', { as: 'admin1', body: { limit: 0 } })).body.error.code === 'invalid_request', 'limit must be a positive integer');
      const dryApi = await api('POST', '/admin/pipeline/backfill', { as: 'admin1', body: { limit: 5 } });
      ok(dryApi.status === 200 && dryApi.body.dryRun === true, 'the endpoint dry-runs unless apply:true');
      const p4 = await mk('p4');
      const applyApi = await api('POST', '/admin/pipeline/backfill', { as: 'admin1', body: { limit: 5, apply: true } });
      ok(applyApi.status === 202 && applyApi.body.dryRun === false && applyApi.body.enqueued === 1 && (await job(`probe:${p4}`)), 'apply:true queues the probe rows and answers 202');
    } finally { server.close(); }

    console.log('\nD. CLI');
    const cli = require(path.join(DB_DIR, 'src', 'cli', 'pipeline-backfill.js'));
    const logs = [];
    const origLog = console.log; console.log = (...a) => logs.push(a.join(' '));
    let code;
    try { code = await cli.main(['stats', '--env', 'test']); } finally { console.log = origLog; }
    ok(code === 0 && logs.some((l) => /"command": "stats"/.test(l) && /"totalActive"/.test(l)), 'the CLI prints stats (exit 0)');
    ok((await cli.main(['nope'])) === 1, 'an unknown command is refused');
  } finally {
    await db.execute(sql`delete from users where id = ${U}`);
    await pool.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
