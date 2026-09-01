#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// db:import — migrate legacy JSON/media state into PostgreSQL (T-104)
//
//   cd db
//   npm run db:import -- --data-dir=/path/to/volume                  # DRY RUN
//   npm run db:import -- --data-dir=/path --media-listing=media.json # DRY RUN
//   npm run db:import -- --data-dir=/path --apply                    # writes
//
// DRY RUN IS THE DEFAULT: writing requires an explicit --apply. The importer is
// read-only against legacy sources and safe to re-run (idempotent + resumable).
//
// This is an operator-run tool. Nothing in the application invokes it — not
// server startup, requests, cron or workers.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../env');
const { createPool } = require('../pool');
const { createClient } = require('../client');
const { createRepositories } = require('../repositories');
const { runImport } = require('../migration/importer');
const { fingerprintSources } = require('../migration/sources');

function parseArgs(argv) {
  const args = { dataDir: null, mediaListing: null, apply: false, json: false };
  for (const a of argv.slice(2)) {
    if (a === '--apply') args.apply = true;
    else if (a === '--json') args.json = true;
    else if (a.startsWith('--data-dir=')) args.dataDir = a.slice('--data-dir='.length);
    else if (a.startsWith('--media-listing=')) args.mediaListing = a.slice('--media-listing='.length);
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const USAGE = `
db:import — legacy → PostgreSQL importer (T-104)

  --data-dir=<dir>        directory holding the legacy JSON stores (required)
  --media-listing=<file>  media listing exported by export-legacy-media.js
  --apply                 perform the import (default is a dry run)
  --json                  print the machine-readable report
`;

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.dataDir) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }
  if (!fs.existsSync(args.dataDir)) throw new Error(`--data-dir does not exist: ${args.dataDir}`);
  if (args.mediaListing && !fs.existsSync(args.mediaListing)) {
    throw new Error(`--media-listing does not exist: ${args.mediaListing}`);
  }

  const env = loadEnv();
  const dryRun = !args.apply;
  const pool = createPool({ env, max: 4, statementTimeoutMs: 0, applicationName: 'veorec-import' });
  const client = createClient(pool);
  const repos = createRepositories(client);

  console.log(`[import] env=${env.appEnv} target=${env.databaseUrlRedacted}`);
  console.log(`[import] source=${args.dataDir}${args.mediaListing ? ` media=${path.basename(args.mediaListing)}` : ' (no media listing — recordings will be reported as orphans)'}`);
  console.log(dryRun ? '[import] DRY RUN — no writes will be performed' : '[import] APPLYING — writing to PostgreSQL');

  // Prove the run left every legacy source untouched.
  const before = fingerprintSources(args.dataDir, args.mediaListing);

  try {
    const report = await runImport({
      repos, db: client, dataDir: args.dataDir, mediaListingFile: args.mediaListing, dryRun,
    });

    const after = fingerprintSources(args.dataDir, args.mediaListing);
    const mutated = Object.keys(before).filter((k) => before[k] !== after[k]);
    if (mutated.length) {
      // Must never happen — the importer has no write path to the sources.
      console.error(`[import] FATAL: legacy sources changed during the run: ${mutated.join(', ')}`);
      process.exit(3);
    }

    console.log(args.json ? JSON.stringify(report.toJSON(), null, 2) : report.format());
    console.log(`[import] legacy sources verified unmodified (${Object.keys(before).length} files fingerprinted)`);

    if (report.hasProblems) {
      const t = report.totals;
      console.error(`[import] finished WITH PROBLEMS — failed=${t.failed} orphan=${t.orphan} conflict=${t.conflict}`);
      console.error('[import] review the problem list above; nothing was guessed or silently dropped');
      process.exit(2);
    }
    console.log(dryRun
      ? '[import] dry run clean — re-run with --apply to perform the import'
      : '[import] import complete');
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[import] FAILED: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
