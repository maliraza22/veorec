// JobQueue over BullMQ + Redis (docs/10 §2). Redis is disposable: nothing here
// is authoritative — a lost job is re-enqueued from `processing_jobs` by the
// reconciler (outbox.js), which is why every job is removed from Redis as soon
// as it completes or fails (the row keeps the result and the error).
'use strict';

const { Queue, Worker, UnrecoverableError, DelayedError } = require('bullmq');
const IORedis = require('ioredis');
const { specFor, backoffMs } = require('../catalog');
const { silentLogger } = require('../logger');

const LIVE_STATES = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children', 'paused']);

/**
 * @param {object} o
 * @param {string} [o.redisUrl]
 * @param {import('ioredis').Redis} [o.connection]  an existing ioredis client
 * @param {string} [o.prefix]
 * @param {object} [o.logger]
 * @param {number} [o.stalledIntervalMs]
 * @param {number} [o.lockDurationMs]
 * @param {number} [o.maxStalledCount]   BullMQ: stalls beyond this fail the job
 * @param {(attempt:number)=>number} [o.backoff]
 */
function createBullJobQueue({
  redisUrl, connection, prefix = 'veorec', logger = silentLogger(),
  stalledIntervalMs = 60000, lockDurationMs = 30000, maxStalledCount = 1, backoff = backoffMs, deferMs = 5000,
} = {}) {
  if (!connection && !redisUrl) throw new Error('createBullJobQueue: redisUrl or connection is required');
  // BullMQ needs maxRetriesPerRequest:null on its blocking connection; it
  // duplicates this client for that purpose.
  const conn = connection || new IORedis(redisUrl, { maxRetriesPerRequest: null, enableOfflineQueue: true });
  conn.on('error', (err) => logger.warn({ err: { message: err.message } }, 'redis connection error'));

  const queues = new Map();
  const workers = new Set();
  let closed = false;

  function queueFor(name) {
    let q = queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: conn, prefix,
        defaultJobOptions: { removeOnComplete: true, removeOnFail: true, backoff: { type: 'custom' } },
      });
      q.on('error', (err) => logger.warn({ err: { message: err.message }, queue: name }, 'bullmq queue error'));
      queues.set(name, q);
    }
    return q;
  }

  async function enqueue({ id, type, payload = {}, attempts }) {
    if (!id || typeof id !== 'string') throw new Error('enqueue: id is required');
    const spec = specFor(type);
    const q = queueFor(spec.queue);
    const before = await q.getJob(id);
    const job = await q.add(type, payload, { jobId: id, attempts: attempts || spec.attempts });
    return { jobId: job.id, created: !before };
  }

  async function has(id, type) {
    const spec = specFor(type);
    const job = await queueFor(spec.queue).getJob(id);
    if (!job) return false;
    const state = await job.getState();
    return LIVE_STATES.has(state);
  }

  function subscribe(queueName, handler, { concurrency = 1, onFailed } = {}) {
    const worker = new Worker(queueName, async (job, token) => {
      try {
        return await handler({ id: job.id, type: job.name, payload: job.data, attemptsMade: job.attemptsMade });
      } catch (err) {
        // "Not here": hand the delivery back to the transport, no attempt consumed.
        if (err && err.defer) {
          await job.moveToDelayed(Date.now() + (err.deferMs || deferMs), token);
          throw new DelayedError();
        }
        // The runner decided this failure is terminal → BullMQ must not retry.
        if (err && err.unrecoverable) throw new UnrecoverableError(err.message || 'unrecoverable');
        throw err;
      }
    }, {
      connection: conn, prefix, concurrency,
      stalledInterval: stalledIntervalMs, lockDuration: lockDurationMs, maxStalledCount,
      settings: { backoffStrategy: (attemptsMade) => backoff(attemptsMade) },
    });
    worker.on('error', (err) => logger.warn({ err: { message: err.message }, queue: queueName }, 'bullmq worker error'));
    worker.on('failed', (job, err) => {
      if (onFailed) Promise.resolve(onFailed({ id: job && job.id, type: job && job.name, error: err })).catch((e) =>
        logger.warn({ err: { message: e.message } }, 'onFailed handler threw'));
    });
    workers.add(worker);
    return {
      queue: queueName,
      ready: () => worker.waitUntilReady(),
      close: async (force = false) => { workers.delete(worker); await worker.close(force); },
      raw: worker,
    };
  }

  async function obliterate() {
    for (const q of queues.values()) await q.obliterate({ force: true });
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const w of Array.from(workers)) { try { await w.close(true); } catch { /* closing */ } }
    workers.clear();
    for (const q of queues.values()) { try { await q.close(); } catch { /* closing */ } }
    queues.clear();
    if (!connection) { try { await conn.quit(); } catch { conn.disconnect(); } }
  }

  return { kind: 'bullmq', prefix, enqueue, has, subscribe, obliterate, close, connection: conn };
}

module.exports = { createBullJobQueue, LIVE_STATES };
