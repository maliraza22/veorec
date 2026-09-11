// maintenance.storage_verification (docs/10 §3; replaces cron.dailyStorageVerification) — T-602
//
// Flags accounts whose LIVE totals (the same aggregates the quota gate uses)
// exceed their plan limits. Report + warn log only — exactly what the legacy
// job did; nothing is mutated and nobody is emailed. The plan resolution is
// injected (`resolveLimits({ user, subscription })`), because the plan
// catalog lives in the API process and the worker supplies its own resolver.
'use strict';

const REASON = 'T-602 maintenance.storage_verification: flag accounts over their plan limits';

/**
 * @param {object} deps
 * @param {() => object} deps.repositories
 * @param {({user, subscription}) => Promise<{planSlug, maxStorageBytes, maxActiveVideos}>} deps.resolveLimits
 * @param {object} [deps.logger]
 * @param {number} [deps.limit]   users per run
 */
async function storageVerification({ repositories, resolveLimits, logger = console, limit = 10000 }) {
  if (typeof resolveLimits !== 'function') throw new Error('storageVerification: resolveLimits is required');
  const repos = repositories();
  const userIds = await repos.usage.listUserIdsSystem(REASON);
  const report = { checked: 0, over: [], errors: 0 };
  for (const userId of userIds.slice(0, limit)) {
    try {
      const totals = await repos.usage.liveTotalsSystem(userId, REASON);
      const user = await repos.users.findById(userId);
      const subscription = await repos.subscriptions.getForUser({ userId });
      const limits = await resolveLimits({ user, subscription });
      report.checked += 1;
      const overStorage = Number.isFinite(limits.maxStorageBytes) && totals.storageRetainedBytes > limits.maxStorageBytes;
      const overVideos = limits.maxActiveVideos != null && totals.activeVideoCount > limits.maxActiveVideos;
      if (overStorage || overVideos) {
        const entry = {
          userId, planSlug: limits.planSlug,
          storageRetainedBytes: totals.storageRetainedBytes, maxStorageBytes: limits.maxStorageBytes,
          activeVideoCount: totals.activeVideoCount, maxActiveVideos: limits.maxActiveVideos,
          overStorage, overVideos,
        };
        report.over.push(entry);
        logger.warn({ user_id: userId, ...entry }, 'storage_verification: account over its plan limits');
      }
    } catch (err) {
      report.errors += 1;
      logger.warn({ user_id: userId, err: { message: err && err.message } }, 'storage_verification: user check failed');
    }
  }
  return report;
}

module.exports = { storageVerification, REASON };
