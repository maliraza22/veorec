// ─────────────────────────────────────────────────────────────────────────────
// BUCKET POLICY: CORS + LIFECYCLE (T-202)
//
// Pure, provider-neutral builders. These functions describe WHAT the bucket
// policy must be; provisioner.js applies it. Keeping them side-effect free is
// what lets the dangerous properties be asserted without any infrastructure.
//
// THE SAFETY PROPERTY THAT MATTERS MOST
// A lifecycle rule deletes user data on a timer, with no application involved
// and no undo. A misplaced prefix here would silently destroy recordings weeks
// later, and nothing in the app would report it. So object EXPIRATION is
// confined to the temporary namespace (uploads-tmp/) and the durable prefixes
// — sources/ derived/ audio/ renders/ — must never appear in an expiring rule.
// assertNoDurableExpiry() enforces that, and a test asserts it for every
// generated configuration.
//
// Lifecycle is NOT quota accounting and NOT user deletion. Releasing quota and
// deleting a user's recording are application operations against PostgreSQL
// (T-306 / later tasks); these rules only sweep storage-level debris.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { PREFIX } = require('./keys');
const { StorageConfigError } = require('./errors');

// docs/02 §2.7 + docs/06 §8/§11: incomplete multiparts auto-abort at 48h.
// S3/R2 lifecycle granularity is DAYS, so 48h is expressed as 2 days.
const ABORT_INCOMPLETE_MULTIPART_DAYS = 2;
const UPLOADS_TMP_EXPIRY_DAYS = 2;

// Prefixes holding durable media. NONE of these may ever carry an expiry rule.
const DURABLE_PREFIXES = [PREFIX.sources, PREFIX.derived, PREFIX.audio, PREFIX.renders];
const TEMP_PREFIX = PREFIX.uploadsTmp;

const RULE_ID = {
  abortIncomplete: 'veorec-abort-incomplete-multipart',
  expireUploadsTmp: 'veorec-expire-uploads-tmp',
};

// ── CORS ─────────────────────────────────────────────────────────────────────

// The browser PUTs parts straight to R2 and GETs media straight from it, so the
// BUCKET needs its own CORS policy. This is distinct from the API's CORS
// allowlist (docs/17 §4) — that governs calls to our own endpoints, which is
// why docs/17 can call presigned PUTs "outside CORS concerns" without
// contradicting this file.
const CORS_METHODS = ['GET', 'HEAD', 'PUT'];

// Request headers the browser may send on a presigned upload.
// Content-Length is deliberately absent: it is a forbidden header name that the
// browser sets itself and script cannot override, so listing it would be
// misleading. It is still SIGNED into the URL (T-201), which is what actually
// enforces the byte ceiling.
const CORS_REQUEST_HEADERS = [
  'content-type',
  'x-amz-checksum-crc32c', // docs/06 §9 — storage verifies part integrity
];

// Response headers script must be able to READ.
// ETag is not optional: the client collects each part's ETag to build the
// complete-multipart manifest (docs/06 §7). Without it exposed, every
// browser-direct multipart upload fails at completion.
const CORS_EXPOSE_HEADERS = ['ETag', 'x-amz-checksum-crc32c'];

const DEFAULT_CORS_MAX_AGE_SECONDS = 3600;

/**
 * Validate one allowed origin.
 * Wildcards are refused outright: the bucket serves private user media, and a
 * "*" origin would let any site on the internet drive a presigned URL that
 * leaked into a page.
 */
function assertOrigin(origin) {
  if (typeof origin !== 'string' || !origin.trim()) {
    throw new StorageConfigError('CORS origin must be a non-empty string');
  }
  const value = origin.trim();
  if (value.includes('*')) {
    throw new StorageConfigError(
      `CORS origin "${value}" contains a wildcard; the media bucket requires explicit origins`);
  }
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(value)) return value; // extension id
  let url;
  try { url = new URL(value); } catch {
    throw new StorageConfigError(`CORS origin "${value}" is not a valid origin`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new StorageConfigError(`CORS origin "${value}" must be http(s) or chrome-extension`);
  }
  // An origin is scheme://host[:port] and nothing else — a path or query here
  // would silently never match, producing CORS failures that look like bugs.
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new StorageConfigError(`CORS origin "${value}" must not contain a path, query or fragment`);
  }
  return url.origin;
}

/**
 * Build the bucket CORS configuration from resolved storage config.
 * @param {{corsOrigins: string[], corsMaxAgeSeconds?: number, isDeployed?: boolean}} config
 */
