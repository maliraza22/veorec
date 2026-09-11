// ─────────────────────────────────────────────────────────────────────────────
// QUOTA — atomic check-and-reserve, reconciliation and release (T-306, docs/16 §4)
//
// The server is authoritative for storage accounting. The client never reports
// sizes or counts that decide anything: the ledger is written from facts the
// server observed (storage HEAD at complete, the rows themselves).
//
// ── WHAT HAPPENS WHERE ──────────────────────────────────────────────────────
//   reserve()     upload-session creation — inside the SAME transaction that
//                 inserts the session: usage row lock → live totals → one
//                 guarded UPDATE (docs/16 §4.3) → storage_reservations row.
//                 Guard failure ⇒ 403 storage_limit | video_limit, no session.
//   reconcile()   completion — inside the completion transaction: retained +=
//                 real size, reserved −= reservation, slots −= 1, active += 1,
//                 reservation `reconciled`.
//   release()     abort/expiry — reserved −= reservation, slots −= 1,
//                 reservation `released` | `expired`.
//   checkAtComplete()  the residual downgrade race (docs/06 §7.5): re-check the
//                 plan with the REAL size under the row lock.
//
// ── THE RESERVATION IS THE BYTE CEILING ─────────────────────────────────────
// reserve = min(plan.maxUploadBytes, available). The recorder stops at it
// (T-303), presigning refuses beyond it and signs each part's exact
// Content-Length (T-301), and completion checks the HEAD size against it
// (T-301) — three layers, docs/16 §4.3a. A user with 300 MiB left can still
// record: their take is capped at 300 MiB, disclosed up front, instead of
// being rejected outright.
//
// ── LIMITS ARE INJECTED ─────────────────────────────────────────────────────
// This module knows no plan catalog and no legacy user store. `resolveLimits`
// returns the active limit set for the caller (server/plans.js `limitsFor`,
// which honours QUOTA_ENFORCEMENT_V2). The algorithm is the same under either
// set; only the integers differ.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { forbidden } = require('./errors');

// docs/16 §4.6 — exact copy, used when the v2 model is active.
const MSG_STORAGE_V2 = 'You\'ve reached your 5 GB free storage limit. Delete a video or upgrade to continue recording.';
const MSG_VIDEOS_V2 = 'You\'ve reached your 50-video free limit. Delete a video or upgrade to continue recording.';

const gib = (n) => `${Math.round((n / (1024 ** 3)) * 10) / 10} GB`;

function storageMessage(limits) {
  if (limits.model === 'v2' && limits.planSlug === 'free') return MSG_STORAGE_V2;
  return `You've reached your ${gib(limits.maxStorageBytes)} storage limit. Delete a video or upgrade to continue recording.`;
}
function videoMessage(limits) {
  if (limits.model === 'v2' && limits.planSlug === 'free') return MSG_VIDEOS_V2;
  return `You've reached your ${limits.maxActiveVideos}-video limit. Delete a video or upgrade to continue recording.`;
}

/** The `meta` every quota denial carries so paywall UIs render real numbers. */
function quotaMeta(limits, totals, row) {
  return {
    usedBytes: totals.storageRetainedBytes,
    reservedBytes: Number(row ? row.storageReservedBytes : 0),
    limitBytes: limits.maxStorageBytes,
    videoCount: totals.activeVideoCount,
    reservedSlots: Number(row ? row.reservedVideoSlots : 0),
    maxVideos: limits.maxActiveVideos,
    plan: limits.planSlug,
  };
}

/**
 * Compute what a new session may reserve. Pure.
 * @returns {{reserveBytes:number, availableBytes:number, availableSlots:number|null}}
 */
function computeReservation(limits, totals, row, { maxBytes = null } = {}) {
  const reserved = Number(row ? row.storageReservedBytes : 0);
  const slots = Number(row ? row.reservedVideoSlots : 0);
  const availableBytes = Math.max(0, limits.maxStorageBytes - totals.storageRetainedBytes - reserved);
  const availableSlots = limits.maxActiveVideos == null
    ? null : Math.max(0, limits.maxActiveVideos - totals.activeVideoCount - slots);
  let reserveBytes = Math.min(limits.maxUploadBytes, availableBytes);
  if (maxBytes != null) reserveBytes = Math.min(reserveBytes, maxBytes);
  return { reserveBytes, availableBytes, availableSlots };
}

/**
 * @param {object} deps
 * @param {(req:object) => Promise<object>|object} deps.resolveLimits  active
 *        limit set for the request's user (see server/plans.js limitsFor)
 * @param {object} [deps.logger]
 */
