// T-602 maintenance jobs as repeatables (run: cd worker && npm run test:maintenance)
//
// A. cleanup on fixtures — real PostgreSQL + real MinIO objects — run TWICE
//    (idempotent); B. storage verification + the plan resolver; C. the shipped
//    registry; D. the scheduler: buckets, dedupe, BullMQ schedulers, and the
//    end-to-end tick → row → relay → run → completed lifecycle visible in the
//    admin listing; E. the legacy scheduler no longer wires any v1 job.
//
// SKIPS LOUDLY without infrastructure; MAINT_TESTS_REQUIRED=1 makes that a failure.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const W = require(path.join(ROOT, 'worker', 'src', 'index.js'));
const IORedis = require(path.join(ROOT, 'worker', 'node_modules', 'ioredis'));
const { loadEnv, createPool, createClient, createRepositories, withTransaction: rawTx } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));
const { cleanup } = require(path.join(DB_DIR, 'src', 'maintenance', 'cleanup.js'));
const { storageVerification } = require(path.join(DB_DIR, 'src', 'maintenance', 'storage-verification.js'));
const plans = require(path.join(ROOT, 'server', 'plans.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.MAINT_TESTS_REQUIRED === '1';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6380';
const MINIO = process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100';
const RUN = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silent = W.silentLogger();
const REASON = 'T-602 maintenance test';
const DAY = 86400000;

(async () => {
  console.log('T-602 maintenance jobs tests');

  // ── Pure: buckets, resolver ──────────────────────────────────────────────
  console.log('\n0. Buckets and the plan resolver (no infrastructure)');
  ok(W.bucketKey('day', Date.UTC(2026, 8, 12, 23, 59)) === '2026-09-12' && W.bucketKey('hour', Date.UTC(2026, 8, 12, 14, 5)) === '2026-09-12T14', 'day/hour buckets are UTC ISO labels');
  ok(W.isoWeek(new Date('2026-09-12T00:00:00Z')) === '2026-W37' && W.isoWeek(new Date('2027-01-01T00:00:00Z')) === '2026-W53' && W.isoWeek(new Date('2024-12-30T00:00:00Z')) === '2025-W01', 'ISO weeks handle year boundaries');
  let threw = null; try { W.bucketKey('minute', Date.now()); } catch (e) { threw = e; }
  ok(threw && /unknown bucket/.test(threw.message), 'an unknown bucket is refused');
  ok(W.DEFAULT_SCHEDULES.map((s) => `${s.id}:${s.every}`).join(' ') === `usage_sync:${W.DAY} upload_expiry:${W.HOUR} cleanup:${W.DAY} cleanup_orphans:${W.WEEK}`, 'docs/10 §3 cadences: daily usage_sync/cleanup, hourly upload_expiry, weekly orphan scan');
  const resolve = W.createPlanResolver({ plans, env: {} , now: () => Date.UTC(2026, 8, 12) });
  ok((await resolve({})).planSlug === 'free', 'no user → the default plan');
  ok((await resolve({ user: { manualPlan: 'pro' } })).planSlug === 'pro', 'an unexpired comp wins');
  ok((await resolve({ user: { manualPlan: 'pro', manualPlanExpires: '2026-01-01T00:00:00Z' }, subscription: { status: 'active', planSlug: 'business' } })).planSlug === 'business', 'an expired comp falls through to the subscription');
  ok((await resolve({ user: {}, subscription: { status: 'canceled', planSlug: 'pro' } })).planSlug === 'free', 'a canceled subscription entitles nothing');
  ok((await resolve({ user: {}, subscription: { status: 'past_due', planSlug: 'pro' } })).planSlug === 'pro', 'past_due keeps its grace (docs/07 §9)');
  const v2 = await W.createPlanResolver({ plans, env: { QUOTA_ENFORCEMENT_V2: 'true' } })({});
  ok(v2.model === 'v2' && v2.maxStorageBytes === 5368709120, 'the resolver honours QUOTA_ENFORCEMENT_V2 through the one catalog');
  threw = null; try { W.createPlanResolver({ plans: {} }); } catch (e) { threw = e; }
  ok(threw && /plan catalog/.test(threw.message), 'the resolver refuses to build without the catalog');

  // ── Infrastructure ───────────────────────────────────────────────────────
  let env = null, pgUp = false, redisUp = false, storageUp = false, pool = null;
  try { env = loadEnv({ appEnv: 'test' }); } catch (e) { console.log('  env:', e.message); }
  if (env) { pool = createPool({ env, max: 8 }); try { await pool.query('select 1'); pgUp = true; } catch {} }
  try { const c = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 1500, lazyConnect: true }); await c.connect(); redisUp = (await c.ping()) === 'PONG'; await c.quit(); } catch {}
  try { storageUp = (await fetch(`${MINIO}/minio/health/live`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
  if (!pgUp || !redisUp || !storageUp) {
    console.log(`\n  SKIPPED A–D — ${[!pgUp && 'PostgreSQL unreachable', !redisUp && `no Redis at ${REDIS_URL}`, !storageUp && `no object storage at ${MINIO}`].filter(Boolean).join(', ')}`);
    if (REQUIRED) { fail += 1; console.log('  FAIL: MAINT_TESTS_REQUIRED=1 but infrastructure is unavailable'); }
  } else {
    const db = createClient(pool);
    const repositories = () => createRepositories(db);
    const repos = repositories();
    const withTransaction = (fn) => rawTx(fn, db);
    const storagePkg = require(path.join(ROOT, 'storage', 'src', 'index.js'));
    const storage = storagePkg.createStorageProvider({ appEnv: 'test' });
    const U = `usr_t602_${RUN}`;
    const rid = (k) => `rec_t602_${k}_${RUN}`;
    const key = (k) => `sources/${rid(k)}/source.webm`;
    const ago = (days) => new Date(Date.now() - days * DAY);
    const mkRec = (k, { status = 'ready', deletedAt = null, createdAt = new Date() } = {}) =>
      db.execute(sql`INSERT INTO recordings (id,user_id,title,status,source_kind,privacy,deleted_at,created_at) VALUES (${rid(k)}, ${U}, ${k}, ${status}, 'extension', 'unlisted', ${deletedAt}, ${createdAt})`);
    const mkAsset = (k, suffix, { bytes = 1000, counts = true, withObject = true } = {}) => (async () => {
      const storageKey = suffix ? `sources/${rid(k)}/${suffix}` : key(k);
      await db.execute(sql`INSERT INTO video_assets (id,recording_id,kind,storage_key,status,size_bytes,counts_toward_quota) VALUES (${`ast_${k}_${suffix || 'src'}_${RUN}`}, ${rid(k)}, ${suffix ? 'poster' : 'source'}, ${storageKey}, 'ready', ${bytes}, ${counts})`);
      if (withObject) await storage.putObject(storageKey, Buffer.alloc(bytes, 1), { contentType: 'video/webm' });
      return storageKey;
    })();
    const exists = async (k) => !!(await storage.headObject(k).catch((e) => (e.code === 'object_not_found' ? null : Promise.reject(e))));
    const rowExists = async (k) => (await db.execute(sql`select 1 from recordings where id = ${rid(k)}`)).rows.length === 1;
    const pending = async () => Number((await db.execute(sql`select storage_pending_deletion_bytes p from usage where user_id = ${U}`)).rows[0].p);

    await db.execute(sql`INSERT INTO users (id,email,name,password_hash) VALUES (${U}, ${`t602-${RUN}@example.com`}, 'T602', 'x')`);
    await db.execute(sql`INSERT INTO usage (user_id, storage_pending_deletion_bytes) VALUES (${U}, 5000)`);

    try {
      // ── A. cleanup ─────────────────────────────────────────────────────────
      console.log('\nA. cleanup: retention purge, rejected grace, session purge — idempotent');
      await mkRec('old', { deletedAt: ago(31) });
      const oldKey = await mkAsset('old', null, { bytes: 3000 });
      const oldPoster = await mkAsset('old', 'poster.jpg', { bytes: 200, counts: false, withObject: false });   // row without object
      await mkRec('recent', { deletedAt: ago(5) });
      await mkAsset('recent', null, { bytes: 700 });
      await mkRec('rejold', { status: 'rejected_limit', createdAt: ago(8) });
      const rejKey = await mkAsset('rejold', null, { bytes: 400, counts: false });
      await mkRec('rejnew', { status: 'rejected_limit', createdAt: ago(2) });
      await mkAsset('rejnew', null, { bytes: 400, counts: false });
      await mkRec('live');
      await mkAsset('live', null, { bytes: 900 });
      await db.execute(sql`INSERT INTO sessions (id,user_id,token_hash,client,expires_at) VALUES (${`ses_exp_${RUN}`}, ${U}, ${`h1${RUN}`}, 'web', ${ago(1)}), (${`ses_live_${RUN}`}, ${U}, ${`h2${RUN}`}, 'web', ${ago(-1)}), (${`ses_rev_${RUN}`}, ${U}, ${`h3${RUN}`}, 'extension', ${ago(-5)})`);
      await db.execute(sql`update sessions set revoked_at = ${ago(1)} where id = ${`ses_rev_${RUN}`}`);
      const before = await db.execute(sql`select count(*)::int n from sessions where user_id = ${U}`);
      ok(before.rows[0].n === 3 && (await exists(oldKey)) && (await exists(rejKey)), 'fixtures in place (3 sessions, objects present)');

      const r1 = await cleanup({ repositories, withTransaction, storage, logger: silent });
      ok(r1.purged >= 1 && !(await rowExists('old')) && !(await exists(oldKey)), 'a recording soft-deleted 31 d ago is purged: objects gone, row gone');
      ok(!(await exists(oldPoster)), 'an asset row whose object was already missing does not block the purge');
      ok((await pending()) === 2000, 'pending_deletion decremented by the QUOTA-COUNTING bytes only (5000 − 3000)');
      ok((await rowExists('recent')) && (await exists(key('recent'))), 'a recording soft-deleted 5 d ago is kept (30-day retention)');
      ok(r1.rejectedPurged >= 1 && !(await rowExists('rejold')) && !(await exists(rejKey)), 'a rejected_limit recording past the 7-day grace is purged');
      ok((await rowExists('rejnew')) && (await rowExists('live')), 'a fresh rejected_limit and a live recording are untouched');
      const after = (await db.execute(sql`select id from sessions where user_id = ${U} order by id`)).rows.map((r) => r.id);
      ok(after.length === 1 && after[0] === `ses_live_${RUN}`, 'expired and revoked sessions are dropped, the live one stays');
      ok(r1.errors === 0 && r1.storageErrors === 0 && r1.orphanScan === false, 'clean run: no errors, no orphan scan unless asked');
      const assetsLeft = (await db.execute(sql`select count(*)::int n from video_assets where recording_id = ${rid('old')}`)).rows[0].n;
      ok(assetsLeft === 0, 'the purged recording\'s asset rows cascaded away');

      const r2 = await cleanup({ repositories, withTransaction, storage, logger: silent });
      ok((await pending()) === 2000 && (await rowExists('recent')) && (await rowExists('rejnew')), 'a second run changes nothing (idempotent)');
      ok(r2.sessionsPurged === 0, 'nothing left to purge the second time');

      // Storage unavailable → rows that own objects are KEPT, never purged blind.
      await mkRec('old2', { deletedAt: ago(40) });
      const old2Key = await mkAsset('old2', null, { bytes: 100 });
      const r3 = await cleanup({ repositories, withTransaction, storage: null, logger: silent });
      ok(r3.skippedNoStorage >= 1 && (await rowExists('old2')) && (await exists(old2Key)), 'without a storage provider a recording that still owns objects is left for a later run');
      const failing = { deleteObject: async () => { const e = new Error('boom'); e.code = 'provider_unavailable'; throw e; } };
      const r4 = await cleanup({ repositories, withTransaction, storage: failing, logger: silent });
      ok(r4.storageErrors >= 1 && (await rowExists('old2')), 'a storage failure keeps the row (objects first, rows second)');
      await cleanup({ repositories, withTransaction, storage, logger: silent });
      ok(!(await rowExists('old2')) && (await pending()) === 1900, 'once storage is back it is purged and the ledger moves');

      // Clamp: pending_deletion never goes negative.
      await mkRec('big', { deletedAt: ago(45) });
      await mkAsset('big', null, { bytes: 10000 });
      await cleanup({ repositories, withTransaction, storage, logger: silent });
      ok(!(await rowExists('big')) && (await pending()) === 0, 'a purge larger than the ledger balance clamps to zero (never negative)');

      // Orphan report: object without a row, older than 7 d — REPORTED, not deleted.
      const orphanKey = `sources/rec_t602_orphan_${RUN}/source.webm`;
      await storage.putObject(orphanKey, Buffer.alloc(50, 2), { contentType: 'video/webm' });
      const r5 = await cleanup({ repositories, withTransaction, storage, logger: silent, orphanScan: true, orphanMinAgeDays: 0 });
      ok(r5.orphanScan === true && r5.orphansScanned >= 1 && r5.orphans >= 1 && r5.orphanSample.some((o) => o.key === orphanKey), 'the orphan scan reports an object with no video_assets row');
      ok(await exists(orphanKey), 'the orphan is NOT deleted (report only, docs/09 §10)');
      const r6 = await cleanup({ repositories, withTransaction, storage, logger: silent, orphanScan: true, orphanMinAgeDays: 7 });
      ok(!r6.orphanSample.some((o) => o.key === orphanKey), 'objects younger than the minimum age are never called orphans');
      await storage.deleteObject(orphanKey);

      // ── B. storage verification ───────────────────────────────────────────
      console.log('\nB. storage_verification: over-limit report');
      await db.execute(sql`INSERT INTO recordings (id,user_id,title,status,source_kind,privacy) VALUES (${rid('heavy')}, ${U}, 'heavy', 'ready', 'extension', 'unlisted')`);
      await db.execute(sql`INSERT INTO video_assets (id,recording_id,kind,storage_key,status,size_bytes,counts_toward_quota) VALUES (${`ast_heavy_${RUN}`}, ${rid('heavy')}, 'source', ${key('heavy')}, 'ready', ${6 * 1024 * 1024 * 1024}, true)`);
      const v2rep = await storageVerification({ repositories, resolveLimits: W.createPlanResolver({ plans, env: { QUOTA_ENFORCEMENT_V2: 'true' } }), logger: silent });
      const mine = v2rep.over.find((o) => o.userId === U);
      ok(v2rep.checked >= 1 && mine && mine.overStorage === true && mine.planSlug === 'free' && mine.storageRetainedBytes >= 6 * 1024 * 1024 * 1024, 'a free account holding 6 GiB of quota-counting assets is flagged under the v2 limits (5 GiB)');
      const legacyRep = await storageVerification({ repositories, resolveLimits: W.createPlanResolver({ plans, env: {} }), logger: silent });
      ok(!legacyRep.over.some((o) => o.userId === U), 'under the legacy limits (20 GB) the same account is within bounds');
      await db.execute(sql`update users set manual_plan = 'pro' where id = ${U}`);
      const compRep = await storageVerification({ repositories, resolveLimits: W.createPlanResolver({ plans, env: { QUOTA_ENFORCEMENT_V2: 'true' } }), logger: silent });
      ok(!compRep.over.some((o) => o.userId === U), 'a comped pro account is resolved from PostgreSQL rows and is within its plan');
      threw = null; try { await storageVerification({ repositories, logger: silent }); } catch (e) { threw = e; }
      ok(threw && /resolveLimits/.test(threw.message), 'verification refuses to run without a plan resolver');

      // ── C. the shipped registry ───────────────────────────────────────────
      console.log('\nC. Shipped registry');
      const reg = W.createDefaultRegistry();
      ok(['cleanup', 'upload_expiry', 'usage_sync'].every((t) => reg.has(t) && reg.get(t).queue === 'maintenance') && reg.queues().includes('maintenance'), 'the default worker runs usage_sync, upload_expiry and cleanup on the maintenance queue');
      ok(!reg.has('subscription_sync') && Object.keys(W.JOB_TYPES).includes('subscription_sync'), 'subscription_sync is NOT registered (legacy JSON store, single writer) but stays in the catalog for its cutover');
      const calls = [];
      const fake = { usageSync: async () => { calls.push('usage'); return { synced: 1, errors: 0 }; }, storageVerification: async () => { calls.push('verify'); return { checked: 1, errors: 0, over: [] }; }, uploadExpiry: async (d) => { calls.push('expiry:' + !!d.storage); return { expired: 0 }; }, cleanup: async (d) => { calls.push('cleanup:' + d.orphanScan); return { purged: 0 }; } };
      const reg2 = W.registerMaintenanceProcessors(W.createRegistry(), fake);
      const deps = { withTransaction, storage, resolveLimits: async () => ({}) };
      const us = await reg2.get('usage_sync').handler({ repositories, deps, logger: silent, payload: {} });
      await reg2.get('upload_expiry').handler({ repositories, deps, logger: silent, payload: {} });
      await reg2.get('cleanup').handler({ repositories, deps, logger: silent, payload: { orphanScan: true } });
      ok(calls.join(' ') === 'usage verify expiry:true cleanup:true' && us.synced === 1 && us.verification.checked === 1, 'processors hand the maintenance functions their dependencies; usage_sync merges the verification report');
      const noResolver = await reg2.get('usage_sync').handler({ repositories, deps: { withTransaction }, logger: silent, payload: {} });
      ok(noResolver.verification === null, 'without a plan resolver usage_sync still syncs and reports verification as skipped');

      // ── D. scheduler ──────────────────────────────────────────────────────
      console.log('\nD. Scheduler: buckets → rows; BullMQ schedulers; end-to-end run visible in admin');
      await db.execute(sql`delete from processing_jobs where dedupe_key like ${'usage_sync:%'} or dedupe_key like ${'upload_expiry:%'} or dedupe_key like ${'cleanup:%'}`);
      const inline = W.createInlineJobQueue({ logger: silent });
      // A clock far from today: the real-BullMQ run below uses TODAY's bucket,
      // and a settled row for that key would (correctly) block it.
      let clock = Date.UTC(2031, 0, 5, 14, 10);
      const sched = W.createScheduler({ jobQueue: inline, repositories, logger: silent, now: () => clock });
      const t1 = await sched.tick({ scheduleId: 'usage_sync' });
      const t2 = await sched.tick({ scheduleId: 'usage_sync' });
      ok(t1.created && !t2.created && t1.job.id === t2.job.id && t1.dedupeKey === 'usage_sync:2031-01-05', 'two ticks in the same day bucket produce ONE job row');
      clock += DAY;
      const t3 = await sched.tick({ scheduleId: 'usage_sync' });
      ok(t3.created && t3.dedupeKey === 'usage_sync:2031-01-06', 'the next day bucket produces a new row');
      const t4 = await sched.tick({ scheduleId: 'cleanup_orphans' });
      ok(t4.created && /^cleanup:orphans:2031-W\d\d$/.test(t4.dedupeKey) && t4.job.queue === 'cleanup' && t4.job.payload.orphanScan === true, 'the weekly orphan tick creates a cleanup job with orphanScan:true under its own key');
      ok((await sched.tick({ scheduleId: 'nope' })) === null, 'a tick for an unknown schedule is ignored');
      const all = await sched.tickAll();
      ok(all.length === 4 && all.every((r) => r && r.job), 'tickAll() ticks every schedule');
      ok((await sched.install()) === 4 && (await inline.listSchedules('maintenance')).length === 4, 'install() upserts one scheduler per schedule (inline records them)');
      await db.execute(sql`update processing_jobs set status = 'cancelled' where dedupe_key like ${'usage_sync:%'} or dedupe_key like ${'upload_expiry:%'} or dedupe_key like ${'cleanup:%'}`);

      // Real BullMQ schedulers + the full path through a real worker app.
      const prefix = `t602s${RUN}`;
      const mkQueue = () => W.createBullJobQueue({ redisUrl: REDIS_URL, prefix, logger: silent, stalledIntervalMs: 500, lockDurationMs: 1000 });
      const config = W.loadWorkerConfig({ REDIS_URL, QUEUE_PREFIX: prefix, OUTBOX_INTERVAL_MS: '100', RECONCILE_INTERVAL_MS: '600000' }, { appEnv: 'test' });
      const q = mkQueue();
      const fastReg = W.createRegistry();
      const ran = [];
      W.registerMaintenanceProcessors(fastReg, { ...fake, usageSync: async () => { ran.push('usage_sync'); return { synced: 2, drifted: 0, errors: 0 }; } });
      const app = W.createWorkerApp({ config, logger: silent, repositories, jobQueue: q, registry: fastReg, deps: { withTransaction, storage, resolveLimits: async () => ({ maxStorageBytes: 1, maxActiveVideos: 1, planSlug: 'free' }) } });
      try {
        await app.start();
        const st = app.status();
        ok(st.scheduler && st.scheduler.length === 4, 'the worker app installs the scheduler when it can run maintenance');
        const installed = await q.listSchedules('maintenance');
        ok(installed.length === 4 && installed.every((s) => String(s.key).startsWith('maintenance:') && Number(s.every) > 0 && s.name === 'tick'), 'four BullMQ job schedulers exist on the maintenance queue (idempotent upsert)');
        // Drive a tick through the transport exactly as a BullMQ scheduler would.
        const tickJob = await (async () => {
          const { Queue } = require(path.join(ROOT, 'worker', 'node_modules', 'bullmq'));
          const bq = new Queue('maintenance', { connection: q.connection, prefix });
          const j = await bq.add('tick', { scheduleId: 'usage_sync' }, { removeOnComplete: true, removeOnFail: true });
          await bq.close();
          return j.id;
        })();
        ok(!!tickJob, 'a tick delivery was placed on the maintenance queue');
        const todayKey = `usage_sync:${W.bucketKey('day', Date.now())}`;
        let row = null;
        for (let i = 0; i < 100 && !(row && row.status === 'completed'); i += 1) { row = await repos.jobs.findByDedupeKey(todayKey); await sleep(100); }
        ok(row && row.status === 'completed' && row.attempts === 1 && row.result && row.result.synced === 2, 'tick → row → relay → runner → processor: today\'s usage_sync row completes with its report as the result');
        ok(ran.length === 1, 'the processor ran exactly once');
        const listed = await repos.jobs.listSystem({ status: 'completed', queue: 'usage_sync', limit: 5 }, REASON);
        ok(listed.some((r) => r.id === row.id), 'the run is visible in the admin listing (status=completed, queue=usage_sync)');
        const noSched = W.createWorkerApp({ config, logger: silent, repositories, jobQueue: mkQueue(), registry: W.createRegistry(), schedules: true });
        ok(noSched.scheduler === null, 'a worker without maintenance processors never installs the ticker');
        const off = W.createWorkerApp({ config: { ...config, scheduler: false }, logger: silent, repositories, jobQueue: mkQueue(), registry: fastReg });
        ok(off.scheduler === null, 'WORKER_SCHEDULER=false opts a worker out');
        ok(W.loadWorkerConfig({ WORKER_SCHEDULER: 'false' }, { appEnv: 'test' }).scheduler === false && W.loadWorkerConfig({ WORKER_SCHEDULER: 'no' }, { appEnv: 'test' }).scheduler === true, 'only the literal "false" disables the scheduler');
        await noSched.jobQueue.close(); await off.jobQueue.close();
      } finally {
        await app.stop();
        const qq = mkQueue(); await qq.obliterate(); await qq.close();
        await db.execute(sql`delete from processing_jobs where dedupe_key like ${'usage_sync:%'} or dedupe_key like ${'upload_expiry:%'} or dedupe_key like ${'cleanup:%'}`);
      }
    } finally {
      for (const k of ['recent', 'rejnew', 'live', 'heavy']) await storage.deleteObject(key(k)).catch(() => {});
      await db.execute(sql`delete from users where id = ${U}`);   // cascades recordings/assets/sessions/usage
    }
  }

  // ── E. Legacy scheduler no longer wires v1 jobs ───────────────────────────
  console.log('\nE. Legacy cron.js keeps only the JSON-store jobs');
  const cron = fs.readFileSync(path.join(ROOT, 'server', 'cron.js'), 'utf8');
  const idx = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  ok(!/upload-expiry|usage-sync|maintenance/.test(cron.replace(/^\s*\/\/.*$/gm, '')), 'cron.js contains no v1 maintenance wiring');
  ok(/dailySubscriptionSync/.test(cron) && /dailyUsageSync/.test(cron) && /dailyStorageVerification/.test(cron), 'the three legacy-store jobs remain (single writer of the JSON stores)');
  ok(!/maintenanceDeps/.test(idx), 'server/index.js no longer builds maintenance deps for the in-process scheduler');
  const cli = fs.readFileSync(path.join(ROOT, 'db', 'src', 'cli', 'maintenance.js'), 'utf8');
  ok(/cleanup/.test(cli) && /--orphans/.test(cli), 'the manual CLI can run cleanup (and the orphan report)');

  if (pool) await pool.end().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
