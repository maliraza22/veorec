#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// db:reconcile — the migration safety net (T-106)
//
//   cd db
//   npm run db:reconcile -- --data-dir=/path --media-listing=media.json
//   npm run db:reconcile -- --data-dir=/path --media-listing=media.json --repair
//
// DEFAULT IS REPORT-ONLY: it performs zero database writes. This is what the
// nightly job runs. Repair is opt-in, additive, and idempotent; it can never
// delete PostgreSQL data. Records that appear deleted in the legacy system are
// reported for a human decision, and the one opt-in that touches them
// (--allow-stale-soft-delete) only SOFT-deletes, which is reversible.
//
// Exit codes: 0 clean · 2 findings (nightly alert) · 1 error.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../env');
const { createPool } = require('../pool');
const { createClient } = require('../client');
const { reconcile } = require('../migration/reconciler');

const USAGE = `
db:reconcile — prove PostgreSQL is convergent with the legacy system (T-106)

  --data-dir=<dir>            legacy JSON directory (required)
  --media-listing=<file>      media listing export; REQUIRED to detect deletes
  --report                    detect only, zero writes (DEFAULT)
  --repair                    additionally apply additive, idempotent repairs
  --allow-stale-soft-delete   with --repair: SOFT-delete PostgreSQL rows whose
                              legacy record is gone (reversible; never a hard
                              delete, never in a nightly run)
  --json                      machine-readable report
  --quiet                     print only the summary line

Nothing is ever hard-deleted from PostgreSQL by this tool.
`;

function parseArgs(argv) {
  const a = { dataDir: null, mediaListing: null, mode: 'report', allowStaleSoftDelete: false, json: false, quiet: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--report') a.mode = 'report';
    else if (arg === '--repair') a.mode = 'repair';
    else if (arg === '--allow-stale-soft-delete') a.allowStaleSoftDelete = true;
    else if (arg === '--json') a.json = true;
    else if (arg === '--quiet') a.quiet = true;
    else if (arg.startsWith('--data-dir=')) a.dataDir = arg.slice('--data-dir='.length);
    else if (arg.startsWith('--media-listing=')) a.mediaListing = arg.slice('--media-listing='.length);
    else if (arg === '--help' || arg === '-h') a.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.dataDir) { console.log(USAGE); process.exit(args.help ? 0 : 1); }
  if (!fs.existsSync(args.dataDir)) throw new Error(`--data-dir does not exist: ${args.dataDir}`);
  if (args.mediaListing && !fs.existsSync(args.mediaListing)) {
    throw new Error(`--media-listing does not exist: ${args.mediaListing}`);
  }
  if (args.allowStaleSoftDelete && args.mode !== 'repair') {
    throw new Error('--allow-stale-soft-delete requires --repair');
  }

  const env = loadEnv();
  const pool = createPool({ env, max: 3, statementTimeoutMs: 0, applicationName: 'veorec-reconcile' });
  const db = createClient(pool);

  console.log(`[reconcile] env=${env.appEnv} target=${env.databaseUrlRedacted}`);
  console.log(`[reconcile] source=${args.dataDir}${args.mediaListing ? ` media=${path.basename(args.mediaListing)}` : ''}`);
  console.log(args.mode === 'report'
    ? '[reconcile] REPORT mode — no database writes will be performed'
    : `[reconcile] REPAIR mode — additive repairs only${args.allowStaleSoftDelete ? ' (+ soft-delete of stale rows)' : ''}`);
  if (!args.mediaListing) {
    console.log('[reconcile] NOTE: without --media-listing, deleted-recording detection is skipped (see report)');
  }

  try {
    const report = await reconcile({
      db, dataDir: args.dataDir, mediaListingFile: args.mediaListing,
      mode: args.mode, allowStaleSoftDelete: args.allowStaleSoftDelete,
    });

    if (args.json) console.log(JSON.stringify(report.toJSON(), null, 2));
    else if (!args.quiet) console.log(report.format());

    const n = report.findings.length;
    const manual = report.findings.filter((f) => !f.repairable).length;
    console.log(`[reconcile] ${report.clean ? 'CONVERGENT' : `${n} finding(s), ${manual} needing a human decision`}` +
      (report.repairs.length ? ` · ${report.repairs.length} repair(s) applied` : ''));

    if (!report.clean) process.exitCode = 2;
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[reconcile] FAILED: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
