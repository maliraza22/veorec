// Recordings, their physical media assets, and folders (docs/07 §3).
//
// STORAGE-PROVIDER-NEUTRAL BY DESIGN. A recording's media is identified by
// `video_assets.storage_key` — an opaque object key resolved through the
// StorageProvider abstraction (Cloudflare R2 in production, MinIO locally).
// There are deliberately NO provider-specific columns here: no cloudinary_*,
// no bucket names, no URLs. Legacy Cloudinary identifiers needed to backfill
// existing media live in an isolated migration-only table added by T-104 and
// dropped at cutover (docs/07 §13) — never in this model.
'use strict';

const { sql } = require('drizzle-orm');
const { pgTable, text, boolean, integer, bigint, numeric, jsonb, index, uniqueIndex, check } = require('drizzle-orm/pg-core');
const { tsCol, createdAt, updatedAt } = require('./_types');
const { users, workspaces } = require('./identity');
const { processingJobs } = require('./jobs');

const folders = pgTable('folders', {
  id: text('id').primaryKey(),                       // fld_
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('folders_user_name_uniq').on(t.userId, sql`lower(${t.name})`),
]);

// Lifecycle (docs/22): recording → uploading → uploaded → processing → ready,
// with failed / rejected_limit as terminal states.
const recordings = pgTable('recordings', {
  id: text('id').primaryKey(),                       // rec_
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  title: text('title').notNull().default('Untitled Recording'),
  description: text('description').notNull().default(''),
  status: text('status').notNull().default('recording'),
  failureCode: text('failure_code'),
  // FFprobe-verified facts only — never client-reported (invariant #11).
  duration: numeric('duration', { precision: 10, scale: 3 }),
  clientDurationHint: numeric('client_duration_hint', { precision: 10, scale: 3 }),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  width: integer('width'),
  height: integer('height'),
  sourceKind: text('source_kind').notNull(),
  privacy: text('privacy').notNull().default('unlisted'),
  passwordHash: text('password_hash'),
  folderId: text('folder_id').references(() => folders.id, { onDelete: 'set null' }),
  // Virtual (non-destructive) edits applied by the player — docs/14 §1.
  trimStart: numeric('trim_start', { precision: 10, scale: 3 }),
  trimEnd: numeric('trim_end', { precision: 10, scale: 3 }),
  segments: jsonb('segments'),
  chapters: jsonb('chapters'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  audience: jsonb('audience').notNull().default(sql`'{}'::jsonb`),
  cta: jsonb('cta'),
  recommendedSpeed: numeric('recommended_speed', { precision: 3, scale: 2 }),
  animatedThumbnail: boolean('animated_thumbnail').notNull().default(true),
  archived: boolean('archived').notNull().default(false),
  removeBranding: boolean('remove_branding').notNull().default(false),
  // AI runs independently and must never gate playability (invariant #14).
  aiStatus: text('ai_status').notNull().default('none'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: tsCol('deleted_at'),
}, (t) => [
  index('recordings_user_created_idx').on(t.userId, t.createdAt.desc()).where(sql`deleted_at IS NULL`),
  index('recordings_user_folder_idx').on(t.userId, t.folderId),
  index('recordings_status_idx').on(t.status),
  index('recordings_workspace_idx').on(t.workspaceId),
  index('recordings_tags_gin_idx').using('gin', t.tags),
  check('recordings_status_chk', sql`${t.status} IN ('recording','uploading','uploaded','processing','ready','failed','rejected_limit')`),
  check('recordings_privacy_chk', sql`${t.privacy} IN ('public','unlisted','workspace','login','password')`),
  check('recordings_source_kind_chk', sql`${t.sourceKind} IN ('extension','web_upload','render','duplicate')`),
  check('recordings_ai_status_chk', sql`${t.aiStatus} IN ('none','queued','running','done','failed')`),
  check('recordings_duration_chk', sql`${t.duration} IS NULL OR ${t.duration} >= 0`),
  check('recordings_size_chk', sql`${t.sizeBytes} IS NULL OR ${t.sizeBytes} >= 0`),
  check('recordings_speed_chk', sql`${t.recommendedSpeed} IS NULL OR (${t.recommendedSpeed} >= 0.25 AND ${t.recommendedSpeed} <= 4)`),
  // A password-protected recording must actually carry a password hash.
  check('recordings_password_chk', sql`${t.privacy} <> 'password' OR ${t.passwordHash} IS NOT NULL`),
]);

// Physical files. Source assets are IMMUTABLE (invariant #13): edits create new
// derived assets, they never rewrite the original bytes.
const videoAssets = pgTable('video_assets', {
  id: text('id').primaryKey(),                       // ast_
  recordingId: text('recording_id').notNull().references(() => recordings.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  storageKey: text('storage_key').notNull(),         // provider-neutral object key
  status: text('status').notNull().default('pending'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  width: integer('width'),
  height: integer('height'),
  duration: numeric('duration', { precision: 10, scale: 3 }),
  codecVideo: text('codec_video'),
  codecAudio: text('codec_audio'),
  container: text('container'),
  checksum: text('checksum'),                        // e.g. crc32c recorded at upload
  variant: text('variant'),                          // '1080p', '720p', hls rendition…
  immutable: boolean('immutable').notNull().default(false),
  // Only the recording's PRIMARY media bills the user; platform-generated
  // renditions (mp4/hls/poster/captions) never do (docs/16 §4.1).
  countsTowardQuota: boolean('counts_toward_quota').notNull().default(false),
  createdByJobId: text('created_by_job_id').references(() => processingJobs.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('video_assets_storage_key_uniq').on(t.storageKey),
  index('video_assets_recording_kind_idx').on(t.recordingId, t.kind),
  // At most one READY asset per (recording, kind, variant). coalesce() is used
  // because NULL variants would otherwise never collide.
  uniqueIndex('video_assets_ready_variant_uniq')
    .on(t.recordingId, t.kind, sql`coalesce(${t.variant}, '')`)
    .where(sql`status = 'ready'`),
  check('video_assets_kind_chk', sql`${t.kind} IN ('source','mp4','hls','poster','thumbnail','preview_gif','audio','captions_vtt','render_output')`),
  check('video_assets_status_chk', sql`${t.status} IN ('pending','ready','failed')`),
  check('video_assets_size_chk', sql`${t.sizeBytes} IS NULL OR ${t.sizeBytes} >= 0`),
]);

module.exports = { folders, recordings, videoAssets };
