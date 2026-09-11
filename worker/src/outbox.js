// Transactional outbox relay + transport reconciler (docs/10 §1–§2).
//
// The API (and every worker) writes `processing_jobs(status='queued')` INSIDE
// the business transaction and never touches the transport. This relay hands
// committed rows with `enqueued_at IS NULL` to the JobQueue and stamps them.
// The crash window is closed from both sides:
//
//   • crash after commit, before enqueue  → the row is still unstamped, the
//     next pass enqueues it;
//   • crash after enqueue, before stamp   → the next pass enqueues AGAIN, and
//     the transport dedupes on the job id (the row id), so the job still runs
//     exactly once; the stamp then lands.
//
// The reconciler is the docs/10 §1 promise "if Redis is wiped, re-enqueue
// everything queued / active-but-stalled from Postgres": a `queued` row that
// has been stamped for longer than `minAgeMs` but is unknown to the transport
// is re-enqueued; an `active` row older than twice its type's timeout that the
// transport no longer holds is put back to `queued` (unstamped) for the relay.
'use strict';

const { specFor } = require('./catalog');
const { silentLogger } = require('./logger');

const REASON = 'T-601 outbox relay: hand committed processing_jobs rows to the transport';

function createOutboxRelay({
  repositories, jobQueue, logger = silentLogger(),
  intervalMs = 500, reconcileIntervalMs = 60000, minAgeMs = 300000, batch = 100, now = () => Date.now(),
}) {
  if (typeof repositories !== 'function') throw new Error('createOutboxRelay: repositories() is required');
  if (!jobQueue) throw new Error('createOutboxRelay: jobQueue is required');

  const stats = { passes: 0, relayed: 0, reconcilePasses: 0, requeued: 0, recovered: 0, errors: 0, lastPassAt: null, lastReconcileAt: null };
  let relayTimer = null, reconcileTimer = null;
  let relaying = null, reconciling = null;
  let stopped = true;

  // Not `async`: callers get the SAME in-flight promise (single-flight), so
  // overlapping passes can never race on a row.
  function relayOnce() {
    if (relaying) return relaying;
    relaying = (async () => {
      const repos = repositories();
      const report = { scanned: 0, relayed: 0, errors: 0 };
      try {
        const rows = await repos.jobs.listUnenqueuedSystem({ limit: batch }, REASON);
        report.scanned = rows.length;
        for (const row of rows) {
          try {
            const r = await jobQueue.enqueue({ id: row.id, type: row.queue, payload: row.payload, attempts: row.maxAttempts });
            await repos.jobs.markEnqueuedSystem(row.id, REASON);
            report.relayed += 1;
            logger.info({ job_id: row.id, queue: row.queue, recording_id: row.recordingId || undefined, created: r.created }, 'job relayed to transport');
          } catch (err) {
            report.errors += 1;
            logger.warn({ job_id: row.id, queue: row.queue, err: { message: err.message } }, 'relay failed — retried next pass');
          }
        }
      } catch (err) {
        report.errors += 1;
        logger.warn({ err: { message: err.message } }, 'outbox scan failed');
      }
      stats.passes += 1; stats.relayed += report.relayed; stats.errors += report.errors; stats.lastPassAt = now();
      return report;
    })().finally(() => { relaying = null; });
    return relaying;
  }

  function reconcileOnce() {
    if (reconciling) return reconciling;
    reconciling = (async () => {
      const repos = repositories();
      const report = { staleQueued: 0, requeued: 0, staleActive: 0, recovered: 0, errors: 0 };
      try {
        const before = new Date(now() - minAgeMs);
        const queued = await repos.jobs.listStaleQueuedSystem({ before, limit: batch }, REASON);
        report.staleQueued = queued.length;
        for (const row of queued) {
          try {
            if (await jobQueue.has(row.id, row.queue)) continue;
            await jobQueue.enqueue({ id: row.id, type: row.queue, payload: row.payload, attempts: row.maxAttempts });
            await repos.jobs.markEnqueuedSystem(row.id, REASON);
            report.requeued += 1;
            logger.warn({ job_id: row.id, queue: row.queue }, 'queued job missing from transport — re-enqueued from processing_jobs');
          } catch (err) { report.errors += 1; logger.warn({ job_id: row.id, err: { message: err.message } }, 'reconcile (queued) failed'); }
        }
        const active = await repos.jobs.listStaleActiveSystem({ before, limit: batch }, REASON);
        report.staleActive = active.length;
        for (const row of active) {
          try {
            const spec = specFor(row.queue);
            const age = now() - new Date(row.startedAt).getTime();
            if (age < spec.timeoutMs * 2) continue;              // may legitimately still be running
            if (await jobQueue.has(row.id, row.queue)) continue;  // the transport still holds it
            const back = await repos.jobs.requeueSystem(row.id, REASON, { fromStatuses: ['active'] });
            if (back) {
              report.recovered += 1;
              logger.warn({ job_id: row.id, queue: row.queue, age_ms: age }, 'active job lost by transport — returned to queued for the relay');
            }
          } catch (err) { report.errors += 1; logger.warn({ job_id: row.id, err: { message: err.message } }, 'reconcile (active) failed'); }
        }
      } catch (err) {
        report.errors += 1;
        logger.warn({ err: { message: err.message } }, 'reconcile scan failed');
      }
      stats.reconcilePasses += 1; stats.requeued += report.requeued; stats.recovered += report.recovered; stats.errors += report.errors; stats.lastReconcileAt = now();
      return report;
    })().finally(() => { reconciling = null; });
    return reconciling;
  }

  function schedule() {
    if (stopped) return;
    relayTimer = setTimeout(async () => { await relayOnce().catch(() => {}); schedule(); }, intervalMs);
  }
  function scheduleReconcile() {
    if (stopped) return;
    reconcileTimer = setTimeout(async () => { await reconcileOnce().catch(() => {}); scheduleReconcile(); }, reconcileIntervalMs);
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    schedule();
    scheduleReconcile();
    logger.info({ interval_ms: intervalMs, reconcile_interval_ms: reconcileIntervalMs, min_age_ms: minAgeMs }, 'outbox relay started');
  }

  async function stop() {
    stopped = true;
    if (relayTimer) clearTimeout(relayTimer);
    if (reconcileTimer) clearTimeout(reconcileTimer);
    relayTimer = reconcileTimer = null;
    if (relaying) await relaying.catch(() => {});
    if (reconciling) await reconciling.catch(() => {});
  }

  return { relayOnce, reconcileOnce, start, stop, stats, isRunning: () => !stopped, REASON };
}

module.exports = { createOutboxRelay, REASON };
