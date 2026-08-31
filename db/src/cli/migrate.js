#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// db:migrate — apply pending SQL migrations (T-101)
//
// Forward-only, deterministic, tracked in the database. Safe to run repeatedly:
// already-applied migrations are skipped. This is THE migration mechanism for
// every environment (local, CI, staging, production) — schema is never
// synchronised automatically from code (no drizzle-kit push), because that is
// destructive and unreviewable (docs/07 §14).
//
//   cd db && npm run db:migrate
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { migrate } = require('drizzle-orm/node-postgres/migrator');
const { loadEnv } = require('../env');
const { createPool } = require('../pool');
const { createClient } = require('../client');
const { migrationState } = require('../migration-state');

async function main() {
  const env = loadEnv();
  // statementTimeoutMs: 0 — a large migration must never be killed mid-way.
  const pool = createPool({ env, max: 1, statementTimeoutMs: 0, applicationName: 'veorec-migrate' });

  console.log(`[migrate] env=${env.appEnv} target=${env.databaseUrlRedacted}`);
  try {
    const before = await migrationState(pool, env.migrationsFolder);
    if (before.pending.length === 0) {
      console.log(`[migrate] up to date — ${before.applied.length}/${before.total} applied, nothing to do`);
      return;
    }
    console.log(`[migrate] pending: ${before.pending.map((p) => p.tag).join(', ')}`);

    const db = createClient(pool);
    const startedAt = Date.now();
    await migrate(db, { migrationsFolder: env.migrationsFolder });

    const after = await migrationState(pool, env.migrationsFolder);
    console.log(`[migrate] applied ${after.applied.length - before.applied.length} migration(s) in ${Date.now() - startedAt}ms`);
    console.log(`[migrate] now at ${after.applied.length}/${after.total}` +
      (after.pending.length ? ` (still pending: ${after.pending.map((p) => p.tag).join(', ')})` : ' — up to date'));
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  // Never print the connection string here: it may carry credentials.
  console.error(`[migrate] FAILED: ${err && err.message ? err.message : err}`);
  if (err && err.code) console.error(`[migrate] postgres code: ${err.code}`);
  process.exit(1);
});
