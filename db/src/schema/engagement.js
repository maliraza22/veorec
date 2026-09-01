// Sharing, comments, reactions, viewer sessions, analytics, leads
// (docs/07 §4–§5, docs/13).
'use strict';

const { sql } = require('drizzle-orm');
const { pgTable, text, boolean, integer, bigserial, numeric, jsonb, index, uniqueIndex, check, foreignKey } = require('drizzle-orm/pg-core');
const { citext, tsCol, createdAt, updatedAt } = require('./_types');
const { users } = require('./identity');
const { recordings } = require('./recordings');

// Revocable, optionally expiring/password-protected links (docs/12 §3).
// Only the HASH of the token is stored — the plaintext is shown once.
const shareLinks = pgTable('share_links', {
  id: text('id').primaryKey(),                       // shl_
  recordingId: text('recording_id').notNull().references(() => recordings.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  label: text('label'),
  passwordHash: text('password_hash'),
  expiresAt: tsCol('expires_at'),
  maxViews: integer('max_views'),
  viewCount: integer('view_count').notNull().default(0),
  revokedAt: tsCol('revoked_at'),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('share_links_token_hash_uniq').on(t.tokenHash),
  index('share_links_recording_idx').on(t.recordingId),
  check('share_links_views_chk', sql`${t.viewCount} >= 0 AND (${t.maxViews} IS NULL OR ${t.maxViews} > 0)`),
]);

const comments = pgTable('comments', {
  id: text('id').primaryKey(),                       // cmt_
  recordingId: text('recording_id').notNull().references(() => recordings.id, { onDelete: 'cascade' }),
  parentId: text('parent_id'),                       // self-FK below; one reply level (docs/13 §1)
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  authorName: text('author_name').notNull(),
  body: text('body').notNull(),
  t: numeric('t', { precision: 10, scale: 3 }),      // seconds into the video
  deletedAt: tsCol('deleted_at'),                    // owner moderation
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('comments_recording_created_idx').on(t.recordingId, t.createdAt),
  index('comments_parent_idx').on(t.parentId),
  // Replies cascade with their root comment.
  foreignKey({ name: 'comments_parent_fk', columns: [t.parentId], foreignColumns: [t.id] }).onDelete('cascade'),
  check('comments_body_chk', sql`length(${t.body}) BETWEEN 1 AND 2000`),
  check('comments_t_chk', sql`${t.t} IS NULL OR ${t.t} >= 0`),
]);

const reactions = pgTable('reactions', {
  id: text('id').primaryKey(),                       // rct_
  recordingId: text('recording_id').notNull().references(() => recordings.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  authorName: text('author_name'),
  emoji: text('emoji').notNull(),
  t: numeric('t', { precision: 10, scale: 3 }),
  createdAt: createdAt(),
}, (t) => [
  index('reactions_recording_idx').on(t.recordingId),
  check('reactions_emoji_chk', sql`length(${t.emoji}) BETWEEN 1 AND 8`),
  check('reactions_t_chk', sql`${t.t} IS NULL OR ${t.t} >= 0`),
]);

// One row per unique viewer per recording. Owner views are recorded but never
// counted (`is_owner`), by USER ID rather than display name (docs/13 §3).
const viewSessions = pgTable('view_sessions', {
  id: text('id').primaryKey(),                       // vs_
  recordingId: text('recording_id').notNull().references(() => recordings.id, { onDelete: 'cascade' }),
  viewerUserId: text('viewer_user_id').references(() => users.id, { onDelete: 'set null' }),
  visitorId: text('visitor_id'),
  ipHash: text('ip_hash'),                           // salted daily — never a raw IP
  viewerKey: text('viewer_key').notNull(),           // u:<id> | v:<visitor> | ip:<hash>
  startedAt: createdAt(),
  lastSeenAt: tsCol('last_seen_at'),
  maxProgress: numeric('max_progress', { precision: 4, scale: 3 }).notNull().default('0'),
  completed: boolean('completed').notNull().default(false),
  isOwner: boolean('is_owner').notNull().default(false),
}, (t) => [
  uniqueIndex('view_sessions_recording_viewer_uniq').on(t.recordingId, t.viewerKey),
  index('view_sessions_recording_idx').on(t.recordingId),
  index('view_sessions_viewer_user_idx').on(t.viewerUserId),
  check('view_sessions_progress_chk', sql`${t.maxProgress} >= 0 AND ${t.maxProgress} <= 1`),
]);

// Append-only behavioural log (partition by month if volume demands).
const analyticsEvents = pgTable('analytics_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  recordingId: text('recording_id').references(() => recordings.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  event: text('event').notNull(),
  props: jsonb('props').notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
}, (t) => [
  index('analytics_events_event_created_idx').on(t.event, t.createdAt),
  index('analytics_events_recording_created_idx').on(t.recordingId, t.createdAt),
]);

const leads = pgTable('leads', {
  id: text('id').primaryKey(),                       // led_
  recordingId: text('recording_id').notNull().references(() => recordings.id, { onDelete: 'cascade' }),
  email: citext('email').notNull(),
  name: text('name'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('leads_recording_email_uniq').on(t.recordingId, t.email),
]);

module.exports = { shareLinks, comments, reactions, viewSessions, analyticsEvents, leads };
