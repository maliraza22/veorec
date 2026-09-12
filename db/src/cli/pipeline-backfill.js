#!/usr/bin/env node
// Legacy re-processing backfill (T-706, docs/23 Phase 7):
//
//   node src/cli/pipeline-backfill.js stats                      # progress numbers
//   node src/cli/pipeline-backfill.js fill                       # DRY RUN — lists what would be queued
//   node src/cli/pipeline-backfill.js fill --apply --limit=100   # queue probe jobs (throttled per run)
//   node src/cli/pipeline-backfill.js fill --apply --include-failed
//   [--env test|development|staging|production]
//
// Dry run is the default (like db:backfill). Only rows are written — the
// worker fleet does the processing. Exit 0 on success, 1 on error/unknown command.
'use strict';

const { loadEnv, createPool, createClient, createRepositories, withTransaction } = require('../index.js');
const { pipelineStats, queueFill } = require('../maintenance/pipeline-backfill');

function arg(argv, name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main(argv) {
  const cmd = argv[0];
  if (!['stats', 'fill'].includes(cmd)) {
    console.error('usage: pipeline-backfill.js <stats|fill> [--apply] [--limit=<n>] [--include-failed] [--env <appEnv>]');
    return 1;
  }
  const envIdx = argv.indexOf('--env');
  const appEnv = envIdx >= 0 ? argv[envIdx + 1] : (process.env.APP_ENV || 'development');
  const env = loadEnv({ appEnv });
  const pool = createPool({ env, max: 4 });
  const db = createClient(pool);
  const repositories = () => createRepositories(db);
  const tx = (fn) => withTransaction(fn, db);
  const logger = { info: (o, m) => console.log(m || '', JSON.stringify(o)), warn: (o, m) => console.warn(m || '', JSON.stringify(o)) };
  try {
    if (cmd === 'stats') {
      console.log(JSON.stringify({ command: 'stats', ...(await pipelineStats({ repositories })) }, null, 2));
      return 0;
    }
    const limit = Number(arg(argv, 'limit', '100'));
    if (!Number.isInteger(limit) || limit < 1) { console.error('--limit must be a positive integer'); return 1; }
    const report = await queueFill({ repositories, withTransaction: tx, limit, apply: argv.includes('--apply'), includeFailed: argv.includes('--include-failed'), logger });
    console.log(JSON.stringify({ command: 'fill', ...report }, null, 2));
    return report.errors ? 1 : 0;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { main };
