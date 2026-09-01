// ─────────────────────────────────────────────────────────────────────────────
// USAGE SERVICE  —  tracks storage / video count / recording minutes per user.
//
// Two layers:
//  • Fast incremental counters (updateUsage) updated on every upload/delete.
//  • Authoritative recalculation (recalculateUsage) from the real source of truth
//    (Cloudinary for prod, local db for dev) — run by cron to heal drift.
//
// Stored in usage.json keyed by userId:
// {
//   userId, storageUsedBytes, videoCount, recordingMinutesUsed,
//   monthlyUploads, monthlyUploadsPeriod (YYYY-MM), lastCalculatedAt
// }
// ─────────────────────────────────────────────────────────────────────────────
const { createKeyedStore } = require('./store');
const dualwrite = require('./dualwrite');   // T-105 PostgreSQL mirror (flag-gated)

const store = createKeyedStore('usage.json');

function currentPeriod() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function blank(userId) {
  return {
    userId,
    storageUsedBytes: 0,
    videoCount: 0,
    recordingMinutesUsed: 0,
    monthlyUploads: 0,
    monthlyUploadsPeriod: currentPeriod(),
    lastCalculatedAt: 0,
  };
}

function get(userId) {
  return store.get(userId) || blank(userId);
}

/**
 * Apply an incremental delta after an upload (positive) or delete (negative).
 * @param {string} userId
 * @param {{ bytes?: number, videos?: number, seconds?: number, upload?: boolean }} delta
 */
function updateUsage(userId, delta = {}) {
  const updated = store.update(userId, (cur) => {
    const u = cur || blank(userId);
    // roll the monthly window
    const period = currentPeriod();
    if (u.monthlyUploadsPeriod !== period) {
      u.monthlyUploadsPeriod = period;
      u.monthlyUploads = 0;
    }
    u.storageUsedBytes = Math.max(0, (u.storageUsedBytes || 0) + (delta.bytes || 0));
    u.videoCount = Math.max(0, (u.videoCount || 0) + (delta.videos || 0));
    u.recordingMinutesUsed = Math.max(0, (u.recordingMinutesUsed || 0) + ((delta.seconds || 0) / 60));
    if (delta.upload) u.monthlyUploads = (u.monthlyUploads || 0) + 1;
    return u;
  });
  // Mirrored as a SNAPSHOT only — PostgreSQL usage is not an enforcement input
  // during T-105 (quota enforcement is T-306).
  dualwrite.usage(userId, updated);
  return updated;
}

/**
 * Authoritative recalculation from the real store. Caller passes a function that
 * returns the user's videos as [{ sizeBytes, durationSeconds }]. Keeps usage.js
 * decoupled from Cloudinary specifics (index.js wires the data source in).
 */
async function recalculateUsage(userId, listVideos) {
  const videos = (await listVideos(userId)) || [];
  let storageUsedBytes = 0;
  let recordingSeconds = 0;
  for (const v of videos) {
    storageUsedBytes += Number(v.sizeBytes || v.size || 0);
    recordingSeconds += Number(v.durationSeconds || v.duration || 0);
  }
  return store.update(userId, (cur) => {
    const u = cur || blank(userId);
    u.storageUsedBytes = storageUsedBytes;
    u.videoCount = videos.length;
    u.recordingMinutesUsed = recordingSeconds / 60;
    u.lastCalculatedAt = Date.now();
    return u;
  });
}

/** Recalculate for every user we know about. Used by the daily cron. */
async function syncUsage(userIds, listVideos) {
  const results = [];
  for (const id of userIds) {
    try { results.push(await recalculateUsage(id, listVideos)); }
    catch (e) { results.push({ userId: id, error: e.message }); }
  }
  return results;
}

/**
 * Human-friendly usage summary against a plan's limits (for the billing page).
 */
function getUsageSummary(userId, plan) {
  const u = get(userId);
  const limitBytes = plan.storageLimitBytes;
  const pct = limitBytes ? Math.min(100, (u.storageUsedBytes / limitBytes) * 100) : 0;
  return {
    storageUsedBytes: u.storageUsedBytes,
    storageLimitBytes: limitBytes,
    storageUsedGB: +(u.storageUsedBytes / (1024 ** 3)).toFixed(2),
    storageLimitGB: plan.storageLimitGB,
    storagePercent: +pct.toFixed(1),
    videoCount: u.videoCount,
    recordingMinutesUsed: Math.round(u.recordingMinutesUsed),
    monthlyUploads: u.monthlyUploads,
    lastCalculatedAt: u.lastCalculatedAt,
  };
}

module.exports = {
  get,
  updateUsage,
  recalculateUsage,
  syncUsage,
  getUsageSummary,
  blank,
};
