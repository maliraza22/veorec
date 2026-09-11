// ─────────────────────────────────────────────────────────────────────────────
// CRON  —  lightweight in-process daily jobs for the LEGACY stores only.
//
//   dailyUsageSync()          recompute the legacy usage store from Cloudinary/JSON
//   dailySubscriptionSync()   reconcile each subscription with Paddle (writes the
//                             legacy JSON subscription store)
//   dailyStorageVerification() flag accounts over their storage limit (legacy stores)
//
// These three read and write the JSON stores that only THIS process may write,
// so they stay here until billing/usage live in PostgreSQL (docs/23 Phase 9–13)
// and this file is deleted in Phase 14. Every PostgreSQL-side maintenance job
// (usage_sync, upload_expiry, cleanup, storage verification) runs in the worker
// as a queue job since T-602 (docs/10 §3) — nothing v1 is scheduled here.
//
// Runs on a 24h interval after a short startup delay. Safe to no-op when billing
// or Cloudinary isn't configured. For multi-instance deploys, gate with a lock
// or move these to a real scheduler — documented in the deployment guide.
// ─────────────────────────────────────────────────────────────────────────────
const usageService = require('./usage.service');
const billingService = require('./billing.service');
const subscriptions = require('./subscriptions');
const entitlements = require('./entitlements');

const DAY = 24 * 60 * 60 * 1000;

/**
 * @param {object} deps
 * @param {() => object[]} deps.listUsers          all users
 * @param {(userId:string) => Promise<object[]>} deps.listVideos  user's videos
 */
function start(deps) {
  const { listUsers, listVideos } = deps;

  async function dailyUsageSync() {
    const ids = listUsers().map((u) => u.id);
    const res = await usageService.syncUsage(ids, listVideos);
    console.log(`[cron] dailyUsageSync: recalculated ${res.length} users`);
    return res;
  }

  async function dailySubscriptionSync() {
    let synced = 0;
    for (const sub of subscriptions.all()) {
      if (!sub.paddleSubscriptionId) continue;
      const r = await billingService.syncSubscription({ id: sub.userId });
      if (r.ok) synced++;
    }
    console.log(`[cron] dailySubscriptionSync: reconciled ${synced} subscriptions`);
    return synced;
  }

  function dailyStorageVerification() {
    const flagged = [];
    for (const u of listUsers()) {
      const plan = entitlements.resolve(u);
      const usage = usageService.get(u.id);
      if (usage.storageUsedBytes > plan.storageLimitBytes) {
        flagged.push({ userId: u.id, used: usage.storageUsedBytes, limit: plan.storageLimitBytes });
      }
    }
    if (flagged.length) console.warn(`[cron] storageVerification: ${flagged.length} over-limit accounts`, flagged.map((f) => f.userId));
    return flagged;
  }

  async function runAll(tag = 'scheduled') {
    try {
      await dailyUsageSync();
      await dailySubscriptionSync();
      dailyStorageVerification();
    } catch (e) {
      console.error(`[cron:${tag}] error:`, e.message);
    }
  }

  // first run shortly after boot, then every 24h
  const startupTimer = setTimeout(() => runAll('startup'), 60 * 1000);
  const interval = setInterval(() => runAll('daily'), DAY);

  return { dailyUsageSync, dailySubscriptionSync, dailyStorageVerification, runAll,
    stop() { clearTimeout(startupTimer); clearInterval(interval); } };
}

module.exports = { start };