function createQuota({ resolveLimits, logger = console }) {
  if (typeof resolveLimits !== 'function') throw new Error('createQuota: resolveLimits is required');

  /**
   * Atomic check-and-reserve. MUST be called inside the session-creating
   * transaction, with `tx` the transaction-bound repositories.
   *
   * @param {object} p
   * @param {object} p.tx            transaction-bound repositories
   * @param {object} p.scope
   * @param {object} p.limits        from resolveLimits(req)
   * @param {Date}   p.expiresAt     reservation expiry (= session expiry)
   * @param {number} [p.maxBytes]    a smaller cap for this session (single mode)
   * @param {number} [p.declaredBytes] single mode: the exact size; must fit
   * @returns {{reserveBytes:number, reservation:object}}
   */
  async function reserve({ tx, scope, limits, expiresAt, maxBytes = null, declaredBytes = null }) {
    // Row lock FIRST (ordering rule in usage.repo). Every quota mutation for
    // this user serialises here; the guarded UPDATE re-checks regardless.
    let row = await tx.usage.getForUpdate(scope);
    if (!row) { await tx.usage.ensure(scope); row = await tx.usage.getForUpdate(scope); }
    const totals = await tx.usage.liveTotals(scope);
    const { reserveBytes, availableBytes, availableSlots } = computeReservation(limits, totals, row, { maxBytes });

    // The start floor. minStartBytes refuses a RECORDING of unknown size that
    // could not plausibly fit (docs/16 §4.2). A single-PUT file's size is
    // declared, so its floor is that size: a 3 MiB clip needs 3 MiB, not 64.
    const floor = declaredBytes != null ? declaredBytes : limits.minStartBytes;

    // Report the precise reason, storage first then videos (docs/16 §4.3).
    if (availableBytes < floor || reserveBytes < floor) {
      throw forbidden('storage_limit', storageMessage(limits),
        { upgradeRequired: true, meta: quotaMeta(limits, totals, row) });
    }
    if (declaredBytes != null && declaredBytes > reserveBytes) {
      // Single mode: the whole file must fit inside what can be reserved.
      throw forbidden('storage_limit', storageMessage(limits),
        { upgradeRequired: true, meta: { ...quotaMeta(limits, totals, row), byteCeiling: reserveBytes, sizeBytes: declaredBytes } });
    }
    if (availableSlots !== null && availableSlots < 1) {
      throw forbidden('video_limit', videoMessage(limits),
        { upgradeRequired: true, meta: quotaMeta(limits, totals, row) });
    }

    const updated = await tx.usage.reserveGuarded(scope, {
      reserveBytes, minStartBytes: floor,
      maxStorageBytes: limits.maxStorageBytes, maxActiveVideos: limits.maxActiveVideos,
    });
    if (!updated) {
      // The lock makes this unreachable in practice; if the guard still refuses,
      // report it precisely rather than guessing which condition failed.
      const again = await tx.usage.liveTotals(scope);
      const bytesOk = again.storageRetainedBytes + Number(row.storageReservedBytes) + reserveBytes <= limits.maxStorageBytes;
      throw forbidden(bytesOk ? 'video_limit' : 'storage_limit',
        bytesOk ? videoMessage(limits) : storageMessage(limits),
        { upgradeRequired: true, meta: quotaMeta(limits, again, row) });
    }
    return { reserveBytes, row: updated };
  }

  /** Record the reservation row for a session (same transaction as reserve). */
  async function attach({ tx, scope, uploadSessionId, reserveBytes, expiresAt }) {
    return tx.uploads.createReservation(scope, { uploadSessionId, reservedBytes: reserveBytes, reservedSlots: 1, expiresAt });
  }

  /**
   * Completion reconciliation — inside the completion transaction, AFTER the
   * row lock. A session created before T-306 has no reservation: the retained
   * bytes and the count are still applied, nothing is released.
   */
  async function reconcile({ tx, scope, session, sizeBytes }) {
    const row = await tx.usage.getForUpdate(scope) || await tx.usage.ensure(scope);
    const reservation = await tx.uploads.findReservationBySession(scope, session.id);
    const delta = { storageRetainedBytes: sizeBytes, activeVideoCount: 1 };
    if (reservation && reservation.status === 'held') {
      delta.storageReservedBytes = -Math.min(Number(reservation.reservedBytes), Number(row.storageReservedBytes || 0));
      delta.reservedVideoSlots = -Math.min(Number(reservation.reservedSlots || 1), Number(row.reservedVideoSlots || 0));
      await tx.uploads.settleReservation(scope, reservation.id, 'reconciled', { reconciledBytes: sizeBytes });
    }
    await tx.usage.applyDelta(scope, delta);
    return { reservation };
  }

  /** Abort/expiry release — inside a transaction, AFTER the row lock. Idempotent. */
  async function release({ tx, scope, session, status = 'released' }) {
    const row = await tx.usage.getForUpdate(scope);
    if (!row) return { released: false };
    const reservation = await tx.uploads.findReservationBySession(scope, session.id);
    if (!reservation || reservation.status !== 'held') return { released: false };
    await tx.uploads.settleReservation(scope, reservation.id, status);
    await tx.usage.applyDelta(scope, {
      storageReservedBytes: -Math.min(Number(reservation.reservedBytes), Number(row.storageReservedBytes || 0)),
      reservedVideoSlots: -Math.min(Number(reservation.reservedSlots || 1), Number(row.reservedVideoSlots || 0)),
    });
    return { released: true, reservation };
  }

  /**
   * The residual plan re-check at completion with the REAL size (docs/06 §7.5:
   * a downgrade racing an in-flight upload). Runs under the row lock, so it
   * sees every concurrent reservation. Excludes this recording's own row from
   * the totals: its bytes are what is being decided.
   */
  async function checkAtComplete({ tx, scope, limits, session, sizeBytes }) {
    if (sizeBytes > Number(session.byteCeiling)) {
      return { allowed: false, code: 'storage_limit', message: storageMessage(limits),
        meta: { byteCeiling: Number(session.byteCeiling), actualBytes: sizeBytes, plan: limits.planSlug } };
    }
    const totals = await tx.usage.liveTotals(scope);
    const row = await tx.usage.getForUpdate(scope);
    const reservation = await tx.uploads.findReservationBySession(scope, session.id);
    const own = reservation && reservation.status === 'held' ? Number(reservation.reservedBytes) : 0;
    const otherReserved = Math.max(0, Number(row ? row.storageReservedBytes : 0) - own);
    if (totals.storageRetainedBytes + otherReserved + sizeBytes > limits.maxStorageBytes) {
      return { allowed: false, code: 'storage_limit', message: storageMessage(limits), meta: quotaMeta(limits, totals, row) };
    }
    const ownSlot = reservation && reservation.status === 'held' ? 1 : 0;
    const otherSlots = Math.max(0, Number(row ? row.reservedVideoSlots : 0) - ownSlot);
    if (limits.maxActiveVideos != null && totals.activeVideoCount + otherSlots + 1 > limits.maxActiveVideos) {
      return { allowed: false, code: 'video_limit', message: videoMessage(limits), meta: quotaMeta(limits, totals, row) };
    }
    return { allowed: true };
  }

  /** docs/16 §4.5 — the dual meters. Never a blended percentage. */
  async function meters({ repos, scope, limits }) {
    const totals = await repos.usage.liveTotals(scope);
    // Idempotent: every user has exactly one ledger row, and the first thing
    // that asks for it may be this read.
    const row = await repos.usage.ensure(scope);
    const reserved = Number(row ? row.storageReservedBytes : 0);
    const fmt = (b) => `${(b / (1024 ** 3)).toFixed(1).replace(/\.0$/, '')} GB`;
    return {
      storage: {
        usedBytes: totals.storageRetainedBytes,
        reservedBytes: reserved,
        limitBytes: limits.maxStorageBytes,
        pendingDeletionBytes: totals.storagePendingDeletionBytes,
        display: `${fmt(totals.storageRetainedBytes)} / ${fmt(limits.maxStorageBytes)}`,
      },
      videos: {
        count: totals.activeVideoCount,
        reserved: Number(row ? row.reservedVideoSlots : 0),
        max: limits.maxActiveVideos,
        display: limits.maxActiveVideos == null
          ? `${totals.activeVideoCount}` : `${totals.activeVideoCount} / ${limits.maxActiveVideos}`,
      },
      recordingLimitSeconds: limits.maxRecordingDurationSeconds,
      maxResolution: limits.maxResolution && limits.maxResolution.height >= 2160 ? '4k' : '1080p',
      maxUploadBytes: limits.maxUploadBytes,
      minStartBytes: limits.minStartBytes,
      model: limits.model,
    };
  }

  return { resolveLimits, reserve, attach, reconcile, release, checkAtComplete, meters, computeReservation };
}

module.exports = {
  createQuota, computeReservation, quotaMeta, storageMessage, videoMessage,
  MSG_STORAGE_V2, MSG_VIDEOS_V2,
};
