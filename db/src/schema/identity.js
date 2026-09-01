// Identity: users, auth sessions, workspaces and memberships (docs/07 §2).
'use strict';

const { sql } = require('drizzle-orm');
const { pgTable, text, boolean, index, uniqueIndex, check, primaryKey } = require('drizzle-orm/pg-core');
const { citext, inet, tsCol, createdAt, updatedAt } = require('./_types');

const users = pgTable('users', {
  id: text('id').primaryKey(),                       // usr_
  email: citext('email').notNull(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),               // null for Google-only accounts
  googleId: text('google_id'),
  isAdmin: boolean('is_admin').notNull().default(false),
  // Admin-granted ("comped") plan — highest entitlement priority (docs/16 §2).
  manualPlan: text('manual_plan'),
  manualPlanExpires: tsCol('manual_plan_expires'),
  slackWebhook: text('slack_webhook'),
  paddleCustomerId: text('paddle_customer_id'),
  // Reset tokens are stored HASHED (docs/17 §1 — legacy stored them in clear).
  resetTokenHash: text('reset_token_hash'),
  resetExpires: tsCol('reset_expires'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: tsCol('deleted_at'),
}, (t) => [
  // Live accounts have unique emails; soft-deleted rows keep theirs without
  // blocking re-registration.
  uniqueIndex('users_email_live_uniq').on(t.email).where(sql`deleted_at IS NULL`),
  uniqueIndex('users_google_id_uniq').on(t.googleId),
  index('users_paddle_customer_idx').on(t.paddleCustomerId),
]);

const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),                       // ses_
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),           // sha256 of the opaque token
  client: text('client').notNull(),
  userAgent: text('user_agent'),
  ip: inet('ip'),
  lastUsedAt: tsCol('last_used_at'),
  expiresAt: tsCol('expires_at').notNull(),
  revokedAt: tsCol('revoked_at'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('sessions_token_hash_uniq').on(t.tokenHash),
  index('sessions_user_idx').on(t.userId),
  index('sessions_expires_idx').on(t.expiresAt),
  check('sessions_client_chk', sql`${t.client} IN ('web','extension')`),
]);

const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),                       // ws_
  name: text('name').notNull(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('workspaces_owner_idx').on(t.ownerUserId),
]);

const workspaceMembers = pgTable('workspace_members', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  invitedBy: text('invited_by').references(() => users.id, { onDelete: 'set null' }),
  joinedAt: createdAt(),
}, (t) => [
  primaryKey({ name: 'workspace_members_pk', columns: [t.workspaceId, t.userId] }),
  index('workspace_members_user_idx').on(t.userId),
  check('workspace_members_role_chk', sql`${t.role} IN ('owner','admin','member','viewer')`),
]);

module.exports = { users, sessions, workspaces, workspaceMembers };
