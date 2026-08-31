#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// db:reset — DESTRUCTIVE. Drop every object and re-apply all migrations.
//
//   cd db && npm run db:reset
//
// This is the "down" path for local development and tests: Drizzle migrations
// are forward-only (see docs/07 §14 for the rationale and the production
// rollback policy — a corrective forward migration, never an automatic
// down-migration against real user data).
//
// Guards (db/src/env.js):
//   • Refused unless APP_ENV is local or test.
//   • ALWAYS refused for production.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const { loadEnv, assertDestructiveAllowed } = require('../env');
const { createPool } = require('../pool');

async function main() {
  const env = loadEnv();
  assertDestructiveAllowed(env, 'db:reset (drops all data)');

  const pool = createPool({ env, max: 1, statementTimeoutMs: 0, applicationName: 'veorec-db-reset' });
  console.log(`[reset] env=${env.appEnv} target=${env.databaseUrlRedacted}`);
  try {
    // Drop the public schema (all application objects) and Drizzle's own
    // migration bookkeeping, then restore an empty public schema.
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await pool.query('CREATE SCHEMA public');
    const { rows } = await pool.query('SELECT current_user AS u');
    await pool.query(`GRANT ALL ON SCHEMA public TO "${rows[0].u.replace(/"/g, '""')}"`);
    console.log('[reset] schema dropped and recreated');
  } finally {
    await pool.end().catch(() => {});
  }

  // Re-apply migrations in a child process so the migrator sees a clean pool.
  const migrateScript = path.join(__dirname, 'migrate.js');
  const r = spawnSync(process.execPath, [migrateScript], { stdio: 'inherit', env: process.env });
  process.exit(r.status === null ? 1 : r.status);
}

main().catch((err) => {
  console.error(`[reset] FAILED: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
