// T-601 /api/v1/admin/jobs tests (run: cd api && npm run test:admin-jobs)
//
// Real PostgreSQL. The router is mounted in-process behind a fake auth (any
// `x-user` header is the caller; `admin1` is the admin), then once more on the
// SPAWNED legacy server behind the real JWT + ADMIN_EMAILS allowlist to prove
// the V1_UPLOAD_API flag mounts it. The retried row is then handed to a relay
// (inline JobQueue, no Redis) to show the API-side retry reaches the worker.
//
// SKIPS LOUDLY without PostgreSQL; ADMIN_JOBS_TESTS_REQUIRED=1 makes that a failure.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const API_DIR = path.join(ROOT, 'api');
const SERVER_DIR = path.join(ROOT, 'server');
const express = require(path.join(API_DIR, 'node_modules', 'express'));
const { loadEnv, createPool, createClient, createRepositories } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));
const { createAdminJobsRouter } = require(path.join(API_DIR, 'src', 'index.js'));
const W = require(path.join(ROOT, 'worker', 'src', 'index.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.ADMIN_JOBS_TESTS_REQUIRED === '1';
const RUN = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REASON = 'T-601 admin jobs test';
const silent = W.silentLogger();

(async () => {
  console.log('T-601 /api/v1/admin/jobs tests');
  let env = null, pgUp = false, pool = null;
  try { env = loadEnv({ appEnv: 'test' }); } catch (e) { console.log('  env:', e.message); }
  if (env) { pool = createPool({ env, max: 6 }); try { await pool.query('select 1'); pgUp = true; } catch {} }
  if (!pgUp) {
    console.log('\n  SKIPPED — PostgreSQL unreachable');
    if (REQUIRED) { fail += 1; console.log('  FAIL: ADMIN_JOBS_TESTS_REQUIRED=1 but PostgreSQL is unavailable'); }
    if (pool) await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; return;
  }
  const db = createClient(pool);
  await db.execute(sql`delete from processing_jobs where dedupe_key like ${'t601a:%'}`);
  const repositories = () => createRepositories(db);
  const repos = repositories();
  const insert = (type, key, extra = {}) => repos.jobs.enqueue({ queue: type, dedupeKey: `t601a:${key}:${RUN}`, payload: { storageKey: `sources/${key}` }, ...extra }).then((r) => r.job);

  // ── In-process mount with a fake auth ─────────────────────────────────────
  const app = express();
  const requireAuth = (req, res, next) => {
    const u = req.get('x-user');
    if (!u) return res.status(401).json({ error: { code: 'unauthorized', message: 'Authentication required' } });
    req.userId = u; return next();
  };
  const logged = [];
  app.use('/api/v1', createAdminJobsRouter({ repositories, requireAuth, isAdmin: (req) => req.userId === 'admin1', logger: { ...silent, info: (o, m) => logged.push({ o, m }), error() {}, warn() {} } }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const api = async (method, p, { as, body } = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(as ? { 'x-user': as } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json, headers: res.headers };
  };

  try {
    console.log('\nA. Authorization');
    ok((await api('GET', '/admin/jobs')).status === 401, 'unauthenticated → 401');
    const nonAdmin = await api('GET', '/admin/jobs', { as: 'user9' });
    ok(nonAdmin.status === 403 && nonAdmin.body.error.code === 'admin_only' && 'requestId' in nonAdmin.body.error, 'a non-admin → 403 admin_only in the nested docs/08 §2 shape');
    ok((await api('POST', '/admin/jobs/job_x/retry', { as: 'user9' })).status === 403, 'retry is admin-only too');
    let threw = null; try { createAdminJobsRouter({ repositories, requireAuth }); } catch (e) { threw = e; }
    ok(threw && /isAdmin/.test(threw.message), 'the router refuses to mount without an admin predicate');

    console.log('\nB. Listing');
    const f1 = await insert('probe', 'f1'); const f2 = await insert('transcode', 'f2'); const qd = await insert('probe', 'q1');
    for (const j of [f1, f2]) { await repos.jobs.markActiveSystem(j.id, REASON); await repos.jobs.markFailedSystem(j.id, 'corrupt_input: bad', REASON, { terminal: true }); }
    const list = await api('GET', '/admin/jobs', { as: 'admin1' });
    ok(list.status === 200 && list.body.status === 'failed' && list.body.jobs.every((j) => j.status === 'failed'), 'default listing is the failed set (the dead-letter queue)');
    const ids = list.body.jobs.map((j) => j.id);
    ok(ids.includes(f1.id) && ids.includes(f2.id) && !ids.includes(qd.id), 'both failed jobs listed, the queued one not');
    const row = list.body.jobs.find((j) => j.id === f1.id);
    ok(row.payload === undefined && row.dedupeKey === f1.dedupeKey && row.attempts === 1 && row.maxAttempts === 3 && row.lastError === 'corrupt_input: bad' && row.finishedAt && row.queue === 'probe', 'the wire shape carries status/attempts/lastError/timestamps and NEVER the payload (storage keys)');
    ok(ids.indexOf(f2.id) < ids.indexOf(f1.id), 'newest first');
    ok(list.headers.get('cache-control') === 'no-store', 'triage data is never cached');
    const byQueue = await api('GET', '/admin/jobs?status=failed&queue=transcode', { as: 'admin1' });
    ok(byQueue.status === 200 && byQueue.body.jobs.some((j) => j.id === f2.id) && !byQueue.body.jobs.some((j) => j.id === f1.id), 'queue= filters by job type');
    const queued = await api('GET', '/admin/jobs?status=queued', { as: 'admin1' });
    ok(queued.status === 200 && queued.body.jobs.some((j) => j.id === qd.id), 'status=queued lists queued rows');
    ok((await api('GET', '/admin/jobs?status=bogus', { as: 'admin1' })).body.error.code === 'invalid_request', 'an unknown status → 400 invalid_request');
    ok((await api('GET', '/admin/jobs?limit=abc', { as: 'admin1' })).status === 400, 'a non-numeric limit → 400');
    ok((await api('GET', '/admin/jobs?limit=1', { as: 'admin1' })).body.jobs.length === 1, 'limit is honoured');
    ok((await api('GET', '/admin/jobs?limit=9999', { as: 'admin1' })).status === 200, 'an oversized limit is capped, not rejected');

    console.log('\nC. Retry');
    ok((await api('POST', '/admin/jobs/job_nope/retry', { as: 'admin1' })).body.error.code === 'job_not_found', 'unknown job → 404 job_not_found');
    const notFailed = await api('POST', `/admin/jobs/${qd.id}/retry`, { as: 'admin1' });
    ok(notFailed.status === 409 && notFailed.body.error.code === 'invalid_state', 'a queued job cannot be retried → 409 invalid_state');
    const re = await api('POST', `/admin/jobs/${f1.id}/retry`, { as: 'admin1' });
    ok(re.status === 200 && re.body.ok === true && re.body.job.status === 'queued' && re.body.job.attempts === 0 && re.body.job.enqueuedAt === null && re.body.job.startedAt === null && re.body.job.finishedAt === null && re.body.job.lastError === 'corrupt_input: bad', 'retry → queued, attempts 0, unstamped; last_error kept for the audit trail');
    const dbRow = await repos.jobs.getSystem(f1.id, REASON);
    ok(dbRow.status === 'queued' && dbRow.enqueuedAt === null && dbRow.attempts === 0, 'the row itself was reset');
    ok(logged.some((l) => /admin retried/.test(l.m) && l.o.job_id === f1.id && l.o.admin_user_id === 'admin1'), 'the retry is logged with job_id and the admin');
    ok((await api('POST', `/admin/jobs/${f1.id}/retry`, { as: 'admin1' })).status === 409, 'a second retry of the now-queued job → 409');
    ok(!(await api('GET', '/admin/jobs', { as: 'admin1' })).body.jobs.some((j) => j.id === f1.id), 'it left the dead-letter listing');

    console.log('\nD. The retried row reaches the worker (inline JobQueue, no Redis)');
    const inline = W.createInlineJobQueue({ logger: silent });
    const ran = [];
    inline.subscribe('media', async (job) => { ran.push(job.id); });
    const relay = W.createOutboxRelay({ repositories, jobQueue: inline, logger: silent });
    const r = await relay.relayOnce();
    await inline.drain();
    ok(r.relayed >= 1 && ran.includes(f1.id) && (await repos.jobs.getSystem(f1.id, REASON)).enqueuedAt, 'the relay hands the retried row to the transport and it runs — the API never touched the queue');
    await inline.close();
    await db.execute(sql`update processing_jobs set status = 'cancelled' where id in (${f1.id}, ${f2.id}, ${qd.id})`);
  } finally {
    server.close();
  }

  // ── E. Mounted on the legacy server behind the flag + real admin allowlist ──
  console.log('\nE. Legacy server mount (V1_UPLOAD_API=true, ADMIN_EMAILS)');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't601-'));
  const PORT = '3272';
  const child = spawn(process.execPath, ['index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env, PORT, NODE_ENV: 'production', JWT_SECRET: 't601', DATA_DIR: dataDir, LOG_PRETTY: 'false', SENTRY_DSN: '',
      // /api/v1 serves MIGRATED accounts only (identity bridge): dual-write ON so
      // the signups below get their PostgreSQL mirror rows, as in production.
      V1_UPLOAD_API: 'true', PG_DUAL_WRITE: 'true', APP_ENV: 'test', DATABASE_URL_TEST: env.databaseUrl, ADMIN_EMAILS: `admin-${RUN}@example.com`,
      STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100', STORAGE_BUCKET: 'veorec-media-test', STORAGE_PROVIDER: 'minio',
      STORAGE_ACCESS_KEY_ID: 'veorec_dev', STORAGE_SECRET_ACCESS_KEY: 'veorec_local_dev_secret', STORAGE_REGION: 'auto', STORAGE_FORCE_PATH_STYLE: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) { try { ready = (await fetch(`http://127.0.0.1:${PORT}/api/plans`)).ok; } catch {} if (!ready) await sleep(250); }
    ok(ready, 'the legacy server boots with V1_UPLOAD_API=true');
    const signup = async (email) => (await (await fetch(`http://127.0.0.1:${PORT}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'T', email, password: 'secret123' }) })).json()).token;
    const adminTok = await signup(`admin-${RUN}@example.com`);
    const userTok = await signup(`user-${RUN}@example.com`);
    const call = (tok, p, method = 'GET') => fetch(`http://127.0.0.1:${PORT}/api/v1${p}`, { method, headers: tok ? { authorization: `Bearer ${tok}` } : {} });
    // The dual-write mirror lands asynchronously; the bridge answers 503
    // account_not_migrated until it has. Wait for both accounts to be mirrored.
    let mirrored = false;
    for (let i = 0; i < 40 && !mirrored; i += 1) {
      mirrored = (await call(adminTok, '/me/usage')).status === 200 && (await call(userTok, '/me/usage')).status === 200;
      if (!mirrored) await sleep(250);
    }
    ok(mirrored, 'both signups reached PostgreSQL (dual-write) — the v1 identity bridge admits them');
    ok((await call(null, '/admin/jobs')).status === 401, 'mounted route: unauthenticated → 401');
    const nonAdmin = await call(userTok, '/admin/jobs');
    ok(nonAdmin.status === 403 && (await nonAdmin.json()).error.code === 'admin_only', 'mounted route: a signed-in non-admin → 403 admin_only (ADMIN_EMAILS allowlist)');
    const adminRes = await call(adminTok, '/admin/jobs?status=failed');
    const adminBody = await adminRes.json();
    ok(adminRes.status === 200 && Array.isArray(adminBody.jobs), 'mounted route: the allowlisted admin lists jobs from PostgreSQL');
    ok((await call(adminTok, '/admin/jobs/job_nope/retry', 'POST')).status === 404, 'mounted route: retry of an unknown job → 404');
    ok((await call(adminTok, '/admin/metrics'.replace('/admin/metrics', '/me/usage'))).status === 200, 'the other v1 routers on the same flag are unaffected');
  } finally {
    child.kill();
    await sleep(300);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  await db.execute(sql`delete from processing_jobs where dedupe_key like ${'t601a:%'}`).catch(() => {});
  await pool.end().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
