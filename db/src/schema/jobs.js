// Background processing jobs (docs/07 §8, docs/10).
//
// This table is the DURABLE TRUTH for job status; the queue (Redis/BullMQ) is
// only transport. Rows are written transactionally with the mutation that
// causes them (outbox pattern, docs/10 §3), so a Redis loss cannot lose work.
'use strict';

const { sql } = require('drizzle-orm');
const { pgTable, text, integer, jsonb, index, uniqueIndex, check } = require('drizzle-orm/pg-core');
const { tsCol, createdAt, updatedAt, lazyRef } = require('./_types');

const QUEUES = [
  'probe', 'transcode', 'thumbnail', 'hls', 'audio_extract', 'captions',
  'transcribe', 'translate', 'ai_title', 'ai_summary', 'ai_chapters',
  'render', 'silence_detect', 'cleanup', 'usage_sync', 'subscription_sync', 'upload_expiry', 'email',
];

const processingJobs = pgTable('processing_jobs', {
  id: text('id').primaryKey(),                       // job_
  queue: text('queue').notNull(),
  // Lazy reference: recordings.js requires this module, so resolving the target
  // here at load time would create a CommonJS cycle.
  recordingId: text('recording_id').references(lazyRef('./recordings', 'recordings'), { onDelete: 'cascade' }),
  // Makes a logical job impossible to run twice (e.g. `probe:rec_x`) — the
  // idempotency backbone of docs/10 §1.
  dedupeKey: text('dedupe_key').notNull(),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  status: text('status').notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  lastError: text('last_error'),
  result: jsonb('result'),
  enqueuedAt: tsCol('enqueued_at'),
  startedAt: tsCol('started_at'),
  finishedAt: tsCol('finished_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('processing_jobs_dedupe_key_uniq').on(t.dedupeKey),
  index('processing_jobs_status_idx').on(t.status),
  index('processing_jobs_recording_idx').on(t.recordingId),
  index('processing_jobs_queue_status_idx').on(t.queue, t.status),
  // Outbox relay scan: rows committed but not yet handed to the queue.
  index('processing_jobs_outbox_idx').on(t.createdAt).where(sql`enqueued_at IS NULL AND status = 'queued'`),
  check('processing_jobs_queue_chk', sql`${t.queue} IN ('probe','transcode','thumbnail','hls','audio_extract','captions','transcribe','translate','ai_title','ai_summary','ai_chapters','render','silence_detect','cleanup','usage_sync','subscription_sync','upload_expiry','email')`),
  check('processing_jobs_status_chk', sql`${t.status} IN ('queued','active','completed','failed','cancelled')`),
  check('processing_jobs_attempts_chk', sql`${t.attempts} >= 0 AND ${t.maxAttempts} >= 1`),
]);

module.exports = { processingJobs, QUEUES };
