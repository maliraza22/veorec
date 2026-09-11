// Repeatable maintenance schedules (T-602, docs/10 §3 "repeat hourly/daily").
//
// BullMQ job schedulers are only the TICKER. A tick creates the real job as a
// `processing_jobs` row (the outbox row, like any other job) whose dedupe key
// is the time bucket — `usage_sync:2026-09-12`, `upload_expiry:2026-09-12T14`
// — so however many workers tick, a bucket runs at most once, the run is
// visible in /admin/jobs, a failed run is retryable there, and a lost Redis
// costs at most one tick. The relay then hands the row to the transport and
// the runner executes the registered processor.
'use strict';

const { silentLogger } = require('./logger');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const DEFAULT_SCHEDULES = Object.freeze([
  { id: 'usage_sync',      type: 'usage_sync',    every: DAY,  bucket: 'day' },
  { id: 'upload_expiry',   type: 'upload_expiry', every: HOUR, bucket: 'hour' },
  { id: 'cleanup',         type: 'cleanup',       every: DAY,  bucket: 'day' },
  // docs/09 §10: the orphan scan is weekly and report-only.
  { id: 'cleanup_orphans', type: 'cleanup',       every: WEEK, bucket: 'week', keyPrefix: 'cleanup:orphans', payload: { orphanScan: true } },
]);

const pad = (n) => String(n).padStart(2, '0');

/** ISO-8601 week label, e.g. 2026-W37 (UTC). */
function isoWeek(t) {
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  const day = d.getUTCDay() || 7;                       // Monday=1 … Sunday=7
  d.setUTCDate(d.getUTCDate() + 4 - day);               // nearest Thursday
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${pad(week)}`;
}

/** The dedupe-key bucket for a schedule granularity, in UTC. */
function bucketKey(bucket, ms) {
  const t = new Date(ms);
  const day = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  if (bucket === 'day') return day;
  if (bucket === 'hour') return `${day}T${pad(t.getUTCHours())}`;
  if (bucket === 'week') return isoWeek(t);
  throw new Error(`unknown bucket "${bucket}"`);
}

/**
 * @param {object} o
 * @param {object} o.jobQueue         JobQueue with upsertSchedule/listSchedules
 * @param {() => object} o.repositories
 * @param {object} [o.logger]
 * @param {Array}  [o.schedules]
 * @param {() => number} [o.now]
 * @param {string} [o.queue]          BullMQ queue carrying the ticks
 */
function createScheduler({ jobQueue, repositories, logger = silentLogger(), schedules = DEFAULT_SCHEDULES, now = () => Date.now(), queue = 'maintenance' }) {
  if (!jobQueue || typeof jobQueue.upsertSchedule !== 'function') throw new Error('createScheduler: jobQueue must implement upsertSchedule()');
  if (typeof repositories !== 'function') throw new Error('createScheduler: repositories() is required');
  const byId = new Map(schedules.map((s) => [s.id, s]));

  /** Idempotent: upserting the same scheduler ids from every worker is a no-op. */
  async function install() {
    for (const s of schedules) {
      await jobQueue.upsertSchedule(queue, `maintenance:${s.id}`, { every: s.every }, { name: 'tick', data: { scheduleId: s.id } });
    }
    logger.info({ schedules: schedules.map((s) => `${s.id}@${s.every}ms`) }, 'maintenance schedules installed');
    return schedules.length;
  }

  /** A tick: create (or find) this bucket's job row. */
  async function tick({ scheduleId } = {}) {
    const s = byId.get(scheduleId);
    if (!s) { logger.warn({ schedule_id: scheduleId }, 'tick for an unknown schedule ignored'); return null; }
    const dedupeKey = `${s.keyPrefix || s.type}:${bucketKey(s.bucket, now())}`;
    const { job, created } = await repositories().jobs.enqueue({ queue: s.type, dedupeKey, payload: s.payload || {}, maxAttempts: 3 });
    logger.info({ schedule_id: s.id, job_id: job.id, queue: s.type, dedupe_key: dedupeKey, created }, created ? 'maintenance job created by schedule' : 'maintenance bucket already has its job');
    return { job, created, dedupeKey };
  }

  async function tickAll() {
    const out = [];
    for (const s of schedules) out.push(await tick({ scheduleId: s.id }));
    return out;
  }

  return { install, tick, tickAll, schedules, queue };
}

module.exports = { createScheduler, DEFAULT_SCHEDULES, bucketKey, isoWeek, HOUR, DAY, WEEK };
