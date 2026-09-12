// T-601 test fixture: a worker process that takes a `probe` job, announces it
// on stdout, and never finishes — the parent SIGKILLs it to simulate a worker
// dying mid-job, so BullMQ's stalled detection has a real stalled job to
// re-queue. The relay is effectively disabled (huge interval): the parent
// controls what reaches the transport.
'use strict';

const path = require('path');
const W = require(path.join(__dirname, '..', '..', 'worker', 'src', 'index.js'));
const DB = require(path.join(__dirname, '..', '..', 'db', 'src', 'index.js'));

(async () => {
  const env = DB.loadEnv({ appEnv: 'test' });
  const pool = DB.createPool({ env, max: 2 });
  const db = DB.createClient(pool);
  const config = W.loadWorkerConfig({ ...process.env, OUTBOX_INTERVAL_MS: '600000', RECONCILE_INTERVAL_MS: '600000' }, { appEnv: 'test' });
  const jobQueue = W.createBullJobQueue({
    redisUrl: config.redisUrl, prefix: config.prefix,
    stalledIntervalMs: config.stalledIntervalMs, lockDurationMs: config.lockDurationMs,
  });
  const registry = W.createRegistry();
  // HANG_TYPE selects the job type (probe by default; transcribe for T-603).
  registry.register(process.env.HANG_TYPE || 'probe', async ({ job }) => {
    process.stdout.write(`STARTED ${job.id} attempt=${job.attempts}\n`);
    await new Promise(() => {});           // hang forever — the lock keeps renewing while alive
  });
  const app = W.createWorkerApp({ config, repositories: () => DB.createRepositories(db), jobQueue, registry });
  await app.start();
  process.stdout.write('READY\n');
})().catch((e) => { process.stderr.write(`hang-worker failed: ${e && e.stack}\n`); process.exit(1); });
