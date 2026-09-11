// The worker application (docs/02 §2.2, docs/10 §2): outbox relay + one
// consumer per BullMQ queue this process has processors for + graceful
// shutdown (stop taking jobs, finish the current ones ≤ timeout, abort what is
// left, kill child processes, release connections).
'use strict';

const { QUEUE_CONCURRENCY } = require('./catalog');
const { createJobRunner } = require('./run-job');
const { createOutboxRelay } = require('./outbox');
const { createScheduler } = require('./scheduler');
const { assertJobQueue } = require('./queue/job-queue');
const { silentLogger } = require('./logger');

/** Child processes (ffmpeg later) a processor registers so shutdown can SIGKILL them. */
function createChildRegistry() {
  const children = new Set();
  return {
    register(child) {
      children.add(child);
      child.once('exit', () => children.delete(child));
      return () => children.delete(child);
    },
    killAll(signal = 'SIGKILL') {
      let n = 0;
      for (const c of Array.from(children)) { try { c.kill(signal); n += 1; } catch { /* gone */ } children.delete(c); }
      return n;
    },
    size: () => children.size,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {object} o.config           from loadWorkerConfig()
 * @param {object} [o.logger]
 * @param {() => object} o.repositories
 * @param {Function} [o.withTransaction]
 * @param {object} [o.storage]        StorageProvider (optional until a processor needs it)
 * @param {object} o.jobQueue         JobQueue implementation
 * @param {object} o.registry         processor registry
 * @param {object} [o.deps]           extra dependencies handed to processors
 */
function createWorkerApp({ config, logger = silentLogger(), repositories, withTransaction = null, storage = null, jobQueue, registry, deps = {}, schedules = undefined }) {
  if (!config) throw new Error('createWorkerApp: config is required');
  assertJobQueue(jobQueue);
  const children = createChildRegistry();
  const runner = createJobRunner({
    repositories, registry, logger, deferMs: config.deferMs,
    deps: { withTransaction, storage, children, config, ...deps },
  });
  const relay = createOutboxRelay({
    repositories, jobQueue, logger,
    intervalMs: config.outboxIntervalMs, reconcileIntervalMs: config.reconcileIntervalMs,
    minAgeMs: config.reconcileMinAgeMs, batch: config.outboxBatch,
  });
  // T-602: repeatable maintenance schedules. Only a worker that can RUN the
  // maintenance types installs the ticker (a tick for a type nobody runs would
  // only create rows that wait); config.scheduler / `schedules:false` disables.
  const wantScheduler = schedules === undefined ? config.scheduler !== false : !!schedules;
  const scheduler = wantScheduler && registry.has('usage_sync') && typeof jobQueue.upsertSchedule === 'function'
    ? createScheduler({ jobQueue, repositories, logger })
    : null;
  const subscriptions = [];
  let state = 'created';

  // A queue delivery is either a schedule tick (no row yet — the tick creates
  // it) or a real job (row exists — the runner owns its lifecycle).
  const dispatch = (job) => (job.type === 'tick' && scheduler ? scheduler.tick(job.payload || {}) : runner.runJob(job));

  async function start() {
    if (state !== 'created') throw new Error(`worker app cannot start from state "${state}"`);
    state = 'starting';
    for (const queue of registry.queues()) {
      const sub = jobQueue.subscribe(queue, dispatch, {
        concurrency: QUEUE_CONCURRENCY[queue] || config.concurrency,
        onFailed: runner.onTransportFailed,
      });
      if (sub.ready) await sub.ready();
      subscriptions.push(sub);
    }
    if (scheduler) await scheduler.install();
    relay.start();
    state = 'running';
    logger.info({ queues: registry.queues(), types: registry.types(), missing_types: registry.missing(), transport: jobQueue.kind, scheduler: !!scheduler }, 'worker started');
  }

  async function stop({ timeoutMs = config.shutdownTimeoutMs } = {}) {
    if (state === 'stopped' || state === 'stopping') return;
    state = 'stopping';
    logger.info({ inflight: runner.inflightCount(), timeout_ms: timeoutMs }, 'worker stopping — no new jobs, finishing current ones');
    await relay.stop();
    // 1. Graceful: close() waits for the active jobs of each consumer.
    let timedOut = false;
    await Promise.race([
      Promise.all(subscriptions.map((s) => s.close(false).catch(() => {}))),
      sleep(timeoutMs).then(() => { timedOut = true; }),
    ]);
    // 2. Past the deadline: abort processors, kill children, force-close.
    if (timedOut) {
      logger.warn({ inflight: runner.inflightCount() }, 'shutdown deadline passed — aborting remaining jobs');
      runner.abortAll('shutdown');
      const killed = children.killAll('SIGKILL');
      if (killed) logger.warn({ killed }, 'child processes killed');
      await Promise.all(subscriptions.map((s) => s.close(true).catch(() => {})));
    }
    subscriptions.length = 0;
    await jobQueue.close();
    state = 'stopped';
    logger.info({ timed_out: timedOut, relay: relay.stats }, 'worker stopped');
    return { timedOut };
  }

  function status() {
    return { state, transport: jobQueue.kind, queues: registry.queues(), types: registry.types(), inflight: runner.inflightCount(), relay: { ...relay.stats, running: relay.isRunning() }, children: children.size(), scheduler: scheduler ? scheduler.schedules.map((s) => s.id) : null };
  }

  return { start, stop, status, runner, relay, scheduler, children, registry, jobQueue };
}

module.exports = { createWorkerApp, createChildRegistry };
