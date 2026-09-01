// ─────────────────────────────────────────────────────────────────────────────
// STORAGE CONFIGURATION (T-201)
//
// This is the ONLY file that differs between Cloudflare R2 and MinIO. Both
// speak the S3 API, so there is exactly one provider implementation and two
// configurations of it — the flavour never reaches application code, and no
// business logic may branch on it.
//
// Everything comes from the environment (names reserved by T-201's .env.example
// entry, written during T-101). Nothing is hardcoded: no account ids, no keys,
// no bucket names, no endpoints. Deployed environments must be explicit —
// there are no convenience defaults outside local/test, mirroring db/src/env.js.
//
// Secrets never appear in a thrown message, a log line, or `toJSON()`. The
// describe() output is what callers may print.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const { StorageConfigError } = require('./errors');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_ENVS = ['local', 'test', 'staging', 'production'];
const FLAVOURS = ['r2', 'minio', 's3'];

// Local-only convenience defaults; must mirror docker-compose.yml + .env.example.
const LOCAL_DEFAULTS = {
  endpoint: 'http://127.0.0.1:9100',
  region: 'auto',
  accessKeyId: 'veorec_dev',
  secretAccessKey: 'veorec_local_dev_secret',
  forcePathStyle: true,
  bucket: { local: 'veorec-media-local', test: 'veorec-media-test' },
};

// A presigned URL is a bearer credential for one object. Cap its lifetime so a
// leaked link (browser history, referrer, a copied support ticket) expires.
// docs/12 §6: private media ≤ 10 min; public/CDN-cached may run longer.
const MAX_SIGNED_URL_TTL_SECONDS = 7 * 24 * 3600;  // SigV4 protocol maximum
const DEFAULT_GET_TTL_SECONDS = 600;               // 10 minutes
const DEFAULT_PUT_TTL_SECONDS = 3600;              // 1 hour — a part upload may be slow

let dotenvLoaded = false;
function loadDotenvOnce() {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  const envFile = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(envFile)) return;
  try {
    // Never overrides the real environment, so CI/production values win.
    require('dotenv').config({ path: envFile, quiet: true });
  } catch {
    // dotenv absent in a production image — the real environment is enough.
  }
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

/**
 * Resolve storage configuration.
 *
 * @param {object} [overrides] test/CLI overrides; same shape as the result
 * @returns {{
 *   appEnv: string, flavour: string, endpoint: string, region: string,
 *   bucket: string, accessKeyId: string, secretAccessKey: string,
 *   forcePathStyle: boolean, maxSignedUrlTtlSeconds: number,
 *   defaultGetTtlSeconds: number, defaultPutTtlSeconds: number,
 *   requestTimeoutMs: number, maxAttempts: number, describe: () => object
 * }}
 * @throws {StorageConfigError}
 */
