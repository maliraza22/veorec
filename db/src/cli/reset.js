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
    // Drop EVERY non-system schema — application objects (public), Drizzle's
    // migration bookkeeping (drizzle) and any auxiliary schema such as the
    // transitional `legacy` one. Enumerating rather than hard-coding names
    // means a schema added by a future migration cannot silently survive a
    // reset and leak rows into the next run.
    const { rows: schemas } = await pool.query(`
      SELECT nspname FROM pg_namespace
      WHERE nspname NOT IN ('pg_catalog','information_schema')
        AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%'`);
    for (const { nspname } of schemas) {
      await pool.query(`DROP SCHEMA IF EXISTS "${nspname.replace(/"/g, '""')}" CASCADE`);
    }
    await pool.query('CREATE SCHEMA public');
    console.log(`[reset] dropped schema(s): ${schemas.map((s) => s.nspname).join(', ') || '(none)'}`);
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
