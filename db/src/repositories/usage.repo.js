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

const { eq, sql, isNull } = require('drizzle-orm');
const { usage, users } = require('../schema');
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

// Statuses whose upload has LANDED. In-flight recordings are represented by
// reserved_video_slots, never counted here (see the T-306 note below).
const LANDED_STATUSES = ['uploaded', 'processing', 'ready'];

/** SUM of quota-counting bytes over a user's non-deleted recordings. */
const retainedSql = (userId) => sql`
  SELECT COALESCE(SUM(COALESCE(
    (SELECT SUM(a.size_bytes) FROM video_assets a
      WHERE a.recording_id = r.id AND a.counts_toward_quota AND a.status = 'ready'),
    r.size_bytes, 0)), 0)::bigint
  FROM recordings r WHERE r.user_id = ${userId} AND r.deleted_at IS NULL`;

/** COUNT of a user's landed, non-deleted recordings. */
const activeSql = (userId) => sql`
  SELECT count(*)::int FROM recordings r
  WHERE r.user_id = ${userId} AND r.deleted_at IS NULL
    AND r.status IN (${sql.join(LANDED_STATUSES.map((s) => sql`${s}`), sql`, `)})`;

/** Bytes of soft-deleted recordings awaiting purge (informational). */
const pendingSql = (userId) => sql`
  SELECT COALESCE(SUM(COALESCE(r.size_bytes, 0)), 0)::bigint
  FROM recordings r WHERE r.user_id = ${userId} AND r.deleted_at IS NOT NULL`;

async function liveTotalsFor(db, userId) {
  const res = await exec('usage', () => db.execute(sql`
    SELECT (${retainedSql(userId)}) AS retained,
           (${activeSql(userId)})   AS active,
           (${pendingSql(userId)})  AS pending`));
  const row = (res.rows || res)[0] || {};
  return {
    storageRetainedBytes: Number(row.retained || 0),
    activeVideoCount: Number(row.active || 0),
    storagePendingDeletionBytes: Number(row.pending || 0),
  };
}

/** Raw-SQL RETURNING rows come back snake_case; the repo contract is camelCase. */
function camel(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = typeof v === 'string' && /^\d+$/.test(v) && /bytes|count|slots|seconds|uploads/.test(k) ? Number(v) : v;
  }
  return out;
}

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

    // ── T-306: live totals and the atomic check-and-reserve ─────────────────
    //
    // WHY AGGREGATES, NOT THE COUNTERS. During the dual-write window the legacy
    // mirror (dualwrite.usage → mirrors.upsertUsage) and the T-106 reconciler
    // both OVERWRITE storage_retained_bytes / active_video_count from the legacy
    // JSON totals, so those two columns are a legacy snapshot that erases any
    // v1 contribution. The guard therefore derives retained bytes and active
    // count from the rows themselves — `recordings` (complete for imported,
    // mirrored and v1 recordings alike; `video_assets` would undercount legacy
    // media not yet backfilled) — inside the same single UPDATE. The counters
    // stay maintained as caches (v1 events + usage_sync) and are never the
    // guard's input. storage_reserved_bytes / reserved_video_slots are touched
    // by neither the mirror nor the reconciler, so reservations are authoritative
    // on the row itself.
    //
    // Retained bytes: every non-deleted recording, its ready quota-counting
    // asset bytes if any, else recordings.size_bytes (legacy/imported), else 0.
    // A `failed` recording keeps its bytes (the source exists — Q10); a
    // `recording`/`uploading` row has no size yet and contributes 0 until its
    // completion sets size_bytes — its in-flight bytes are the RESERVATION.
    //
    // Active count: recordings whose upload has landed (uploaded/processing/
    // ready) — in-flight ones are represented by reserved_video_slots, exactly
    // as docs/16 §4.2's arithmetic expects, so a recording is never counted
    // twice (once as a row, once as a slot).

    /** Live, row-derived totals for a user. Safe on a plain connection. */
    async liveTotals(scope) {
      const { userId } = requireScope(scope);
      return liveTotalsFor(db, userId);
    },

    async liveTotalsSystem(userId, reason) {
      requireSystemReason(reason);
      return liveTotalsFor(db, userId);
    },

    /**
     * docs/16 §4.3 — the single guarded UPDATE. Reserves `reserveBytes` and one
     * video slot iff, evaluated atomically against the row and the live
     * aggregates: reserve ≥ minStartBytes, retained + reserved + reserve ≤
     * maxStorageBytes, and (maxActiveVideos null or active + slots + 1 ≤ max).
     * Returns the updated row, or null when the guard refused (no change).
     * Callers hold the row lock via getForUpdate first, so concurrent
     * reservations serialise; the WHERE re-check is defence in depth.
     */
    async reserveGuarded(scope, { reserveBytes, minStartBytes, maxStorageBytes, maxActiveVideos }) {
      const { userId } = requireScope(scope);
      if (!inTransaction()) {
        throw new InvalidStateError('usage', 'reserveGuarded must run inside withTransaction()');
      }
      for (const [k, v] of Object.entries({ reserveBytes, minStartBytes, maxStorageBytes })) {
        if (!Number.isInteger(v) || v < 0) throw new InvalidStateError('usage', `${k} must be a non-negative integer`);
      }
      if (maxActiveVideos !== null && (!Number.isInteger(maxActiveVideos) || maxActiveVideos < 0)) {
        throw new InvalidStateError('usage', 'maxActiveVideos must be null or a non-negative integer');
      }
      const rows = await exec('usage', () => db.execute(sql`
        UPDATE usage SET
          storage_reserved_bytes = storage_reserved_bytes + ${reserveBytes}::bigint,
          reserved_video_slots   = reserved_video_slots + 1,
          updated_at             = now()
        WHERE user_id = ${userId}
          -- Every parameter is cast explicitly. Two untyped parameters compared
          -- to each other resolve as TEXT in PostgreSQL, and '536870912' >=
          -- '67108864' is false lexicographically — a guard that silently
          -- refused every real-sized reservation.
          AND ${reserveBytes}::bigint >= ${minStartBytes}::bigint
          AND (${retainedSql(userId)}) + storage_reserved_bytes + ${reserveBytes}::bigint <= ${maxStorageBytes}::bigint
          AND (${maxActiveVideos}::int IS NULL
               OR (${activeSql(userId)}) + reserved_video_slots + 1 <= ${maxActiveVideos}::int)
        RETURNING *`));
      const row = (rows.rows || rows)[0];
      return row ? camel(row) : null;
    },

    /**
     * Every non-deleted USER — the usage_sync iteration set. Users, not ledger
     * rows: a user who has never opened a session has no row yet, and the sync
     * is what gives them one (ensure) so "every user has exactly one ledger
     * row" holds without depending on the importer or a first upload.
     */
    async listUserIdsSystem(reason) {
      requireSystemReason(reason);
      const rows = await exec('usage', () => db.select({ userId: users.id }).from(users).where(isNull(users.deletedAt)));
      return rows.map((r) => r.userId);
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
