// ─────────────────────────────────────────────────────────────────────────────
// ENVIRONMENT RESOLUTION + SAFETY GUARDS (T-101)
//
// One place decides which database this process talks to and whether
// destructive operations are permitted. Rules (docs/02 §6, docs/17 §9):
//   • APP_ENV ∈ local | test | staging | production.
//   • Convenience defaults exist ONLY for local/test. staging/production must
//     supply DATABASE_URL explicitly — we refuse to guess and never fall back
//     to a local database.
//   • Destructive commands (db:reset) are allowed in local/test only, and are
//     ALWAYS refused for production.
//   • Credentials are never printed: use redactUrl() for any log/CLI output.
//
// Validation is intentionally hand-rolled (no schema library) — this module has
// four inputs. The zod-based boot schema described in docs/02 §6 belongs to the
// API server and arrives with the API work, not here.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_ENVS = ['local', 'test', 'staging', 'production'];

// Local-only convenience defaults. Must mirror docker-compose.yml + .env.example.
const LOCAL_DEFAULTS = {
  local: 'postgres://veorec:veorec_local_dev@127.0.0.1:5433/veorec',
  test: 'postgres://veorec:veorec_local_dev@127.0.0.1:5433/veorec_test',
};

let dotenvLoaded = false;
function loadDotenvOnce() {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  const envFile = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(envFile)) return;
  try {
    // dotenv never overrides variables already present in the real environment,
    // so CI/production values always win over a stray local .env file.
    require('dotenv').config({ path: envFile, quiet: true });
  } catch (e) {
    // dotenv missing (e.g. production image installed with --omit=dev): the
    // real environment is authoritative anyway.
  }
}

class EnvError extends Error {
  constructor(message) { super(message); this.name = 'EnvError'; }
}

/** Replace the password in a postgres URL so it can be safely logged. */
function redactUrl(url) {
  if (typeof url !== 'string' || !url) return String(url);
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    // Not a parseable URL — redact anything that looks like credentials.
    return url.replace(/\/\/[^@/]*@/, '//***@');
  }
}

/**
 * Resolve the effective environment.
 * @param {{appEnv?: string, databaseUrl?: string}} [overrides] for tests
 */
function loadEnv(overrides = {}) {
  loadDotenvOnce();

  const appEnv = String(overrides.appEnv || process.env.APP_ENV || 'local').toLowerCase();
  if (!APP_ENVS.includes(appEnv)) {
    throw new EnvError(`APP_ENV must be one of ${APP_ENVS.join(' | ')} (got "${appEnv}")`);
  }

  const isProduction = appEnv === 'production';
  const isDeployed = appEnv === 'production' || appEnv === 'staging';

  let databaseUrl = overrides.databaseUrl;
  if (!databaseUrl) {
    databaseUrl = appEnv === 'test'
      ? (process.env.DATABASE_URL_TEST || (isDeployed ? null : LOCAL_DEFAULTS.test))
      : (process.env.DATABASE_URL || (isDeployed ? null : LOCAL_DEFAULTS.local));
  }
  if (!databaseUrl) {
    throw new EnvError(
      `${appEnv === 'test' ? 'DATABASE_URL_TEST' : 'DATABASE_URL'} is required when APP_ENV=${appEnv}. ` +
      'Deployed environments must be configured explicitly — there is no default.'
    );
  }
  if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
    throw new EnvError('DATABASE_URL must be a postgres:// or postgresql:// connection string');
  }

  // TLS: default to require when deployed, disable locally. Explicit wins.
  const sslMode = (process.env.DATABASE_SSL || (isDeployed ? 'require' : 'disable')).toLowerCase();
  if (!['disable', 'require'].includes(sslMode)) {
    throw new EnvError('DATABASE_SSL must be "disable" or "require"');
  }

  const poolMax = Number(process.env.DATABASE_POOL_MAX || 10);
  if (!Number.isInteger(poolMax) || poolMax < 1) {
    throw new EnvError('DATABASE_POOL_MAX must be a positive integer');
  }
  const statementTimeoutMs = Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS || 30_000);
  if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs < 0) {
    throw new EnvError('DATABASE_STATEMENT_TIMEOUT_MS must be a non-negative integer');
  }

  return {
    appEnv,
    isProduction,
    isDeployed,
    databaseUrl,
    databaseUrlRedacted: redactUrl(databaseUrl),
    sslMode,
    poolMax,
    statementTimeoutMs,
    // Destructive schema operations: local/test only, never production.
    destructiveAllowed: appEnv === 'local' || appEnv === 'test',
    repoRoot: REPO_ROOT,
    migrationsFolder: path.join(REPO_ROOT, 'db', 'migrations'),
  };
}

/** Throw unless this environment permits dropping/recreating the schema. */
function assertDestructiveAllowed(env, operation = 'destructive operation') {
  if (env.destructiveAllowed) return;
  throw new EnvError(
    `Refusing to run ${operation}: APP_ENV=${env.appEnv}. ` +
    'Destructive schema commands are permitted only when APP_ENV is local or test.'
  );
}

module.exports = { loadEnv, assertDestructiveAllowed, redactUrl, EnvError, APP_ENVS, REPO_ROOT };
