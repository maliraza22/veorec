#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// db:reconcile — find and repair PostgreSQL mirrors that failed (T-105)
//
//   cd db
//   npm run db:reconcile -- --data-dir=/path/to/volume            # report only
//   npm run db:reconcile -- --data-dir=/path --prune               # drop healed entries
//
// The dual-write mirror appends every failed/skipped mirror to
// dual-write-failures.jsonl (a durable file that works even when PostgreSQL is
// the thing that is down). This tool answers "which legacy writes are missing
// from PostgreSQL, and are they still missing?".
//
// REPAIR is deliberately NOT a second import path: the T-104 importer is
// idempotent and converges, so repairing is `npm run db:import -- --apply`.
// This tool verifies which journal entries are now satisfied and can prune
// them, so the journal shrinks to only genuinely-outstanding work.
//
// Safe to re-run: it only reads PostgreSQL and rewrites its own journal.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const { sql } = require('drizzle-orm');
const { loadEnv } = require('../env');
const { createPool } = require('../pool');
const { createClient } = require('../client');
const { idFor } = require('../legacy-ids');

// entity → how to check whether the mirrored row now exists.
const CHECKS = {
  users: (id) => ({ table: 'users', column: 'id', value: idFor('usr', id) }),
  folders: (id) => ({ table: 'folders', column: 'id', value: idFor('fld', id) }),
  recordings: (id) => ({ table: 'recordings', column: 'id', value: idFor('rec', id) }),
  comments: (id) => ({ table: 'comments', column: 'id', value: idFor('cmt', id) }),
  usage: (id) => ({ table: 'usage', column: 'user_id', value: idFor('usr', id) }),
  subscriptions: (id) => ({ table: 'subscriptions', column: 'user_id', value: idFor('usr', id) }),
  contacts: (id) => ({ table: 'contacts', column: 'id', value: idFor('ctc', id) }),
  notification_reads: (id) => ({ table: 'notification_reads', column: 'user_id', value: idFor('usr', id) }),
  // Reactions / views / leads use content-derived ids that the journal does not
  // carry, so they are reported as "verify via import" rather than guessed.
};

function parseArgs(argv) {
  const args = { dataDir: null, prune: false, json: false };
  for (const a of argv.slice(2)) {
    if (a === '--prune') args.prune = true;
    else if (a === '--json') args.json = true;
    else if (a.startsWith('--data-dir=')) args.dataDir = a.slice('--data-dir='.length);
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.dataDir) {
    console.log('\ndb:reconcile — inspect the dual-write failure journal\n\n' +
      '  --data-dir=<dir>   directory holding dual-write-failures.jsonl (required)\n' +
      '  --prune            rewrite the journal without entries already satisfied\n' +
      '  --json             machine-readable output\n');
    process.exit(args.help ? 0 : 1);
  }

  const journalPath = path.join(args.dataDir, 'dual-write-failures.jsonl');
  if (!fs.existsSync(journalPath)) {
    console.log(`[reconcile] no journal at ${journalPath} — nothing to reconcile`);
    return;
  }

  const lines = fs.readFileSync(journalPath, 'utf8').split('\n').filter((l) => l.trim());
  const entries = [];
  let malformed = 0;
  for (const l of lines) {
    try { entries.push(JSON.parse(l)); } catch { malformed++; }
  }

  const env = loadEnv();
  const pool = createPool({ env, max: 2, applicationName: 'veorec-reconcile' });
  const db = createClient(pool);
  console.log(`[reconcile] env=${env.appEnv} target=${env.databaseUrlRedacted}`);
  console.log(`[reconcile] journal: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` +
    (malformed ? ` (+${malformed} malformed line(s))` : ''));

  const resolved = [];
  const outstanding = [];
  const unverifiable = [];

  try {
    for (const e of entries) {
      const check = CHECKS[e.entity];
      if (!check || !e.legacyId) { unverifiable.push(e); continue; }
      const { table, column, value } = check(e.legacyId);
      const res = await db.execute(sql.raw(
        `SELECT 1 FROM ${table} WHERE ${column} = '${String(value).replace(/'/g, "''")}' LIMIT 1`));
      ((res.rows || res).length ? resolved : outstanding).push(e);
    }

    const byEntity = {};
    for (const e of outstanding) byEntity[e.entity] = (byEntity[e.entity] || 0) + 1;

    const report = {
      journal: journalPath,
      total: entries.length,
      resolved: resolved.length,
      outstanding: outstanding.length,
      unverifiable: unverifiable.length,
      outstandingByEntity: byEntity,
      malformedLines: malformed,
    };

    if (args.json) {
      console.log(JSON.stringify({ ...report, outstandingEntries: outstanding.slice(0, 200) }, null, 2));
    } else {
      console.log('');
      console.log(`  already repaired : ${resolved.length}`);
      console.log(`  still missing    : ${outstanding.length}`);
      console.log(`  unverifiable     : ${unverifiable.length}  (content-derived ids — confirm via db:import)`);
      for (const [entity, n] of Object.entries(byEntity)) console.log(`      ${entity}: ${n}`);
      console.log('');
      if (outstanding.length || unverifiable.length) {
        console.log('  To repair, re-run the idempotent importer against the same data directory:');
        console.log(`      npm run db:import -- --data-dir=${args.dataDir} --apply`);
        console.log('  Then re-run this command with --prune.');
      } else {
        console.log('  Nothing outstanding — every journaled mirror is now present in PostgreSQL.');
      }
    }

    if (args.prune && resolved.length) {
      const keep = entries.filter((e) => !resolved.includes(e));
      fs.writeFileSync(journalPath, keep.map((e) => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : ''));
      console.log(`[reconcile] pruned ${resolved.length} repaired entr${resolved.length === 1 ? 'y' : 'ies'} from the journal`);
    }

    if (outstanding.length) process.exitCode = 2;
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[reconcile] FAILED: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
