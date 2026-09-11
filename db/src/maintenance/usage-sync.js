// maintenance.usage_sync (docs/10 §3, docs/16 §4.4) — T-306
//
// Re-derives every user's ledger counters from the rows (the same aggregates the
// quota guard evaluates — usage.repo liveTotals), expires orphaned held
// reservations, and logs drift > 1%. The counters are CACHES during the
// dual-write window: the legacy mirror and the reconciler overwrite two of
// them from legacy totals, and this job is what brings them back to what the
// rows say. It never touches storage_reserved_bytes / reserved_video_slots
// except through reservation expiry, because those are authoritative on the
// row itself.
//
// Runs on a plain connection, one short transaction per user, so a crash
// mid-run leaves every user either fully synced or untouched.
'use strict';

const REASON = 'T-306 maintenance.usage_sync: re-derive ledger counters from rows';

/**
 * @param {object} deps
 * @param {() => object} deps.repositories
 * @param {(fn) => Promise} deps.withTransaction
 * @param {object} [deps.logger]
 * @param {number} [deps.driftThresholdPct]  log at or above this (default 1)
 * @param {Date}   [deps.now]
 */
async function usageSync({ repositories, withTransaction, logger = console, driftThresholdPct = 1, now = new Date() }) {
  const repos = repositories();
  const userIds = await repos.usage.listUserIdsSystem(REASON);
  const report = { users: 0, synced: 0, drifted: 0, reservationsExpired: 0, errors: 0, drift: [] };

  // 1. Expire held reservations past their expiry whose session is gone or no
  //    longer open — the healing path for anything upload_expiry missed.
  const stale = await repos.uploads.listHeldReservationsSystem({ before: now, limit: 1000 }, REASON);
  for (const r of stale) {
    try {
      await withTransaction(async (tx) => {
        const scope = { userId: r.userId };
        const row = await tx.usage.getForUpdate(scope);
        const settled = await tx.uploads.settleReservationSystem(r.id, 'expired', REASON);
        if (!settled || !row) return;
        await tx.usage.applyDelta(scope, {
          storageReservedBytes: -Math.min(Number(r.reservedBytes), Number(row.storageReservedBytes || 0)),
          reservedVideoSlots: -Math.min(Number(r.reservedSlots || 1), Number(row.reservedVideoSlots || 0)),
        });
        report.reservationsExpired += 1;
      });
    } catch (err) {
      report.errors += 1;
      logger.warn && logger.warn({ reservationId: r.id, err: err.message }, 'usage_sync: reservation expiry failed');
    }
  }

  // 2. Re-derive the counters per user.
  for (const userId of userIds) {
    report.users += 1;
    try {
      await withTransaction(async (tx) => {
        const scope = { userId };
        await tx.usage.ensure(scope);            // every user has exactly one ledger row
        const before = await tx.usage.getForUpdate(scope);
        if (!before) return;
        const live = await tx.usage.liveTotalsSystem(userId, REASON);
        const drift = pct(Number(before.storageRetainedBytes), live.storageRetainedBytes);
        const countDrift = Number(before.activeVideoCount) !== live.activeVideoCount;
        await tx.usage.setRecalculatedSystem(userId, {
          storageRetainedBytes: live.storageRetainedBytes,
          storagePendingDeletionBytes: live.storagePendingDeletionBytes,
          activeVideoCount: live.activeVideoCount,
          recordingSeconds: Number(before.recordingSeconds || 0),
        }, REASON);
        report.synced += 1;
        if (drift >= driftThresholdPct || countDrift) {
          report.drifted += 1;
          const entry = {
            userId, retainedBefore: Number(before.storageRetainedBytes), retainedAfter: live.storageRetainedBytes,
            driftPct: +drift.toFixed(2), countBefore: Number(before.activeVideoCount), countAfter: live.activeVideoCount,
          };
          report.drift.push(entry);
          logger.warn && logger.warn({ job: 'usage_sync', ...entry }, 'usage_sync: ledger drift corrected');
        }
      });
    } catch (err) {
      report.errors += 1;
      logger.warn && logger.warn({ userId, err: err.message }, 'usage_sync: user sync failed');
    }
  }
  logger.info && logger.info({ job: 'usage_sync', ...report, drift: undefined, driftEntries: report.drift.length }, 'usage_sync: done');
  return report;
}

function pct(before, after) {
  const base = Math.max(before, after, 1);
  return (Math.abs(before - after) / base) * 100;
}

module.exports = { usageSync, REASON };
