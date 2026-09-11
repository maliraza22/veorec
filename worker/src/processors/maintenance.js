// Maintenance processors (T-602, docs/10 §3): the PostgreSQL-side jobs the
// legacy in-process cron used to run, now as queue jobs with rows, retries,
// results and admin visibility. Each is a plain function from @veorec/db
// (idempotent by construction); the processor only supplies dependencies.
//
// NOT here — `subscription_sync`: it reconciles the LEGACY JSON subscription
// store with Paddle (server/billing.service.js writes that file), and a file
// store has exactly one writer, the API process. It stays on the legacy
// scheduler until billing lives in PostgreSQL (Phase 9–13); the catalog keeps
// the type so the row/queue contract does not change when it moves.
'use strict';

const path = require('path');

const DB_MAINT = path.join(__dirname, '..', '..', '..', 'db', 'src', 'maintenance');

function defaultJobs() {
  return {
    usageSync: require(path.join(DB_MAINT, 'usage-sync.js')).usageSync,
    uploadExpiry: require(path.join(DB_MAINT, 'upload-expiry.js')).uploadExpiry,
    cleanup: require(path.join(DB_MAINT, 'cleanup.js')).cleanup,
    storageVerification: require(path.join(DB_MAINT, 'storage-verification.js')).storageVerification,
  };
}

/**
 * @param {object} registry   from createRegistry()
 * @param {object} [jobs]     the maintenance functions (injectable for tests)
 */
function registerMaintenanceProcessors(registry, jobs = defaultJobs()) {
  // usage_sync + the over-limit report (docs/10 §3 "also storage_verification").
  registry.register('usage_sync', async ({ repositories, deps, logger }) => {
    const sync = await jobs.usageSync({ repositories, withTransaction: deps.withTransaction, logger });
    let verification = null;
    if (deps.resolveLimits) {
      const v = await jobs.storageVerification({ repositories, resolveLimits: deps.resolveLimits, logger });
      verification = { checked: v.checked, errors: v.errors, over: v.over };
    } else {
      logger.warn('usage_sync: no plan resolver supplied — storage verification skipped');
    }
    return { ...sync, verification };
  });

  registry.register('upload_expiry', async ({ repositories, deps, logger }) =>
    jobs.uploadExpiry({ repositories, withTransaction: deps.withTransaction, storage: deps.storage || null, logger }));

  registry.register('cleanup', async ({ repositories, deps, logger, payload }) =>
    jobs.cleanup({
      repositories, withTransaction: deps.withTransaction, storage: deps.storage || null, logger,
      orphanScan: !!(payload && payload.orphanScan),
    }));

  return registry;
}

module.exports = { registerMaintenanceProcessors, defaultJobs };
