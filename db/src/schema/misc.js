// Contact inbox, notification read-state, audit log (docs/07 §10).
'use strict';

const { sql } = require('drizzle-orm');
const { pgTable, text, bigserial, jsonb, index, check } = require('drizzle-orm/pg-core');
const { inet, tsCol, createdAt, updatedAt } = require('./_types');
const { users } = require('./identity');

const contacts = pgTable('contacts', {
  id: text('id').primaryKey(),                       // ctc_
  name: text('name').notNull(),
  email: text('email').notNull(),
  subject: text('subject'),
  message: text('message').notNull(),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('new'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('contacts_status_created_idx').on(t.status, t.createdAt),
  check('contacts_status_chk', sql`${t.status} IN ('new','read','replied','archived')`),
]);

// The activity feed itself is derived by query from comments/reactions/
// view_sessions — only the read watermark is stored.
const notificationReads = pgTable('notification_reads', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  lastReadAt: tsCol('last_read_at').notNull(),
  updatedAt: updatedAt(),
});

// Every admin mutation and every destructive user action (docs/17 §3).
const auditLogs = pgTable('audit_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  detail: jsonb('detail'),
  ip: inet('ip'),
  createdAt: createdAt(),
}, (t) => [
  index('audit_logs_actor_created_idx').on(t.actorUserId, t.createdAt),
  index('audit_logs_action_created_idx').on(t.action, t.createdAt),
  index('audit_logs_target_idx').on(t.targetType, t.targetId),
]);

module.exports = { contacts, notificationReads, auditLogs };
