#!/usr/bin/env node
// Maintenance jobs (docs/10 §3) runnable by hand or from a scheduler until the
// Phase 6 queue owns them:
//
//   node src/cli/maintenance.js usage_sync     [--env test|development|staging|production]
//   node src/cli/maintenance.js upload_expiry  [--env ...]   (needs STORAGE_* to tear storage down)
//
// Exit 0 on success (a report is printed), 1 on a job error or unknown job.
'use strict';

const path = require('path');
const { loadEnv, createPool, createClient, createRepositories, withTransaction } = require('../index.js');
const { usageSync } = require('../maintenance/usage-sync');
const { uploadExpiry } = require('../maintenance/upload-expiry');

async function main(argv) {
  const job = argv[0];
  const envIdx = argv.indexOf('--env');
  const appEnv = envIdx >= 0 ? argv[envIdx + 1] : (process.env.APP_ENV || 'development');
  if (!['usage_sync', 'upload_expiry'].includes(job)) {
    console.error('usage: maintenance.js <usage_sync|upload_expiry> [--env <appEnv>]');
    return 1;
  }
  const env = loadEnv({ appEnv });
  const pool = createPool({ env, max: 4 });
  const db = createClient(pool);
  const repositories = () => createRepositories(db);
  const tx = (fn) => withTransaction(fn, db);
  const logger = { info: (o, m) => console.log(m || '', JSON.stringify(o)), warn: (o, m) => console.warn(m || '', JSON.stringify(o)) };
  try {
    if (job === 'usage_sync') {
      const report = await usageSync({ repositories, withTransaction: tx, logger });
      console.log(JSON.stringify({ job, ...report, drift: undefined }, null, 2));
      return report.errors ? 1 : 0;
    }
    let storage = null;
    try {
      const storagePkg = require(path.join(__dirname, '..', '..', '..', 'storage', 'src', 'index.js'));
      storage = storagePkg.createStorageProvider({ appEnv });
    } catch (e) {
      console.warn('upload_expiry: no storage provider configured — rows will be healed, storage teardown skipped');
    }
    const report = await uploadExpiry({ repositories, withTransaction: tx, storage, logger });
    console.log(JSON.stringify({ job, ...report }, null, 2));
    return report.errors ? 1 : 0;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { main };
