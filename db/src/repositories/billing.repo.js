// Billing: subscriptions and the idempotent webhook event ledger
// (docs/07 §9, docs/16 §6).
//
// Billing state never touches recording state (invariant #15) — nothing in this
// file writes to recordings/usage.
'use strict';

const { and, eq, desc, sql } = require('drizzle-orm');
const { subscriptions, billingEvents } = require('../schema');
const { newId } = require('../ids');
const { exec, NotFoundError } = require('./errors');
const { requireScope, requireSystemReason } = require('./scope');

module.exports = function billingRepos(db) {
  return {
    subscriptions: {
      async getForUser(scope) {
        const { userId } = requireScope(scope);
        const [row] = await exec('subscription', () => db.select().from(subscriptions)
          .where(eq(subscriptions.userId, userId)).limit(1));
        return row || null;
      },

      /** Webhook/reconciliation path: one subscription row per user. */
      async upsertForUserSystem(userId, data, reason) {
        requireSystemReason(reason);
        const values = {
          paddleSubscriptionId: data.paddleSubscriptionId ?? null,
          paddleCustomerId: data.paddleCustomerId ?? null,
          paddlePriceId: data.paddlePriceId ?? null,
          planSlug: data.planSlug,
          status: data.status,
          billingCycle: data.billingCycle ?? null,
          currentPeriodStart: data.currentPeriodStart ?? null,
          currentPeriodEnd: data.currentPeriodEnd ?? null,
          cancelAtPeriodEnd: data.cancelAtPeriodEnd ?? false,
          lastEventAt: data.lastEventAt ?? null,
        };
        const [row] = await exec('subscription', () => db.insert(subscriptions)
          .values({ id: data.id || newId('subscription'), userId, ...values })
          .onConflictDoUpdate({ target: subscriptions.userId, set: values })
          .returning());
        return row;
      },

      async findByPaddleSubscriptionIdSystem(paddleSubscriptionId, reason) {
        requireSystemReason(reason);
        const [row] = await exec('subscription', () => db.select().from(subscriptions)
          .where(eq(subscriptions.paddleSubscriptionId, paddleSubscriptionId)).limit(1));
        return row || null;
      },

      async findByPaddleCustomerIdSystem(paddleCustomerId, reason) {
        requireSystemReason(reason);
        const [row] = await exec('subscription', () => db.select().from(subscriptions)
          .where(eq(subscriptions.paddleCustomerId, paddleCustomerId)).limit(1));
        return row || null;
      },

      async removeSystem(userId, reason) {
        requireSystemReason(reason);
        const rows = await exec('subscription', () => db.delete(subscriptions)
          .where(eq(subscriptions.userId, userId)).returning({ id: subscriptions.id }));
        return rows.length > 0;
      },
    },

    billingEvents: {
      /**
       * Insert-once ledger. `created:false` means this Paddle event id was
       * already recorded — the webhook then acks without re-applying it
       * (docs/16 §6). This is the whole replay defence.
       */
      async recordIfNew({ paddleEventId, eventType, userId = null, payload, occurredAt = null }) {
        const [row] = await exec('billing_event', () => db.insert(billingEvents)
          .values({ paddleEventId, eventType, userId, payload, occurredAt, status: 'received' })
          .onConflictDoNothing({ target: billingEvents.paddleEventId })
          .returning());
        if (row) return { event: row, created: true };
        const [existing] = await exec('billing_event', () => db.select().from(billingEvents)
          .where(eq(billingEvents.paddleEventId, paddleEventId)).limit(1));
        return { event: existing || null, created: false };
      },

      async markProcessed(id, status = 'processed', { error = null } = {}) {
        const [row] = await exec('billing_event', () => db.update(billingEvents)
          .set({ status, error, processedAt: new Date() })
          .where(eq(billingEvents.id, id)).returning());
        if (!row) throw new NotFoundError('billing_event');
        return row;
      },

      async listFailedSystem({ limit = 100 } = {}, reason) {
        requireSystemReason(reason);
        return exec('billing_event', () => db.select().from(billingEvents)
          .where(eq(billingEvents.status, 'failed')).orderBy(desc(billingEvents.createdAt)).limit(limit));
      },
    },
  };
};
