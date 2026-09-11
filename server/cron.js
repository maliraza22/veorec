// ─────────────────────────────────────────────────────────────────────────────
// CRON  —  lightweight in-process daily jobs (no extra infra / no scheduler bill).
//
//   dailyUsageSync()          recompute storage/usage from the real source
//   dailySubscriptionSync()   reconcile each subscription with Paddle
//   dailyStorageVerification() flag accounts over their storage limit
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

  // ── T-306: PostgreSQL ledger maintenance (docs/10 §3) ─────────────────────
  // Present only when the v1 stack is mounted (deps.maintenance). Hourly
  // upload_expiry heals abandoned sessions and returns their reservations;
  // daily usage_sync re-derives the ledger counters from the rows and logs
  // drift. Both are plain functions from @veorec/db — the Phase 6 queue takes
  // them over without change. Never blocks the legacy jobs: each runs in its
  // own try, and a failure is logged, not thrown.
  const maintenance = deps.maintenance || null;
  async function hourlyUploadExpiry() {
    if (!maintenance) return null;
    try {
      const { uploadExpiry } = require('../db/src/maintenance/upload-expiry');
      const r = await uploadExpiry(maintenance);
      console.log(`[cron] uploadExpiry: expired ${r.expired}, released ${r.released}`);
      return r;
    } catch (e) { console.error('[cron] uploadExpiry error:', e.message); return null; }
  }
  async function dailyLedgerSync() {
    if (!maintenance) return null;
    try {
      const { usageSync } = require('../db/src/maintenance/usage-sync');
      const r = await usageSync(maintenance);
      console.log(`[cron] ledgerSync: synced ${r.synced} users, ${r.drifted} drifted`);
      return r;
    } catch (e) { console.error('[cron] ledgerSync error:', e.message); return null; }
  }

  async function runAll(tag = 'scheduled') {
    try {
      await dailyUsageSync();
      await dailySubscriptionSync();
      dailyStorageVerification();
    } catch (e) {
      console.error(`[cron:${tag}] error:`, e.message);
    }
    await hourlyUploadExpiry();
    await dailyLedgerSync();
  }

  // first run shortly after boot, then every 24h; upload expiry hourly
  const startupTimer = setTimeout(() => runAll('startup'), 60 * 1000);
  const interval = setInterval(() => runAll('daily'), DAY);
  const hourly = setInterval(() => hourlyUploadExpiry(), 60 * 60 * 1000);
  if (hourly.unref) hourly.unref();

  return { dailyUsageSync, dailySubscriptionSync, dailyStorageVerification, runAll,
    hourlyUploadExpiry, dailyLedgerSync,
    stop() { clearTimeout(startupTimer); clearInterval(interval); clearInterval(hourly); } };
}

module.exports = { start };
