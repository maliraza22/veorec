// Upload sessions, parts, and quota reservations (docs/07 §3/§9, docs/06).
//
// These tables make uploads resumable and idempotent, and make the free-plan
// quota enforceable atomically. The application server never receives video
// bytes: clients PUT parts straight to object storage using presigned URLs;
// these rows are the coordination record (docs/06).
'use strict';

const { sql } = require('drizzle-orm');
const { pgTable, text, integer, bigint, index, uniqueIndex, check, primaryKey } = require('drizzle-orm/pg-core');
const { tsCol, createdAt, updatedAt, lazyRef } = require('./_types');
const { users } = require('./identity');
const { recordings } = require('./recordings');

const uploadSessions = pgTable('upload_sessions', {
  id: text('id').primaryKey(),                       // up_
  recordingId: text('recording_id').notNull().references(() => recordings.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  storageKey: text('storage_key').notNull(),         // provider-neutral target key
  storageUploadId: text('storage_upload_id'),        // S3/R2 multipart UploadId
  mode: text('mode').notNull().default('multipart'),
  partSize: integer('part_size').notNull(),
  // This session's hard byte ceiling = the quota reserved for it (docs/16 §4.3a).
  byteCeiling: bigint('byte_ceiling', { mode: 'number' }).notNull(),
  clientMime: text('client_mime'),                   // a hint only — FFprobe decides
  status: text('status').notNull().default('pending'),
  idempotencyKey: text('idempotency_key').notNull(),
  expiresAt: tsCol('expires_at').notNull(),
  completedAt: tsCol('completed_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  // Retrying session creation returns the same session instead of reserving
  // quota twice (docs/06 §3).
  uniqueIndex('upload_sessions_user_idempotency_uniq').on(t.userId, t.idempotencyKey),
  // At most one live session per recording.
  uniqueIndex('upload_sessions_recording_active_uniq').on(t.recordingId)
    .where(sql`status IN ('pending','active')`),
  index('upload_sessions_status_expires_idx').on(t.status, t.expiresAt),
  index('upload_sessions_user_idx').on(t.userId),
  check('upload_sessions_mode_chk', sql`${t.mode} IN ('multipart','single')`),
  check('upload_sessions_status_chk', sql`${t.status} IN ('pending','active','completed','aborted','expired')`),
  check('upload_sessions_part_size_chk', sql`${t.partSize} > 0`),
  check('upload_sessions_ceiling_chk', sql`${t.byteCeiling} > 0`),
]);

const uploadParts = pgTable('upload_parts', {
  uploadSessionId: text('upload_session_id').notNull().references(() => uploadSessions.id, { onDelete: 'cascade' }),
  partNumber: integer('part_number').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  etag: text('etag'),
  crc32c: text('crc32c'),
  status: text('status').notNull().default('pending'),
  uploadedAt: tsCol('uploaded_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  primaryKey({ name: 'upload_parts_pk', columns: [t.uploadSessionId, t.partNumber] }),
  // S3 multipart numbering: 1..10000.
  check('upload_parts_number_chk', sql`${t.partNumber} >= 1 AND ${t.partNumber} <= 10000`),
  check('upload_parts_size_chk', sql`${t.size} >= 0`),
  check('upload_parts_status_chk', sql`${t.status} IN ('pending','uploaded')`),
]);

// One row per in-flight upload/render holding quota. Created inside the same
// transaction as the guarded UPDATE on `usage` (docs/16 §4.3) — that pairing is
// what makes two concurrent uploads unable to double-spend the same bytes.
const storageReservations = pgTable('storage_reservations', {
  id: text('id').primaryKey(),                       // rsv_
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  uploadSessionId: text('upload_session_id').references(() => uploadSessions.id, { onDelete: 'cascade' }),
  renderJobId: text('render_job_id').references(lazyRef('./editing', 'renderJobs'), { onDelete: 'set null' }),
  reservedBytes: bigint('reserved_bytes', { mode: 'number' }).notNull(),
  reservedSlots: integer('reserved_slots').notNull().default(1),
  status: text('status').notNull().default('held'),
  reconciledBytes: bigint('reconciled_bytes', { mode: 'number' }),
  expiresAt: tsCol('expires_at').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  // Exactly one open reservation per upload session.
  uniqueIndex('storage_reservations_upload_session_uniq').on(t.uploadSessionId),
  index('storage_reservations_status_expires_idx').on(t.status, t.expiresAt),
  index('storage_reservations_user_idx').on(t.userId),
  check('storage_reservations_status_chk', sql`${t.status} IN ('held','reconciled','released','expired')`),
  check('storage_reservations_bytes_chk', sql`${t.reservedBytes} >= 0 AND (${t.reconciledBytes} IS NULL OR ${t.reconciledBytes} >= 0)`),
  check('storage_reservations_slots_chk', sql`${t.reservedSlots} >= 0`),
  // A reservation belongs to an upload or a render — never both, never neither.
  check('storage_reservations_owner_chk',
    sql`(${t.uploadSessionId} IS NOT NULL AND ${t.renderJobId} IS NULL) OR (${t.uploadSessionId} IS NULL AND ${t.renderJobId} IS NOT NULL)`),
]);

module.exports = { uploadSessions, uploadParts, storageReservations };
