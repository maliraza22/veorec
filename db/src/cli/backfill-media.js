#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// db:backfill — copy existing legacy media into R2 (T-204)
//
//   cd db
//   npm run db:backfill                    # DRY RUN — inspects, writes nothing
//   npm run db:backfill -- --apply         # copy for real
//   npm run db:backfill -- --apply --limit=50 --concurrency=2
//
// DRY RUN IS THE DEFAULT, matching db:import and db:reconcile. This moves real
// user media; it does not start because somebody wanted to see the queue.
//
// It NEVER deletes, overwrites or renames anything at the legacy provider, and
// it changes nothing the application reads — a copied object is an ADDITIONAL
// copy while Cloudinary stays authoritative.
//
// Exit codes: 0 nothing needs attention · 2 items failed/unsafe · 1 error.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { loadEnv } = require('../env');
const { createPool } = require('../pool');
const { createClient } = require('../client');
const { createRepositories } = require('../repositories');
const { backfill, DEFAULT_CONCURRENCY } = require('../migration/backfill');

const USAGE = `
db:backfill — copy existing legacy media into R2 (T-204)

  --apply              perform the copy (default is a dry run that writes nothing)
  --limit=<n>          stop after n items this run (default: drain the queue)
  --concurrency=<n>    parallel transfers (default ${DEFAULT_CONCURRENCY})
  --batch=<n>          items claimed per round trip (default 25)
  --data-dir=<dir>     legacy uploads volume, needed only for local_disk media
  --json               machine-readable report
  --help

Cloudinary originals are read-only here and are never deleted by this tool.
`;

function parseArgs(argv) {
  const a = { mode: 'report', limit: 0, concurrency: DEFAULT_CONCURRENCY, batchSize: 25, dataDir: null, json: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') a.mode = 'apply';
    else if (arg === '--json') a.json = true;
    else if (arg === '--help' || arg === '-h') a.help = true;
    else if (arg.startsWith('--limit=')) a.limit = Number(arg.slice(8)) || 0;
    else if (arg.startsWith('--concurrency=')) a.concurrency = Number(arg.slice(14)) || DEFAULT_CONCURRENCY;
    else if (arg.startsWith('--batch=')) a.batchSize = Number(arg.slice(8)) || 25;
    else if (arg.startsWith('--data-dir=')) a.dataDir = arg.slice(11);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(USAGE); process.exit(0); }
  if (args.concurrency < 1 || args.concurrency > 16) {
    throw new Error('--concurrency must be between 1 and 16 — the copier shares capacity with the live application');
  }

  const env = loadEnv();
  const pool = createPool({ env, max: Math.max(4, args.concurrency + 2), applicationName: 'veorec-backfill' });
  const db = createClient(pool);
  const repos = createRepositories(db);

  const storage = require('../../../storage/src/index.js');
  const provider = storage.storageProvider();

  console.log(`[backfill] env=${env.appEnv} db=${env.databaseUrlRedacted}`);
  console.log(`[backfill] storage=${JSON.stringify(provider.describe())}`);
  console.log(args.mode === 'apply'
    ? `[backfill] APPLY — copying up to ${args.limit || 'all'} item(s), concurrency ${args.concurrency}`
    : '[backfill] DRY RUN — no bytes are copied and no state changes');
  console.log('[backfill] Cloudinary originals are READ-ONLY and are never deleted by this tool');

  try {
    const report = await backfill({
      db, provider, repos,
      mode: args.mode, limit: args.limit, concurrency: args.concurrency,
      batchSize: args.batchSize, dataDir: args.dataDir,
    });

    if (args.json) console.log(JSON.stringify(report.toJSON(), null, 2));
    else console.log(report.format(report.stats));

    const attention = report.failed + report.unsafe;
    console.log(`\n[backfill] ${attention ? `${attention} item(s) need attention` : 'no items need attention'}` +
      ` · remaining pending: ${report.stats.pending + report.stats.failed}`);
    if (attention) process.exitCode = 2;
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[backfill] FAILED: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