function loadStorageConfig(overrides = {}) {
  loadDotenvOnce();

  const appEnv = String(overrides.appEnv || process.env.APP_ENV || 'local').toLowerCase();
  if (!APP_ENVS.includes(appEnv)) {
    throw new StorageConfigError(`APP_ENV must be one of ${APP_ENVS.join(' | ')} (got "${appEnv}")`);
  }
  const isDeployed = appEnv === 'production' || appEnv === 'staging';

  // STORAGE_PROVIDER is the name .env.example reserved in T-101. It selects a
  // CONFIGURATION flavour, not an implementation: r2, minio and s3 all resolve
  // to the same S3-compatible provider, and nothing downstream branches on it.
  const flavour = String(
    overrides.flavour || process.env.STORAGE_PROVIDER || (isDeployed ? 'r2' : 'minio')
  ).toLowerCase();
  if (!FLAVOURS.includes(flavour)) {
    throw new StorageConfigError(`STORAGE_PROVIDER must be one of ${FLAVOURS.join(' | ')} (got "${flavour}")`);
  }

  const pick = (override, envVar, localDefault) => {
    if (override !== undefined && override !== null && override !== '') return String(override);
    const fromEnv = process.env[envVar];
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
    return isDeployed ? null : localDefault;
  };

  const endpoint = pick(overrides.endpoint, 'STORAGE_ENDPOINT', LOCAL_DEFAULTS.endpoint);
  const bucket = pick(overrides.bucket, 'STORAGE_BUCKET',
    LOCAL_DEFAULTS.bucket[appEnv] || LOCAL_DEFAULTS.bucket.local);
  const accessKeyId = pick(overrides.accessKeyId, 'STORAGE_ACCESS_KEY_ID', LOCAL_DEFAULTS.accessKeyId);
  const secretAccessKey = pick(
    overrides.secretAccessKey, 'STORAGE_SECRET_ACCESS_KEY', LOCAL_DEFAULTS.secretAccessKey);
  const region = pick(overrides.region, 'STORAGE_REGION', LOCAL_DEFAULTS.region) || 'auto';

  const missing = [];
  if (!endpoint) missing.push('STORAGE_ENDPOINT');
  if (!bucket) missing.push('STORAGE_BUCKET');
  if (!accessKeyId) missing.push('STORAGE_ACCESS_KEY_ID');
  if (!secretAccessKey) missing.push('STORAGE_SECRET_ACCESS_KEY');
  if (missing.length) {
    throw new StorageConfigError(
      `missing storage configuration: ${missing.join(', ')}` +
      (isDeployed ? ` — APP_ENV=${appEnv} has no defaults and we refuse to guess` : '')
    );
  }

  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new StorageConfigError('STORAGE_ENDPOINT must be an absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new StorageConfigError('STORAGE_ENDPOINT must be http:// or https://');
  }
  // Plaintext to a remote object store would put presigned URLs and payloads on
  // the wire in clear. Loopback stays permitted so MinIO works locally.
  const isLoopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
  if (isDeployed && parsed.protocol !== 'https:') {
    throw new StorageConfigError(`STORAGE_ENDPOINT must use https:// when APP_ENV=${appEnv}`);
  }
  if (!isDeployed && parsed.protocol === 'http:' && !isLoopback) {
    throw new StorageConfigError('STORAGE_ENDPOINT may only use http:// for a loopback address');
  }

  // Bucket naming per S3/R2 rules; also stops an injected path from becoming
  // "bucket". Buckets come from configuration only, never from user input.
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) {
    throw new StorageConfigError('STORAGE_BUCKET is not a valid bucket name');
  }

  // R2 requires path-style addressing; MinIO does too unless DNS is set up.
  const forcePathStyle = overrides.forcePathStyle !== undefined
    ? !!overrides.forcePathStyle
    : bool(process.env.STORAGE_FORCE_PATH_STYLE, true);

  const num = (override, envVar, fallback) => {
    const raw = override !== undefined ? override : process.env[envVar];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new StorageConfigError(`${envVar} must be a non-negative integer`);
    return n;
  };

  const maxSignedUrlTtlSeconds = num(
    overrides.maxSignedUrlTtlSeconds, 'STORAGE_MAX_SIGNED_URL_TTL', MAX_SIGNED_URL_TTL_SECONDS);
  if (maxSignedUrlTtlSeconds < 1 || maxSignedUrlTtlSeconds > MAX_SIGNED_URL_TTL_SECONDS) {
    throw new StorageConfigError(
      `STORAGE_MAX_SIGNED_URL_TTL must be between 1 and ${MAX_SIGNED_URL_TTL_SECONDS} seconds`);
  }

  const config = {
    appEnv,
    isDeployed,
    flavour,
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle,
    maxSignedUrlTtlSeconds,
    defaultGetTtlSeconds: num(overrides.defaultGetTtlSeconds, 'STORAGE_GET_TTL', DEFAULT_GET_TTL_SECONDS),
    defaultPutTtlSeconds: num(overrides.defaultPutTtlSeconds, 'STORAGE_PUT_TTL', DEFAULT_PUT_TTL_SECONDS),
    requestTimeoutMs: num(overrides.requestTimeoutMs, 'STORAGE_REQUEST_TIMEOUT_MS', 30_000),
    maxAttempts: num(overrides.maxAttempts, 'STORAGE_MAX_ATTEMPTS', 3) || 1,
  };

  // Safe-to-log projection. Credentials are absent by construction, not masked
  // after the fact, so a future field cannot leak by being forgotten here.
  config.describe = () => ({
    appEnv: config.appEnv,
    flavour: config.flavour,
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    forcePathStyle: config.forcePathStyle,
    accessKeyId: `***${String(config.accessKeyId).slice(-4)}`,
    maxSignedUrlTtlSeconds: config.maxSignedUrlTtlSeconds,
  });
  // Guard against a caller (or a logger's deep serialiser) stringifying the
  // whole config: JSON.stringify and console.log both go through these.
  Object.defineProperty(config, 'toJSON', { value: () => config.describe(), enumerable: false });
  Object.defineProperty(config, require('util').inspect.custom, {
    value: () => `StorageConfig ${JSON.stringify(config.describe())}`,
    enumerable: false,
  });

  return config;
}

module.exports = {
  loadStorageConfig,
  MAX_SIGNED_URL_TTL_SECONDS,
  DEFAULT_GET_TTL_SECONDS,
  DEFAULT_PUT_TTL_SECONDS,
  FLAVOURS,
};
