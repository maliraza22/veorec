// ─────────────────────────────────────────────────────────────────────────────
// POSTGRES CONNECTION POOL (T-101)
//
// Single place that constructs pg Pools. Callers get either a dedicated pool
// (CLIs, tests) or the shared process pool (long-running services).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { Pool } = require('pg');
const { loadEnv } = require('./env');

/**
 * @param {object} [options]
 * @param {object} [options.env]                resolved env (defaults to loadEnv())
 * @param {number} [options.max]                pool size override
 * @param {number} [options.statementTimeoutMs] 0 disables (used by migrations)
 * @param {string} [options.applicationName]    shows up in pg_stat_activity
 */
function createPool(options = {}) {
  const env = options.env || loadEnv();
  const statementTimeoutMs = options.statementTimeoutMs != null
    ? options.statementTimeoutMs
    : env.statementTimeoutMs;

  const config = {
    connectionString: env.databaseUrl,
    max: options.max || env.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: options.applicationName || `veorec-${env.appEnv}`,
    // Long-running statements are a production hazard; migrations opt out.
    statement_timeout: statementTimeoutMs || undefined,
    idle_in_transaction_session_timeout: statementTimeoutMs || undefined,
  };
  if (env.sslMode === 'require') {
    // Managed Postgres commonly presents a provider-signed certificate; the CA
    // bundle is supplied per-deployment via DATABASE_SSL_CA when we harden this.
    config.ssl = { rejectUnauthorized: false };
  }

  const pool = new Pool(config);
  // An idle-client error must never take the process down (pg emits these on
  // network drops / server restarts); the pool discards the client itself.
  pool.on('error', (err) => {
    const msg = `[db] idle client error: ${err && err.message}`;
    if (process.env.NODE_ENV === 'test') return;
    console.error(msg);
  });
  return pool;
}

let sharedPool = null;

/** Process-wide pool for long-running services. */
function getPool(options) {
  if (!sharedPool) sharedPool = createPool(options);
  return sharedPool;
}

async function closePool() {
  if (!sharedPool) return;
  const p = sharedPool;
  sharedPool = null;
  await p.end();
}

/** Quick liveness probe: returns { ok, serverVersion, database, error }. */
async function checkConnection(pool) {
  const owned = !pool;
  const p = pool || createPool();
  try {
    const { rows } = await p.query(
      'SELECT current_database() AS database, current_user AS "user", version() AS version'
    );
    return { ok: true, database: rows[0].database, user: rows[0].user, version: rows[0].version };
  } catch (error) {
    return { ok: false, error };
  } finally {
    if (owned) await p.end().catch(() => {});
  }
}

module.exports = { createPool, getPool, closePool, checkConnection };
