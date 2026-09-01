// Usage — the per-user quota ledger (docs/07 §9, docs/16 §4).
//
// T-103 provides the LEDGER PRIMITIVES only. The atomic check-and-reserve
// algorithm (docs/16 §4.3) is T-306 and will be added here as a dedicated
// method — `getForUpdate` + `applyDelta` already give it everything it needs, so
// it will never have to bypass this layer with ad-hoc SQL.
//
// Ordering rule for T-306: take the `usage` row lock FIRST, then write
// reservations/sessions in the same transaction. The row is the per-user lock.
'use strict';

const { eq, sql } = require('drizzle-orm');
const { usage } = require('../schema');
const { exec, NotFoundError, InvalidStateError } = require('./errors');
const { requireScope, requireSystemReason } = require('./scope');

const COUNTERS = {
  storageRetainedBytes: usage.storageRetainedBytes,
  storageReservedBytes: usage.storageReservedBytes,
  storagePendingDeletionBytes: usage.storagePendingDeletionBytes,
  activeVideoCount: usage.activeVideoCount,
  reservedVideoSlots: usage.reservedVideoSlots,
  recordingSeconds: usage.recordingSeconds,
  monthlyUploads: usage.monthlyUploads,
};

module.exports = function usageRepo(db) {
  // A drizzle transaction object exposes rollback(); the pool wrapper does not.
  const inTransaction = () => typeof db.rollback === 'function';

  return {
    async get(scope) {
      const { userId } = requireScope(scope);
      const [row] = await exec('usage', () =>
        db.select().from(usage).where(eq(usage.userId, userId)).limit(1));
      return row || null;
    },

    /** Idempotent: every user has exactly one ledger row. */
    async ensure(scope) {
      const { userId } = requireScope(scope);
      const [row] = await exec('usage', () => db.insert(usage).values({ userId })
        .onConflictDoNothing({ target: usage.userId }).returning());
      return row || this.get(scope);
    },

    /**
     * SELECT … FOR UPDATE — serialises every quota mutation for this user.
     * Refuses outside a transaction: a lock taken on a pooled connection would
     * be released immediately and silently provide no mutual exclusion.
     */
    async getForUpdate(scope) {
      const { userId } = requireScope(scope);
      if (!inTransaction()) {
        throw new InvalidStateError('usage',
          'getForUpdate must run inside withTransaction() — a row lock outside a transaction is meaningless');
      }
      const [row] = await exec('usage', () =>
        db.select().from(usage).where(eq(usage.userId, userId)).for('update').limit(1));
      return row || null;
    },

    /**
     * Apply signed deltas to ledger counters. CHECK constraints reject any
     * delta that would drive a counter negative (surfaces as
     * constraint_violation, never a silently clamped value).
     */
    async applyDelta(scope, delta = {}) {
      const { userId } = requireScope(scope);
      const set = {};
      for (const [key, column] of Object.entries(COUNTERS)) {
        const amount = delta[key];
        if (amount === undefined || amount === 0) continue;
        if (!Number.isFinite(amount)) throw new InvalidStateError('usage', `delta.${key} must be a finite number`);
        set[key] = sql`${column} + ${amount}`;
      }
      if (Object.keys(set).length === 0) return this.get(scope);
      const [row] = await exec('usage', () =>
        db.update(usage).set(set).where(eq(usage.userId, userId)).returning());
      if (!row) throw new NotFoundError('usage');
      return row;
    },

    /** Nightly reconciliation (usage_sync) writes authoritative totals. */
    async setRecalculatedSystem(userId, totals, reason) {
      requireSystemReason(reason);
      const [row] = await exec('usage', () => db.update(usage).set({
        storageRetainedBytes: totals.storageRetainedBytes,
        storagePendingDeletionBytes: totals.storagePendingDeletionBytes,
        activeVideoCount: totals.activeVideoCount,
        recordingSeconds: totals.recordingSeconds,
        lastRecalculatedAt: new Date(),
      }).where(eq(usage.userId, userId)).returning());
      if (!row) throw new NotFoundError('usage');
      return row;
    },
  };
};
