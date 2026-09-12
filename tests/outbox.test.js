// T-601 transactional outbox + reconciler + stalled-job tests (run: cd worker && npm run test:outbox)
//
// Real PostgreSQL (processing_jobs) + real Redis (BullMQ): the whole point of
// the outbox is what survives a crash BETWEEN the commit and the enqueue, and
// what survives Redis losing a job — neither can be shown with mocks. The
// stalled-job case kills a REAL child worker process mid-job.
//
// SKIPS LOUDLY without infrastructure; OUTBOX_TESTS_REQUIRED=1 makes that a failure.
'use strict';

const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const W = require(path.join(ROOT, 'worker', 'src', 'index.js'));
const IORedis = require(path.join(ROOT, 'worker', 'node_modules', 'ioredis'));
const { loadEnv, createPool, createClient, createRepositories } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.OUTBOX_TESTS_REQUIRED === '1';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6380';
const RUN = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silent = W.silentLogger();
const REASON = 'T-601 outbox test';

(async () => {
  console.log('T-601 outbox relay / reconciler / stalled-job tests');

  let env = null, pgUp = false, redisUp = false;
  try { env = loadEnv({ appEnv: 'test' }); } catch (e) { console.log('  env:', e.message); }
  let pool = null;
  if (env) { pool = createPool({ env, max: 8 }); try { await pool.query('select 1'); pgUp = true; } catch {} }
  try { const c = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 1500, lazyConnect: true }); await c.connect(); redisUp = (await c.ping()) === 'PONG'; await c.quit(); } catch {}
  if (!pgUp || !redisUp) {
    console.log(`\n  SKIPPED — ${!pgUp ? 'PostgreSQL unreachable' : ''}${!pgUp && !redisUp ? ' and ' : ''}${!redisUp ? `no Redis at ${REDIS_URL}` : ''}`);
    if (REQUIRED) { fail += 1; console.log('  FAIL: OUTBOX_TESTS_REQUIRED=1 but infrastructure is unavailable'); }
    if (pool) await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; return;
  }

  const db = createClient(pool);
  await db.execute(sql`delete from processing_jobs where dedupe_key like ${'t601:%'}`);
  const repositories = () => createRepositories(db);
  const repos = repositories();
  const prefix = `t601o${RUN}`;
  const mkQueue = (o = {}) => W.createBullJobQueue({ redisUrl: REDIS_URL, prefix, logger: silent, stalledIntervalMs: 500, lockDurationMs: 1000, backoff: () => 20, ...o });
  const config = W.loadWorkerConfig({ REDIS_URL, QUEUE_PREFIX: prefix, OUTBOX_INTERVAL_MS: '100', RECONCILE_INTERVAL_MS: '600000', RECONCILE_MIN_AGE_MS: '1000', WORKER_STALLED_INTERVAL_MS: '500', WORKER_LOCK_DURATION_MS: '1000', WORKER_SHUTDOWN_TIMEOUT_MS: '5000', WORKER_DEFER_MS: '150' }, { appEnv: 'test' });
  const rowOf = async (id) => repos.jobs.getSystem(id, REASON);
  const insert = (type, key, extra = {}) => repos.jobs.enqueue({ queue: type, dedupeKey: `t601:${key}:${RUN}`, payload: { storageKey: `sources/${key}` }, ...extra }).then((r) => r.job);
  const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(50); } return false; };

  const q = mkQueue();
  try {
    // ── A. Crash window 1: committed row, never enqueued ────────────────────
    console.log('\nA. Crash after commit, before enqueue');
    const relay = W.createOutboxRelay({ repositories, jobQueue: q, logger: silent, minAgeMs: 0 });
    const a = await insert('probe', 'a');
    ok(a.status === 'queued' && a.enqueuedAt === null, 'the API-style write leaves status=queued, enqueued_at NULL (the outbox row)');
    const r1 = await relay.relayOnce();
    const a1 = await rowOf(a.id);
    ok(r1.relayed === 1 && a1.enqueuedAt instanceof Date && (await q.has(a.id, 'probe')), 'the relay hands the row to the transport and stamps enqueued_at');
    const r2 = await relay.relayOnce();
    ok(r2.scanned === 0 && r2.relayed === 0, 'a stamped row is never relayed again');
    const p1 = relay.relayOnce(), p2 = relay.relayOnce();
    ok(p1 === p2, 'overlapping passes share one in-flight promise (single-flight)');
    await p1;

    // ── B. Crash window 2: enqueued, but crashed before the stamp ───────────
    console.log('\nB. Crash after enqueue, before the stamp');
    const b = await insert('probe', 'b');
    await q.enqueue({ id: b.id, type: 'probe', payload: b.payload, attempts: b.maxAttempts });   // the relay died right here
    const r3 = await relay.relayOnce();
    ok(r3.relayed === 1 && (await rowOf(b.id)).enqueuedAt, 'the next pass enqueues again and stamps');
    const runs = [];
    const reg = W.createRegistry();
    reg.register('probe', async ({ payload, job }) => { runs.push(job.id); return { probed: payload.storageKey }; });
    const app = W.createWorkerApp({ config, logger: silent, repositories, jobQueue: mkQueue(), registry: reg });
    await app.start();
    ok(await until(async () => (await rowOf(b.id)).status === 'completed'), 'the doubly-enqueued job completes');
    await sleep(300);
    ok(runs.filter((id) => id === b.id).length === 1, 'and it ran EXACTLY once — the transport deduped on the row id');

    // ── C. Lifecycle observable ─────────────────────────────────────────────
    console.log('\nC. enqueue → process → row lifecycle, observable');
    const lines = [];
    const cap = { info: (o, m) => lines.push({ o, m }), warn: (o, m) => lines.push({ o, m }), error: (o, m) => lines.push({ o, m }), debug() {}, child(b0) { const c = { ...cap }; c.info = (o, m) => lines.push({ o: { ...b0, ...o }, m }); c.warn = c.info; c.error = c.info; c.child = (b1) => cap.child({ ...b0, ...b1 }); return c; } };
    const relayC = W.createOutboxRelay({ repositories, jobQueue: q, logger: cap, minAgeMs: 0 });
    const c = await insert('probe', 'c', { recordingId: null });
    const c0 = await rowOf(c.id);
    ok(c0.status === 'queued' && !c0.enqueuedAt && c0.attempts === 0, '1. queued, unstamped');
    await relayC.relayOnce();
    const c1 = await rowOf(c.id);
    ok(!!c1.enqueuedAt && ['queued', 'active', 'completed'].includes(c1.status), '2. stamped (handed to the transport; a live consumer may already have it)');
    ok(await until(async () => (await rowOf(c.id)).status === 'completed'), '3./4. active → completed');
    const c2 = await rowOf(c.id);
    ok(c2.attempts === 1 && c2.startedAt && c2.finishedAt && c2.finishedAt >= c2.startedAt && c2.result.probed === 'sources/c' && c2.lastError === null, 'the row carries attempts, started_at ≤ finished_at, the result');
    ok(lines.some((l) => l.m === 'job relayed to transport' && l.o.job_id === c.id && l.o.queue === 'probe'), 'the relay logs job_id + queue as structured fields (docs/19 §1)');
    const listed = await repos.jobs.listSystem({ status: 'completed', queue: 'probe', limit: 10 }, REASON);
    ok(listed.some((r) => r.id === c.id), 'listSystem (admin listing) sees it as completed');

    // ── D. Retry through the transport ──────────────────────────────────────
    console.log('\nD. Transient failure → transport retry → completed');
    let dFails = 1;
    reg.register('transcode', async () => { if (dFails-- > 0) throw new W.TransientError('ffmpeg_exit', 'exit 1'); return 'ok'; });
    const app2 = W.createWorkerApp({ config, logger: silent, repositories, jobQueue: mkQueue(), registry: (() => { const r = W.createRegistry(); r.register('transcode', reg.get('transcode').handler); return r; })() });
    await app2.start();
    const d = await insert('transcode', 'd');
    await relay.relayOnce();
    ok(await until(async () => (await rowOf(d.id)).status === 'completed'), 'the job completes on its second run');
    const d1 = await rowOf(d.id);
    ok(d1.attempts === 2 && d1.lastError === null && d1.result === 'ok', 'attempts=2, last_error cleared by the success');

    // ── E. Terminal failure ─────────────────────────────────────────────────
    console.log('\nE. Terminal failure → failed, not retried, removed from transport');
    let eRuns = 0;
    const reg3 = W.createRegistry();
    reg3.register('thumbnail', async () => { eRuns += 1; throw new W.TerminalError('corrupt_input', 'bad frame'); });
    const app3 = W.createWorkerApp({ config, logger: silent, repositories, jobQueue: mkQueue(), registry: reg3 });
    await app3.start();
    const e = await insert('thumbnail', 'e');
    await relay.relayOnce();
    ok(await until(async () => (await rowOf(e.id)).status === 'failed'), 'status failed');
    await sleep(400);
    const e1 = await rowOf(e.id);
    ok(eRuns === 1 && e1.attempts === 1 && e1.lastError === 'corrupt_input: bad frame' && e1.finishedAt && !(await q.has(e.id, 'thumbnail')), 'one run, last_error = code: message, gone from Redis');
    const dead = await repos.jobs.listSystem({ status: 'failed' }, REASON);
    ok(dead.some((r) => r.id === e.id), 'it appears in the dead-letter listing');

    // ── F. Admin retry flows through the relay ──────────────────────────────
    console.log('\nF. Admin retry → relay → runs again');
    let retryOk = false;
    const reg4 = W.createRegistry();
    reg4.register('thumbnail', async () => { if (!retryOk) throw new W.TerminalError('corrupt_input', 'bad frame'); return 'fixed'; });
    await app3.stop();
    const app4 = W.createWorkerApp({ config, logger: silent, repositories, jobQueue: mkQueue(), registry: reg4 });
    await app4.start();
    retryOk = true;
    const re = await repos.jobs.requeueSystem(e.id, REASON, { resetAttempts: true, fromStatuses: ['failed'] });
    ok(re && re.status === 'queued' && re.attempts === 0 && re.enqueuedAt === null && re.startedAt === null && re.finishedAt === null && re.lastError === 'corrupt_input: bad frame', 'retry resets the row to an unstamped queued row (attempts 0), keeping last_error for the audit trail');
    ok((await repos.jobs.requeueSystem(e.id, REASON, { fromStatuses: ['failed'] })) === null, 'a second retry is a no-op (guarded by fromStatuses)');
    await relay.relayOnce();
    ok(await until(async () => (await rowOf(e.id)).status === 'completed'), 'the relay picks the retried row up and it completes');
    ok((await rowOf(e.id)).attempts === 1 && (await rowOf(e.id)).result === 'fixed', 'attempts count restarted at 1');

    // ── G. Redis wiped: reconciler re-enqueues from PostgreSQL ──────────────
    console.log('\nG. Redis loss → reconcile from processing_jobs (docs/10 §1)');
    await app.stop(); await app2.stop(); await app4.stop();
    const g = await insert('probe', 'g');
    await relay.relayOnce();
    ok(await q.has(g.id, 'probe'), 'the job is in the transport (no consumer yet)');
    await q.obliterate();                                   // "Redis is wiped"
    ok(!(await q.has(g.id, 'probe')) && (await rowOf(g.id)).status === 'queued' && (await rowOf(g.id)).enqueuedAt, 'the transport lost it; the row still says queued+stamped');
    const rg0 = await W.createOutboxRelay({ repositories, jobQueue: q, logger: silent, minAgeMs: 60000 }).reconcileOnce();
    ok(rg0.staleQueued === 0 && rg0.requeued === 0, 'a freshly stamped row is not touched before min age (an in-flight relay could be stamping it)');
    const rg = await relay.reconcileOnce();
    ok(rg.staleQueued >= 1 && rg.requeued >= 1 && (await q.has(g.id, 'probe')), 'past min age, a queued row unknown to the transport is re-enqueued');
    const rg2 = await relay.reconcileOnce();
    ok(rg2.requeued === 0, 'a row the transport holds is left alone');
    const app5 = W.createWorkerApp({ config, logger: silent, repositories, jobQueue: mkQueue(), registry: (() => { const r = W.createRegistry(); r.register('probe', async () => 'after-wipe'); return r; })() });
    await app5.start();
    ok(await until(async () => (await rowOf(g.id)).status === 'completed'), 'and it completes once a consumer is back');
    await app5.stop();

    // ── H. Active row whose worker vanished (transport lost it) ─────────────
    console.log('\nH. Stale active row → recovered to queued');
    const h = await insert('probe', 'h');
    await db.execute(sql`update processing_jobs set status = 'active', enqueued_at = now() - interval '3 hours', started_at = now() - interval '3 hours', attempts = 1 where id = ${h.id}`);
    const rh = await relay.reconcileOnce();
    const h1 = await rowOf(h.id);
    ok(rh.staleActive >= 1 && rh.recovered === 1 && h1.status === 'queued' && h1.enqueuedAt === null && h1.startedAt === null && h1.attempts === 1, 'an active row older than 2× its timeout and unknown to the transport goes back to queued (attempts kept) for the relay');
    const hy = await insert('probe', 'hy');
    await db.execute(sql`update processing_jobs set status = 'active', enqueued_at = now() - interval '2 minutes', started_at = now() - interval '2 minutes' where id = ${hy.id}`);
    const rh2 = await relay.reconcileOnce();
    ok((await rowOf(hy.id)).status === 'active' && rh2.recovered === 0, 'an active row younger than 2× its timeout is left running');
    const hz = await insert('email', 'hz');
    await db.execute(sql`update processing_jobs set status = 'active', enqueued_at = now() - interval '3 hours', started_at = now() - interval '3 hours' where id = ${hz.id}`);
    await q.enqueue({ id: hz.id, type: 'email', payload: {} });   // still held by the transport (waiting, no consumer)
    const rh3 = await relay.reconcileOnce();
    ok((await rowOf(hz.id)).status === 'active' && rh3.recovered === 0, 'an old active row the transport still holds is not touched');
    await db.execute(sql`update processing_jobs set status = 'cancelled' where id in (${hy.id}, ${hz.id}, ${h.id})`);

    // ── I. Stalled job: kill a real worker mid-job → re-queued → completes ───
    console.log('\nI. Worker killed mid-job → BullMQ stalled requeue → completes elsewhere');
    const i = await insert('probe', 'i');
    await relay.relayOnce();
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'hang-worker.js')], {
      env: { ...process.env, APP_ENV: 'test', DATABASE_URL_TEST: env.databaseUrl, REDIS_URL, QUEUE_PREFIX: prefix, WORKER_STALLED_INTERVAL_MS: '500', WORKER_LOCK_DURATION_MS: '1000', LOG_LEVEL: 'silent' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    const started = await until(async () => out.includes(`STARTED ${i.id}`), 15000);
    ok(started, `the child worker took the job (${out.split('\n').filter(Boolean).slice(-2).join(' | ')})`);
    const iActive = await rowOf(i.id);
    ok(iActive.status === 'active' && iActive.attempts === 1, 'the row is active with attempts=1 while the child holds it');
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    const reg6 = W.createRegistry();
    let sixth = null;
    reg6.register('probe', async ({ job }) => { sixth = job.attempts; return 'recovered'; });
    const app6 = W.createWorkerApp({ config, logger: silent, repositories, jobQueue: mkQueue(), registry: reg6 });
    await app6.start();
    const done = await until(async () => (await rowOf(i.id)).status === 'completed', 15000);
    const i1 = await rowOf(i.id);
    ok(done, 'BullMQ detects the stalled lock and re-queues; the surviving worker completes the job');
    ok(i1 && i1.attempts === 2 && sixth === 2 && i1.result === 'recovered' && i1.lastError === null, 'the row shows both runs (attempts=2) and the result of the second');
    await app6.stop();

    // ── J. Empty default registry still relays (the T-601 deployable) ───────
    console.log('\nJ. Default worker: no processors, relay only');
    const app7 = W.createWorkerApp({ config, logger: silent, repositories, jobQueue: mkQueue(), registry: W.createDefaultRegistry() });
    await app7.start();
    const j = await insert('probe', 'j');
    ok(await until(async () => !!(await rowOf(j.id)).enqueuedAt, 3000) && (await q.has(j.id, 'probe')), 'a default worker relays outbox rows into the transport where they wait for a consumer (media has no processor yet)');
    ok(app7.status().queues.sort().join() === 'ai,maintenance,stt' && (await rowOf(j.id)).status !== 'completed', 'the default worker consumes maintenance/stt/ai (T-602/T-603) and never the media queue');
    await app7.stop();
  } finally {
    await q.obliterate().catch(() => {});
    await q.close().catch(() => {});
    await db.execute(sql`delete from processing_jobs where dedupe_key like ${'t601:%'}`).catch(() => {});
    await pool.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
