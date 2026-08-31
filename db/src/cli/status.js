#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// db:status — connectivity + migration state (read-only)
//
//   cd db && npm run db:status
//
// Exit codes: 0 connected and up to date · 1 cannot connect · 2 pending
// migrations (useful as a deployment gate).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { loadEnv } = require('../env');
const { createPool, checkConnection } = require('../pool');
const { migrationState } = require('../migration-state');

async function main() {
  const env = loadEnv();
  const pool = createPool({ env, max: 1, applicationName: 'veorec-db-status' });

  console.log(`[status] env=${env.appEnv} target=${env.databaseUrlRedacted} ssl=${env.sslMode}`);
  try {
    const conn = await checkConnection(pool);
    if (!conn.ok) {
      console.error(`[status] NOT CONNECTED: ${conn.error && conn.error.message}`);
      console.error('[status] is the database running?  docker compose up -d postgres');
      process.exitCode = 1;
      return;
    }
    console.log(`[status] connected: db=${conn.database} user=${conn.user}`);
    console.log(`[status] ${conn.version.split(' ').slice(0, 2).join(' ')}`);

    const state = await migrationState(pool, env.migrationsFolder);
    console.log(`[status] migrations: ${state.applied.length}/${state.total} applied`);
    for (const m of state.applied) console.log(`  ✓ ${m.tag}`);
    for (const m of state.pending) console.log(`  · ${m.tag} (pending)`);
    if (state.pending.length) process.exitCode = 2;
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[status] FAILED: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
