// Legacy re-processing backfill (docs/23 Phase 7, T-706): every active
// recording that has an R2 source but no MP4 + poster yet is pushed through
// the pipeline again by (re)queueing its `probe:{id}` job — the probe re-fans
// out transcode/thumbnail/audio (+ hls). Throttled by `limit` per run: the
// queue does the work; this only fills it. Idempotent: dedupe keys make a
// second run a no-op for recordings already in flight.
//
//   pipelineStats(deps)  → the progress dashboard numbers (admin endpoint + CLI)
//   queueFill(deps)      → dry run by default; `apply:true` writes rows
'use strict';

const REASON = 'T-706 pipeline backfill: (re)queue probe for recordings lacking MP4 + poster';

/**
 * @param {object} deps
 * @param {() => object} deps.repositories
 */
async function pipelineStats({ repositories }) {
  const repos = repositories();
  const s = await repos.recordings.pipelineStatsSystem(REASON);
  const pct = s.withSource ? Math.round((s.complete / s.withSource) * 1000) / 10 : 100;
  return { ...s, completePercent: pct };
}

/**
 * @param {object} deps
 * @param {() => object} deps.repositories
 * @param {(fn) => Promise} deps.withTransaction
 * @param {number} [deps.limit]          recordings per run (default 100)
 * @param {boolean}[deps.apply]          false = dry run (default)
 * @param {boolean}[deps.includeFailed]  also retry recordings failed(probe_invalid|transcode_failed)
 * @param {object} [deps.logger]
 */
async function queueFill({ repositories, withTransaction, limit = 100, apply = false, includeFailed = false, logger = console }) {
  const repos = repositories();
  const gaps = await repos.recordings.listPipelineGapsSystem({ limit, includeFailed }, REASON);
  const report = { dryRun: !apply, scanned: gaps.length, enqueued: 0, requeued: 0, inFlight: 0, errors: 0, recordingIds: [] };
  for (const rec of gaps) {
    try {
      if (!apply) { report.recordingIds.push(rec.id); continue; }
      const outcome = await withTransaction(async (tx) => {
        const { job, created } = await tx.jobs.enqueue({ queue: 'probe', dedupeKey: `probe:${rec.id}`, recordingId: rec.id, payload: { recordingId: rec.id, trigger: 'backfill' }, maxAttempts: 5 });
        if (created) return 'enqueued';
        if (job.status === 'queued' || job.status === 'active') return 'inFlight';
        const again = await tx.jobs.requeueSystem(job.id, REASON, { resetAttempts: true, fromStatuses: ['completed', 'failed', 'cancelled'] });
        return again ? 'requeued' : 'inFlight';
      });
      report[outcome] += 1;
      report.recordingIds.push(rec.id);
      logger.info({ recording_id: rec.id, status: rec.status, outcome }, 'pipeline backfill: probe queued');
    } catch (err) {
      report.errors += 1;
      logger.warn({ recording_id: rec.id, err: { message: err && err.message } }, 'pipeline backfill: enqueue failed');
    }
  }
  return report;
}

module.exports = { pipelineStats, queueFill, REASON };
