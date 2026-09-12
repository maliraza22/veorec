// Processing jobs — the durable mirror of every queue job (docs/07 §8, docs/10).
//
// Rows are written transactionally with the mutation that causes them (outbox
// pattern), so a Redis outage cannot lose work. `dedupe_key` is what makes
// enqueueing idempotent: the same logical job can never be queued twice.
'use strict';

const { and, eq, isNull, isNotNull, lte, inArray, asc, desc, sql } = require('drizzle-orm');
const { processingJobs, recordings } = require('../schema');
const { newId } = require('../ids');
const { exec, NotFoundError } = require('./errors');
const { requireScope, requireSystemReason } = require('./scope');

module.exports = function jobsRepo(db) {
  return {
    /**
     * Idempotent enqueue. Returns { job, created } — `created:false` means an
     * identical job already existed, which callers treat as success.
     */
    async enqueue({ queue, dedupeKey, recordingId = null, payload = {}, maxAttempts = 3 }) {
      const [inserted] = await exec('processing_job', () => db.insert(processingJobs).values({
        id: newId('job'), queue, dedupeKey, recordingId, payload, maxAttempts, status: 'queued',
      }).onConflictDoNothing({ target: processingJobs.dedupeKey }).returning());
      if (inserted) return { job: inserted, created: true };
      const existing = await this.findByDedupeKey(dedupeKey);
      return { job: existing, created: false };
    },

    async findByDedupeKey(dedupeKey) {
      const [row] = await exec('processing_job', () => db.select().from(processingJobs)
        .where(eq(processingJobs.dedupeKey, dedupeKey)).limit(1));
      return row || null;
    },

    async getSystem(id, reason) {
      requireSystemReason(reason);
      const [row] = await exec('processing_job', () => db.select().from(processingJobs)
        .where(eq(processingJobs.id, id)).limit(1));
      return row || null;
    },

    /** Outbox relay: committed rows not yet handed to the queue (docs/10 §3). */
    async listUnenqueuedSystem({ limit = 100 } = {}, reason) {
      requireSystemReason(reason);
      return exec('processing_job', () => db.select().from(processingJobs)
        .where(and(isNull(processingJobs.enqueuedAt), eq(processingJobs.status, 'queued')))
        .orderBy(asc(processingJobs.createdAt)).limit(limit));
    },

    async markEnqueuedSystem(id, reason) {
      requireSystemReason(reason);
      const [row] = await exec('processing_job', () => db.update(processingJobs)
        .set({ enqueuedAt: new Date() }).where(eq(processingJobs.id, id)).returning());
      return row || null;
    },

    async markActiveSystem(id, reason) {
      requireSystemReason(reason);
      const [row] = await exec('processing_job', () => db.update(processingJobs)
        .set({ status: 'active', startedAt: new Date(), attempts: sql`${processingJobs.attempts} + 1` })
        .where(eq(processingJobs.id, id)).returning());
      if (!row) throw new NotFoundError('processing_job');
      return row;
    },

    async markCompletedSystem(id, result, reason) {
      requireSystemReason(reason);
      const [row] = await exec('processing_job', () => db.update(processingJobs)
        .set({ status: 'completed', result: result ?? null, finishedAt: new Date(), lastError: null })
        .where(eq(processingJobs.id, id)).returning());
      if (!row) throw new NotFoundError('processing_job');
      return row;
    },

    /** `status` stays 'queued' while retries remain; 'failed' is terminal. */
    async markFailedSystem(id, error, reason, { terminal = false } = {}) {
      requireSystemReason(reason);
      const [row] = await exec('processing_job', () => db.update(processingJobs)
        .set({
          status: terminal ? 'failed' : 'queued',
          lastError: String(error || '').slice(0, 4000),
          finishedAt: terminal ? new Date() : null,
        })
        .where(eq(processingJobs.id, id)).returning());
      if (!row) throw new NotFoundError('processing_job');
      return row;
    },

    /** Pipeline status for the watch/status endpoint — ownership enforced. */
    async listForRecording(scope, recordingId) {
      const { userId } = requireScope(scope);
      const rows = await exec('processing_job', () => db.select({ job: processingJobs })
        .from(processingJobs)
        .innerJoin(recordings, eq(processingJobs.recordingId, recordings.id))
        .where(and(eq(processingJobs.recordingId, recordingId), eq(recordings.userId, userId),
          isNull(recordings.deletedAt)))
        .orderBy(asc(processingJobs.createdAt)));
      return rows.map((r) => r.job);
    },

    /** Admin triage: the failed table IS the dead-letter queue (docs/10 §5). */
    async listFailedSystem({ limit = 100 } = {}, reason) {
      requireSystemReason(reason);
      return exec('processing_job', () => db.select().from(processingJobs)
        .where(eq(processingJobs.status, 'failed')).orderBy(asc(processingJobs.finishedAt)).limit(limit));
    },

    async listByStatusSystem(statuses, reason, { limit = 100 } = {}) {
      requireSystemReason(reason);
      return exec('processing_job', () => db.select().from(processingJobs)
        .where(inArray(processingJobs.status, statuses)).limit(limit));
    },

    // ── T-601: outbox reconciler + admin triage ─────────────────────────────

    /** Stamped `queued` rows older than `before` — candidates the transport may have lost. */
    async listStaleQueuedSystem({ before, limit = 100 }, reason) {
      requireSystemReason(reason);
      return exec('processing_job', () => db.select().from(processingJobs)
        .where(and(eq(processingJobs.status, 'queued'), isNotNull(processingJobs.enqueuedAt), lte(processingJobs.enqueuedAt, before)))
        .orderBy(asc(processingJobs.enqueuedAt)).limit(limit));
    },

    /** `active` rows started before `before` — a worker may have died holding them. */
    async listStaleActiveSystem({ before, limit = 100 }, reason) {
      requireSystemReason(reason);
      return exec('processing_job', () => db.select().from(processingJobs)
        .where(and(eq(processingJobs.status, 'active'), isNotNull(processingJobs.startedAt), lte(processingJobs.startedAt, before)))
        .orderBy(asc(processingJobs.startedAt)).limit(limit));
    },

    /**
     * Put a job back in front of the relay: status 'queued', enqueued_at /
     * started_at / finished_at cleared, attempts optionally reset (admin retry,
     * docs/10 §5). Guarded by `fromStatuses` so a concurrent state change makes
     * this a no-op (returns null) rather than a clobber.
     */
    async requeueSystem(id, reason, { resetAttempts = false, fromStatuses = ['failed', 'active'] } = {}) {
      requireSystemReason(reason);
      const set = { status: 'queued', enqueuedAt: null, startedAt: null, finishedAt: null };
      if (resetAttempts) set.attempts = 0;
      const [row] = await exec('processing_job', () => db.update(processingJobs).set(set)
        .where(and(eq(processingJobs.id, id), inArray(processingJobs.status, fromStatuses))).returning());
      return row || null;
    },

    /** Worker-side pipeline view (T-603 ai_status aggregate): every job of a recording. */
    async listByRecordingSystem(recordingId, reason) {
      requireSystemReason(reason);
      return exec('processing_job', () => db.select().from(processingJobs)
        .where(eq(processingJobs.recordingId, recordingId)).orderBy(asc(processingJobs.createdAt)));
    },

    /** Admin listing by status (and optionally job type), newest first. */
    async listSystem({ status = null, queue = null, limit = 100 } = {}, reason) {
      requireSystemReason(reason);
      const conds = [];
      if (status) conds.push(eq(processingJobs.status, status));
      if (queue) conds.push(eq(processingJobs.queue, queue));
      const base = db.select().from(processingJobs);
      return exec('processing_job', () => (conds.length ? base.where(and(...conds)) : base)
        .orderBy(desc(processingJobs.createdAt)).limit(limit));
    },
  };
};
