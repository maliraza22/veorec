#!/usr/bin/env node
// Maintenance jobs (docs/10 §3) runnable by hand. Since T-602 the worker runs
// them as repeatable queue jobs (`cd worker && npm run worker`); this CLI is
// for an operator who wants one run now, or for environments without Redis.
//
//   node src/cli/maintenance.js usage_sync     [--env test|development|staging|production]
//   node src/cli/maintenance.js upload_expiry  [--env ...]   (needs STORAGE_* to tear storage down)
//   node src/cli/maintenance.js cleanup        [--env ...] [--orphans]   (needs STORAGE_* to delete objects)
//
// Exit 0 on success (a report is printed), 1 on a job error or unknown job.
'use strict';

const path = require('path');
const { loadEnv, createPool, createClient, createRepositories, withTransaction } = require('../index.js');
const { usageSync } = require('../maintenance/usage-sync');
const { uploadExpiry } = require('../maintenance/upload-expiry');
const { cleanup } = require('../maintenance/cleanup');

const JOBS = ['usage_sync', 'upload_expiry', 'cleanup'];

function loadStorage(appEnv, job) {
  try {
    const storagePkg = require(path.join(__dirname, '..', '..', '..', 'storage', 'src', 'index.js'));
    return storagePkg.createStorageProvider({ appEnv });
  } catch (e) {
    console.warn(`${job}: no storage provider configured — rows will be healed, storage teardown skipped`);
    return null;
  }
}

async function main(argv) {
  const job = argv[0];
  const envIdx = argv.indexOf('--env');
  const appEnv = envIdx >= 0 ? argv[envIdx + 1] : (process.env.APP_ENV || 'development');
  if (!JOBS.includes(job)) {
    console.error(`usage: maintenance.js <${JOBS.join('|')}> [--env <appEnv>] [--orphans]`);
    return 1;
  }
  const env = loadEnv({ appEnv });
  const pool = createPool({ env, max: 4 });
  const db = createClient(pool);
  const repositories = () => createRepositories(db);
  const tx = (fn) => withTransaction(fn, db);
  const logger = { info: (o, m) => console.log(m || '', JSON.stringify(o)), warn: (o, m) => console.warn(m || '', JSON.stringify(o)) };
  try {
    let report;
    if (job === 'usage_sync') {
      report = await usageSync({ repositories, withTransaction: tx, logger });
      console.log(JSON.stringify({ job, ...report, drift: undefined }, null, 2));
    } else if (job === 'upload_expiry') {
      report = await uploadExpiry({ repositories, withTransaction: tx, storage: loadStorage(appEnv, job), logger });
      console.log(JSON.stringify({ job, ...report }, null, 2));
    } else {
      report = await cleanup({ repositories, withTransaction: tx, storage: loadStorage(appEnv, job), logger, orphanScan: argv.includes('--orphans') });
      console.log(JSON.stringify({ job, ...report }, null, 2));
    }
    return report.errors ? 1 : 0;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { main };
