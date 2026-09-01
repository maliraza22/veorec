// Editing: edit sessions (the EDL), the operation log, and render jobs
// (docs/07 §7, docs/14).
//
// Edits are structured operations over an IMMUTABLE source. Rendering happens
// only on explicit export; "overwrite" repoints which derived asset is active
// and never rewrites the original bytes (invariant #13).
'use strict';

const { sql } = require('drizzle-orm');
const { pgTable, text, integer, bigserial, jsonb, index, uniqueIndex, check } = require('drizzle-orm/pg-core');
const { createdAt, updatedAt } = require('./_types');
const { users } = require('./identity');
const { recordings, videoAssets } = require('./recordings');
const { processingJobs } = require('./jobs');

const editSessions = pgTable('edit_sessions', {
  id: text('id').primaryKey(),                       // eds_
  recordingId: text('recording_id').notNull().references(() => recordings.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('draft'),
  // Materialised current timeline: ordered clips [{recordingId,start,end}].
  timeline: jsonb('timeline').notNull().default(sql`'[]'::jsonb`),
  mode: text('mode'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('edit_sessions_recording_idx').on(t.recordingId),
  index('edit_sessions_user_idx').on(t.userId),
  // Only one render may be in flight per recording (docs/14 §3).
  uniqueIndex('edit_sessions_rendering_uniq').on(t.recordingId).where(sql`status = 'rendering'`),
  check('edit_sessions_status_chk', sql`${t.status} IN ('draft','rendering','applied','discarded')`),
  check('edit_sessions_mode_chk', sql`${t.mode} IS NULL OR ${t.mode} IN ('overwrite','copy')`),
]);

// Append-only op log powering undo/redo and audit.
const editOperations = pgTable('edit_operations', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  editSessionId: text('edit_session_id').notNull().references(() => editSessions.id, { onDelete: 'cascade' }),
  idx: integer('idx').notNull(),
  op: jsonb('op').notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('edit_operations_session_idx_uniq').on(t.editSessionId, t.idx),
  check('edit_operations_idx_chk', sql`${t.idx} >= 0`),
]);

const renderJobs = pgTable('render_jobs', {
  id: text('id').primaryKey(),                       // rnd_
  editSessionId: text('edit_session_id').notNull().references(() => editSessions.id, { onDelete: 'cascade' }),
  processingJobId: text('processing_job_id').references(() => processingJobs.id, { onDelete: 'set null' }),
  outputRecordingId: text('output_recording_id').references(() => recordings.id, { onDelete: 'set null' }),
  outputAssetId: text('output_asset_id').references(() => videoAssets.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('queued'),
  error: text('error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('render_jobs_edit_session_idx').on(t.editSessionId),
  index('render_jobs_status_idx').on(t.status),
  check('render_jobs_status_chk', sql`${t.status} IN ('queued','running','done','failed')`),
]);

module.exports = { editSessions, editOperations, renderJobs };
