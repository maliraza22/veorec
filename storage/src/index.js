// ─────────────────────────────────────────────────────────────────────────────
// @veorec/storage — PUBLIC SURFACE (T-201)
//
// Application code imports from HERE and nowhere deeper. It must never import
// @aws-sdk/*, name a bucket, build a key by hand, or branch on whether the
// bytes live in R2 or MinIO. Swapping R2 for B2/Wasabi/S3 must be a config
// change plus (at most) a new file next to s3-provider.js — never an edit to
// business logic (docs/02 §11 provider-abstraction rule).
//
// ─── THE CONTRACT ────────────────────────────────────────────────────────────
// A StorageProvider owns OBJECT BYTES. It does not own application state, and
// it never learns about users, ownership, quota, or lifecycle:
//
//   PostgreSQL  → recording, owner, status, size_bytes, duration, upload
//                 session state, processing state, quota ledger
//   R2 (bytes)  → source media, derived MP4/HLS, thumbnails, audio, exports
//
// So there is deliberately no `provider.deleteRecording(userId, …)`. Ownership
// is resolved by a repository before any key is built, and authorization never
// happens in this package.
//
//   put/get/head/exists/delete/list      basic object operations
//   getSignedDownloadUrl                 time-limited GET, one object
//   getSignedUploadUrl                   time-limited PUT, one object
//   createMultipartUpload                begin a multipart upload
//   getSignedPartUrl                     time-limited PUT, one part
//   listParts                            parts the provider actually holds
//   completeMultipartUpload              finish; object appears atomically
//   abortMultipartUpload                 discard; safely repeatable
//
// Errors are the taxonomy in errors.js, never raw SDK errors, and carry
// `retryable` so the future queue can distinguish transient from permanent.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { loadStorageConfig } = require('./config');
const { S3StorageProvider } = require('./s3-provider');
const errors = require('./errors');
const { keys, assertKey, isValidKey } = require('./keys');

/**
 * Build a StorageProvider from configuration.
 *
 * R2 and MinIO both resolve to the S3-compatible implementation — the flavour
 * changes construction only, never behaviour, so what runs locally is the same
 * code that runs in production.
 *
 * @param {object} [options] overrides forwarded to loadStorageConfig(), plus
 *                           `client` to inject an SDK client in tests.
 * @returns {S3StorageProvider}
 */
function createStorageProvider(options = {}) {
  const { client, ...configOverrides } = options;
  const config = options.config || loadStorageConfig(configOverrides);
  return new S3StorageProvider(config, { client });
}

// Process-wide singleton, matching the shared-pool convention in @veorec/db.
let shared = null;
function storageProvider() {
  if (!shared) shared = createStorageProvider();
  return shared;
}
/** Test seam: drop the singleton so the next call rebuilds it. */
function resetStorageProvider() { shared = null; }

module.exports = {
  createStorageProvider,
  storageProvider,
  resetStorageProvider,
  loadStorageConfig,
  S3StorageProvider,
  keys,
  assertKey,
  isValidKey,
  ...errors,
};