function buildCorsConfiguration(config) {
  const origins = (config.corsOrigins || []).map(assertOrigin);
  if (origins.length === 0) {
    throw new StorageConfigError(
      'STORAGE_CORS_ORIGINS is empty — browser-direct uploads need at least one explicit origin');
  }
  if (config.isDeployed && origins.some((o) => o.startsWith('http://'))) {
    throw new StorageConfigError('deployed CORS origins must use https:// (or chrome-extension://)');
  }
  return {
    CORSRules: [{
      ID: 'veorec-browser-direct-media',
      AllowedOrigins: [...new Set(origins)],
      AllowedMethods: [...CORS_METHODS],
      AllowedHeaders: [...CORS_REQUEST_HEADERS],
      ExposeHeaders: [...CORS_EXPOSE_HEADERS],
      MaxAgeSeconds: config.corsMaxAgeSeconds || DEFAULT_CORS_MAX_AGE_SECONDS,
    }],
  };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Build the bucket lifecycle configuration.
 *
 * Rule 1 — abort incomplete multipart uploads, bucket-wide, after 48h.
 *   Bucket-wide is deliberate and safe: AbortIncompleteMultipartUpload acts
 *   ONLY on multipart uploads that were never completed. It cannot touch a
 *   finished object, so it needs no prefix guard — and scoping it to one prefix
 *   would leak parts from uploads initiated anywhere else (docs/06 §11 writes
 *   sources via multipart directly to sources/, so an uploads-tmp/-only rule
 *   would miss exactly the uploads that matter).
 *   This is a BACKSTOP. The authoritative cleanup is the hourly expiry job
 *   (docs/06 §8), which also releases the quota reservation — something a
 *   lifecycle rule cannot do.
 *
 * Rule 2 — expire objects under uploads-tmp/ after 48h.
 *   The only rule that deletes objects, and it is confined to the scratch
 *   namespace. Durable media is never expired by a timer.
 */
function buildLifecycleConfiguration() {
  const rules = [
    {
      ID: RULE_ID.abortIncomplete,
      Status: 'Enabled',
      Filter: { Prefix: '' },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: ABORT_INCOMPLETE_MULTIPART_DAYS },
    },
    {
      ID: RULE_ID.expireUploadsTmp,
      Status: 'Enabled',
      Filter: { Prefix: `${TEMP_PREFIX}/` },
      Expiration: { Days: UPLOADS_TMP_EXPIRY_DAYS },
    },
  ];
  assertNoDurableExpiry(rules);
  return { Rules: rules };
}

/**
 * Refuse any configuration that could expire durable media.
 *
 * Checks the rules that actually DELETE (Expiration / NoncurrentVersionExpiration).
 * An abort-incomplete-multipart rule is exempt by construction — it cannot
 * affect a completed object — and is asserted separately.
 *
 * @throws {StorageConfigError}
 */
function assertNoDurableExpiry(rules) {
  for (const rule of rules || []) {
    const deletes = !!(rule.Expiration || rule.NoncurrentVersionExpiration);
    if (!deletes) continue;
    const prefix = (rule.Filter && rule.Filter.Prefix !== undefined)
      ? rule.Filter.Prefix : (rule.Prefix || '');
    if (prefix === '') {
      throw new StorageConfigError(
        `lifecycle rule "${rule.ID}" expires objects bucket-wide — that would delete durable media`);
    }
    if (!prefix.startsWith(`${TEMP_PREFIX}/`)) {
      throw new StorageConfigError(
        `lifecycle rule "${rule.ID}" expires objects under "${prefix}", which is not the ` +
        `temporary namespace "${TEMP_PREFIX}/" — durable media must never expire on a timer`);
    }
    for (const durable of DURABLE_PREFIXES) {
      if (prefix.startsWith(`${durable}/`) || prefix === durable) {
        throw new StorageConfigError(
          `lifecycle rule "${rule.ID}" targets the durable prefix "${durable}"`);
      }
    }
  }
  return rules;
}

module.exports = {
  buildCorsConfiguration,
  buildLifecycleConfiguration,
  assertNoDurableExpiry,
  assertOrigin,
  ABORT_INCOMPLETE_MULTIPART_DAYS,
  UPLOADS_TMP_EXPIRY_DAYS,
  DURABLE_PREFIXES,
  TEMP_PREFIX,
  RULE_ID,
  CORS_METHODS,
  CORS_REQUEST_HEADERS,
  CORS_EXPOSE_HEADERS,
  DEFAULT_CORS_MAX_AGE_SECONDS,
};
