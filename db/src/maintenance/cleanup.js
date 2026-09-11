// maintenance.cleanup (docs/10 §3, docs/09 §10, docs/16 §4.4) — T-602
//
//   1. Soft-deleted recordings past the 30-day retention: delete their storage
//      objects (listed from video_assets), then — in one transaction under the
//      usage row lock — return the bytes from `storage_pending_deletion_bytes`
//      and hard-delete the row (assets/jobs cascade). Objects first, rows
//      second: a crash in between leaves a row the next run simply reprocesses
//      (deleting a missing object is a no-op), never an orphaned object.
//   2. `rejected_limit` recordings past the 7-day grace: objects, then row. They
//      never counted toward quota, so no ledger movement.
//   3. Expired / revoked auth sessions: dropped.
//   4. Orphan scan (weekly, `orphanScan:true`): objects under `sources/` with no
//      video_assets row and older than 7 days are REPORTED, never deleted —
//      docs/09 §10: "report first run, delete after manual confirmation during
//      migration".
//
// Idempotent: a second run over the same state changes nothing and reports 0.
'use strict';

const REASON = 'T-602 maintenance.cleanup: purge soft-deleted past retention, rejected_limit past grace, expired sessions; orphan report';
const DAY = 24 * 60 * 60 * 1000;

/**
 * @param {object} deps
 * @param {() => object} deps.repositories
 * @param {(fn) => Promise} deps.withTransaction
 * @param {object} [deps.storage]        StorageProvider; without it, rows that
 *        still own objects are LEFT for a run that can delete them
 * @param {object} [deps.logger]
 * @param {Date}   [deps.now]
 * @param {number} [deps.retentionDays]     soft-delete retention (30)
 * @param {number} [deps.rejectedGraceDays] rejected_limit grace (7)
 * @param {boolean}[deps.orphanScan]        run the report-only orphan scan
 * @param {number} [deps.orphanMinAgeDays]  objects younger than this are never orphans (7)
 * @param {number} [deps.orphanMaxObjects]  scan cap (5000)
 * @param {number} [deps.limit]             rows per category per run (200)
 */
async function cleanup({
  repositories, withTransaction, storage = null, logger = console, now = new Date(),
  retentionDays = 30, rejectedGraceDays = 7, orphanScan = false, orphanMinAgeDays = 7, orphanMaxObjects = 5000, limit = 200,
}) {
  const repos = repositories();
  const report = {
    purged: 0, purgedBytes: 0, rejectedPurged: 0, sessionsPurged: 0,
    objectsDeleted: 0, skippedNoStorage: 0, storageErrors: 0, errors: 0,
    orphanScan: !!orphanScan, orphansScanned: 0, orphans: 0, orphanBytes: 0, orphanSample: [],
  };

  // Delete every object a recording owns. Returns false when the row must be
  // kept for a later run (storage unavailable or a delete failed).
  async function deleteObjects(recordingId, keys) {
    if (keys.length === 0) return true;
    if (!storage) { report.skippedNoStorage += 1; return false; }
    for (const key of keys) {
      try {
        await storage.deleteObject(key);
        report.objectsDeleted += 1;
      } catch (err) {
        if (err && err.code === 'object_not_found') continue;
        report.storageErrors += 1;
        logger.warn({ recording_id: recordingId, key, err: { message: err && err.message } }, 'cleanup: object delete failed — row kept for the next run');
        return false;
      }
    }
    return true;
  }

  // 1. Soft-deleted past retention.
  const purgeable = await repos.recordings.listPurgeableSystem({ before: new Date(now.getTime() - retentionDays * DAY), limit }, REASON);
  for (const rec of purgeable) {
    try {
      const assets = await repos.assets.listByRecordingSystem(rec.id, REASON);
      const keys = [...new Set(assets.map((a) => a.storageKey).filter(Boolean))];
      if (!(await deleteObjects(rec.id, keys))) continue;
      const bytes = assets.filter((a) => a.countsTowardQuota).reduce((s, a) => s + Number(a.sizeBytes || 0), 0);
      await withTransaction(async (tx) => {
        if (bytes > 0) {
          let row = null;
          try { row = await tx.usage.getForUpdate({ userId: rec.userId }); } catch (err) { if (!(err && err.code === 'not_found')) throw err; }
          if (row) {
            // docs/16 §4.4: pending_deletion −= bytes as objects are actually
            // removed; clamped so a never-incremented ledger cannot go negative.
            const dec = Math.min(bytes, Number(row.storagePendingDeletionBytes || 0));
            if (dec > 0) await tx.usage.applyDelta({ userId: rec.userId }, { storagePendingDeletionBytes: -dec });
          }
        }
        await tx.recordings.hardDeleteSystem(rec.id, REASON);
      });
      report.purged += 1;
      report.purgedBytes += bytes;
      logger.info({ recording_id: rec.id, user_id: rec.userId, bytes, objects: keys.length }, 'cleanup: soft-deleted recording purged');
    } catch (err) {
      report.errors += 1;
      logger.warn({ recording_id: rec.id, err: { message: err && err.message } }, 'cleanup: purge failed');
    }
  }

  // 2. rejected_limit past grace.
  const rejected = await repos.recordings.listRejectedSystem({ before: new Date(now.getTime() - rejectedGraceDays * DAY), limit }, REASON);
  for (const rec of rejected) {
    try {
      const assets = await repos.assets.listByRecordingSystem(rec.id, REASON);
      const keys = [...new Set(assets.map((a) => a.storageKey).filter(Boolean))];
      if (!(await deleteObjects(rec.id, keys))) continue;
      await repos.recordings.hardDeleteSystem(rec.id, REASON);
      report.rejectedPurged += 1;
      logger.info({ recording_id: rec.id, user_id: rec.userId }, 'cleanup: rejected_limit recording purged');
    } catch (err) {
      report.errors += 1;
      logger.warn({ recording_id: rec.id, err: { message: err && err.message } }, 'cleanup: rejected purge failed');
    }
  }

  // 3. Expired auth sessions.
  try {
    report.sessionsPurged = await repos.sessions.deleteExpiredSystem(REASON, now);
  } catch (err) {
    report.errors += 1;
    logger.warn({ err: { message: err && err.message } }, 'cleanup: session purge failed');
  }

  // 4. Orphan report (never deletes).
  if (orphanScan && storage) {
    try {
      const cutoff = now.getTime() - orphanMinAgeDays * DAY;
      let token = null;
      do {
        const page = await storage.listObjects('sources/', { maxKeys: 1000, ...(token ? { continuationToken: token } : {}) });
        const old = page.objects.filter((o) => o.lastModified && new Date(o.lastModified).getTime() < cutoff);
        report.orphansScanned += page.objects.length;
        if (old.length) {
          const known = await repos.assets.existingKeysSystem(old.map((o) => o.key), REASON);
          for (const o of old) {
            if (known.has(o.key)) continue;
            report.orphans += 1;
            report.orphanBytes += Number(o.size || 0);
            if (report.orphanSample.length < 50) report.orphanSample.push({ key: o.key, size: o.size, lastModified: o.lastModified });
          }
        }
        token = page.truncated ? page.continuationToken : null;
      } while (token && report.orphansScanned < orphanMaxObjects);
      if (report.orphans) logger.warn({ orphans: report.orphans, bytes: report.orphanBytes }, 'cleanup: orphan objects found (report only — docs/09 §10)');
    } catch (err) {
      report.errors += 1;
      logger.warn({ err: { message: err && err.message } }, 'cleanup: orphan scan failed');
    }
  }

  return report;
}

module.exports = { cleanup, REASON };
