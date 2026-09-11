// maintenance.upload_expiry (docs/10 §3, docs/06 §8, docs/16 §4.4) — T-306
//
// Sessions past `expires_at` are marked expired, their storage side is torn
// down (multipart aborted; a single-PUT session's orphaned object deleted), and
// THEIR QUOTA RESERVATION IS RELEASED. This is the healing path for abandoned
// tabs, crashes and server restarts that left a reservation held: a
// reservation lives in PostgreSQL, tied to its session, so nothing is lost by
// a restart and nothing leaks past expiry.
//
// Order per session: storage teardown first (idempotent, safe to repeat), then
// one transaction: usage row lock → session `expired` → reservation `expired`
// → reserved bytes/slot returned. A crash between the two leaves a session
// that the next run simply processes again.
'use strict';

const REASON = 'T-306 maintenance.upload_expiry: expire sessions past expires_at and release their reservations';

/**
 * @param {object} deps
 * @param {() => object} deps.repositories
 * @param {(fn) => Promise} deps.withTransaction
 * @param {object} [deps.storage]   StorageProvider; when absent, storage
 *        teardown is skipped (the rows are still healed)
 * @param {object} [deps.logger]
 * @param {number} [deps.limit]
 * @param {Date}   [deps.now]
 */
async function uploadExpiry({ repositories, withTransaction, storage = null, logger = console, limit = 200, now = new Date() }) {
  const repos = repositories();
  const sessions = await repos.uploads.listExpiredSessionsSystem({ before: now, limit }, REASON);
  const report = { scanned: sessions.length, expired: 0, released: 0, storageErrors: 0, errors: 0 };

  for (const s of sessions) {
    // Storage first. Both operations are idempotent.
    if (storage) {
      try {
        if (s.storageUploadId) await storage.abortMultipartUpload(s.storageKey, s.storageUploadId);
        else if (s.mode === 'single') await storage.deleteObject(s.storageKey);
      } catch (err) {
        report.storageErrors += 1;
        logger.warn && logger.warn({ sessionId: s.id, code: err && err.code }, 'upload_expiry: storage teardown failed; expiring the session anyway');
      }
    }
    try {
      await withTransaction(async (tx) => {
        const scope = { userId: s.userId };
        const row = await tx.usage.getForUpdate(scope);
        const expired = await tx.uploads.expireSessionSystem(s.id, REASON);
        if (!expired) return;                       // raced with a completion/abort — converged
        report.expired += 1;
        const reservation = await tx.uploads.findReservationBySession(scope, s.id);
        if (reservation && reservation.status === 'held') {
          await tx.uploads.settleReservationSystem(reservation.id, 'expired', REASON);
          if (row) {
            await tx.usage.applyDelta(scope, {
              storageReservedBytes: -Math.min(Number(reservation.reservedBytes), Number(row.storageReservedBytes || 0)),
              reservedVideoSlots: -Math.min(Number(reservation.reservedSlots || 1), Number(row.reservedVideoSlots || 0)),
            });
          }
          report.released += 1;
        }
      });
    } catch (err) {
      report.errors += 1;
      logger.warn && logger.warn({ sessionId: s.id, err: err.message }, 'upload_expiry: session expiry failed');
    }
  }
  logger.info && logger.info({ job: 'upload_expiry', ...report }, 'upload_expiry: done');
  return report;
}

module.exports = { uploadExpiry, REASON };
