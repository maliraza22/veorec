// Billing, entitlements and the quota ledger (docs/07 §9, docs/16).
'use strict';

const { sql } = require('drizzle-orm');
const { pgTable, text, boolean, integer, bigint, bigserial, jsonb, index, uniqueIndex, check } = require('drizzle-orm/pg-core');
const { tsCol, createdAt, updatedAt } = require('./_types');
const { users } = require('./identity');

const subscriptions = pgTable('subscriptions', {
  id: text('id').primaryKey(),                       // sub_
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  paddleSubscriptionId: text('paddle_subscription_id'),
  paddleCustomerId: text('paddle_customer_id'),
  paddlePriceId: text('paddle_price_id'),
  planSlug: text('plan_slug').notNull(),
  status: text('status').notNull(),
  billingCycle: text('billing_cycle'),
  currentPeriodStart: tsCol('current_period_start'),
  currentPeriodEnd: tsCol('current_period_end'),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  // Guards against out-of-order webhooks resurrecting a cancelled sub (docs/16 §6).
  lastEventAt: tsCol('last_event_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('subscriptions_user_uniq').on(t.userId),          // one per user
  uniqueIndex('subscriptions_paddle_sub_uniq').on(t.paddleSubscriptionId),
  index('subscriptions_status_idx').on(t.status),
  check('subscriptions_status_chk', sql`${t.status} IN ('active','trialing','past_due','paused','canceled')`),
  check('subscriptions_cycle_chk', sql`${t.billingCycle} IS NULL OR ${t.billingCycle} IN ('monthly','yearly')`),
]);

// Idempotent webhook ledger: a duplicate Paddle event id can never be applied
// twice, and a processing failure is recorded rather than silently 200-acked.
const billingEvents = pgTable('billing_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  paddleEventId: text('paddle_event_id').notNull(),
  eventType: text('event_type').notNull(),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('received'),
  error: text('error'),
  occurredAt: tsCol('occurred_at'),
  processedAt: tsCol('processed_at'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('billing_events_paddle_event_uniq').on(t.paddleEventId),
  index('billing_events_status_idx').on(t.status),
  check('billing_events_status_chk', sql`${t.status} IN ('received','processed','failed','skipped')`),
]);

// THE QUOTA LEDGER. One row per user; the row is the lock. Enforcement is a
// single guarded UPDATE (docs/16 §4.3), which is what makes concurrent uploads
// unable to double-spend quota. Counters can never go negative (CHECKs below).
const usage = pgTable('usage', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  storageRetainedBytes: bigint('storage_retained_bytes', { mode: 'number' }).notNull().default(0),
  storageReservedBytes: bigint('storage_reserved_bytes', { mode: 'number' }).notNull().default(0),
  storagePendingDeletionBytes: bigint('storage_pending_deletion_bytes', { mode: 'number' }).notNull().default(0),
  activeVideoCount: integer('active_video_count').notNull().default(0),
  reservedVideoSlots: integer('reserved_video_slots').notNull().default(0),
  recordingSeconds: bigint('recording_seconds', { mode: 'number' }).notNull().default(0),
  monthlyUploads: integer('monthly_uploads').notNull().default(0),
  monthlyPeriod: text('monthly_period'),             // YYYY-MM
  lastRecalculatedAt: tsCol('last_recalculated_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  check('usage_retained_chk', sql`${t.storageRetainedBytes} >= 0`),
  check('usage_reserved_chk', sql`${t.storageReservedBytes} >= 0`),
  check('usage_pending_chk', sql`${t.storagePendingDeletionBytes} >= 0`),
  check('usage_video_count_chk', sql`${t.activeVideoCount} >= 0`),
  check('usage_slots_chk', sql`${t.reservedVideoSlots} >= 0`),
  check('usage_seconds_chk', sql`${t.recordingSeconds} >= 0`),
  check('usage_monthly_uploads_chk', sql`${t.monthlyUploads} >= 0`),
]);

// Admin-editable plan limits/prices. The plan CATALOG itself stays in code
// (versioned logic); only overrides are data.
const planOverrides = pgTable('plan_overrides', {
  planSlug: text('plan_slug').primaryKey(),
  overrides: jsonb('overrides').notNull().default(sql`'{}'::jsonb`),
  updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
});

module.exports = { subscriptions, billingEvents, usage, planOverrides };
