// ─────────────────────────────────────────────────────────────────────────────
// STORAGE ERROR MODEL (T-201)
//
// The provider translates S3/R2/MinIO failures into a small, stable taxonomy.
// Callers branch on `error.code`; the HTTP layer maps codes to the wire
// contract in docs/18 §2 — the same split the repository layer uses (T-103).
//
// This layer knows NOTHING about HTTP: no status codes on the way out, no
// response shapes, no user-facing copy. A raw AWS SDK error must never escape,
// because its `message`/`$metadata` can carry the bucket name, endpoint host,
// request ids, and occasionally signature material.
//
// `retryable` is the important bit for later tasks: T-601's queue retries on
// it, and the upload protocol distinguishes "try this part again" from "this
// upload is dead". Getting the classification wrong here means either lost
// uploads or infinite retry loops, so transient/permanent is explicit.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

class StorageError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.retryable = !!options.retryable;
    this.key = options.key || null;             // object key only — never bytes
    this.operation = options.operation || null; // e.g. 'getObject'
    if (options.cause) this.cause = options.cause;
  }
}

/** The object (or version) does not exist. */
class ObjectNotFoundError extends StorageError {
  constructor(options = {}) {
    super('object_not_found', 'object not found', options);
  }
}

/** Credentials are missing/invalid, or the key is outside granted access. */
class PermissionDeniedError extends StorageError {
  constructor(options = {}) {
    super('permission_denied', 'storage permission denied', options);
  }
}

/** Precondition/state conflict — e.g. overwrite refused, bucket exists. */
class ConflictError extends StorageError {
  constructor(options = {}) {
    super('conflict', 'storage operation conflicts with current state', options);
  }
}

/** The request itself is malformed — bad key, bad argument, bad part number. */
class InvalidRequestError extends StorageError {
  constructor(message, options = {}) {
    super('invalid_request', message, options);
  }
}

/** The multipart upload id is unknown, already completed, or aborted. */
class UploadNotFoundError extends StorageError {
  constructor(options = {}) {
    super('upload_not_found', 'multipart upload not found', options);
  }
}

/** Multipart completion failed — missing/mismatched parts, bad ETag. */
class MultipartFailedError extends StorageError {
  constructor(message, options = {}) {
    super('multipart_failed', message || 'multipart upload could not be completed', options);
  }
}

/** The provider is unreachable or returned 5xx. Always retryable. */
class ProviderUnavailableError extends StorageError {
  constructor(options = {}) {
    super('provider_unavailable', 'storage provider unavailable', { ...options, retryable: true });
  }
}

/** The operation timed out. Always retryable. */
class TimeoutError extends StorageError {
  constructor(options = {}) {
    super('timeout', 'storage operation timed out', { ...options, retryable: true });
  }
}

/** Anything we could not classify. Conservatively NOT retryable. */
class UnknownStorageError extends StorageError {
  constructor(options = {}) {
    super('unknown_storage_error', 'unknown storage failure', options);
  }
}

/** Configuration is missing or invalid. Raised at construction, not per-call. */
class StorageConfigError extends StorageError {
  constructor(message) {
    super('storage_config_error', message);
  }
}

// S3 error codes we classify explicitly. R2 and MinIO both speak these.
const NOT_FOUND = new Set(['NoSuchKey', 'NotFound', 'NoSuchBucket', 'ObjectNotInActiveTierError']);
const DENIED = new Set([
  'AccessDenied', 'AllAccessDisabled', 'InvalidAccessKeyId', 'SignatureDoesNotMatch',
  'InvalidSecurity', 'ExpiredToken', 'TokenRefreshRequired', 'AccountProblem',
]);
const NO_SUCH_UPLOAD = new Set(['NoSuchUpload']);
const MULTIPART = new Set(['InvalidPart', 'InvalidPartOrder', 'EntityTooSmall', 'EntityTooLarge']);
const CONFLICT = new Set([
  'BucketAlreadyExists', 'BucketAlreadyOwnedByYou', 'PreconditionFailed',
  'InvalidBucketState', 'OperationAborted',
]);
const INVALID = new Set([
  'InvalidArgument', 'InvalidRequest', 'MalformedXML', 'InvalidObjectState',
  'KeyTooLongError', 'MissingContentLength', 'IncompleteBody', 'BadDigest',
  'InvalidDigest', 'XAmzContentSHA256Mismatch',
]);
// Transient: worth another attempt with backoff.
const TRANSIENT = new Set([
  'InternalError', 'ServiceUnavailable', 'SlowDown', 'RequestTimeout',
  'RequestTimeTooSkewed', 'ThrottlingException', 'TooManyRequests',
  'ConnectionError', 'NetworkingError', 'EconnResetError', '503 SlowDown',
]);
const TIMEOUT = new Set(['TimeoutError', 'RequestTimeout', 'RequestAbortedError']);
// Message shapes R2 uses when the real problem is credentials, not arguments.
const AUTHZ_MESSAGE = /authoriz|credential|signature|access key|secret/i;
// Node socket-level failures surface as these before any S3 code exists.
const TRANSIENT_SYSCALL = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH',
  'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'ESOCKETTIMEDOUT',
]);

/** Pull the S3 error code out of whatever shape the SDK produced. */
function errorCodeOf(err) {
  if (!err) return null;
  return err.Code || err.code || err.name || null;
}

function httpStatusOf(err) {
  const s = err && err.$metadata && err.$metadata.httpStatusCode;
  return Number.isInteger(s) ? s : null;
}

/**
 * Map a provider/SDK failure onto the taxonomy above.
 *
 * Classification order matters: an explicit S3 code beats the HTTP status,
 * because 404 means "no such key" for GET but "no such upload" for a
 * multipart part — the code disambiguates what the status cannot.
 *
 * @param {unknown} err raw SDK/socket error
 * @param {{operation?: string, key?: string}} ctx
 * @returns {StorageError}
 */
function mapStorageError(err, ctx = {}) {
  // Already ours (e.g. key validation) — pass through unchanged.
  if (err instanceof StorageError) return err;

  const code = errorCodeOf(err);
  const status = httpStatusOf(err);
  const syscall = err && (err.errno || err.syscall) ? errorCodeOf(err) : null;
  const options = { ...ctx, cause: err };

  if (code && NO_SUCH_UPLOAD.has(code)) return new UploadNotFoundError(options);
  if (code && NOT_FOUND.has(code)) return new ObjectNotFoundError(options);
  if (code && DENIED.has(code)) return new PermissionDeniedError(options);
  if (code && MULTIPART.has(code)) return new MultipartFailedError(`multipart rejected (${code})`, options);
  if (code && CONFLICT.has(code)) return new ConflictError(options);
  // Cloudflare R2 reports AUTHORIZATION failures as 400 InvalidArgument with an
  // "Authorization" message, where S3/MinIO use 403 InvalidAccessKeyId /
  // SignatureDoesNotMatch. Found against real R2. Without this, wrong or rotated
  // production credentials surface as "storage rejected the request" rather than
  // a permission problem, sending an operator down the wrong path mid-outage.
  // Narrow by design: a genuine bad-argument InvalidArgument must stay
  // invalid_request, so only an authorization-shaped message is reclassified.
  if (code === 'InvalidArgument' && AUTHZ_MESSAGE.test(String((err && err.message) || ''))) {
    return new PermissionDeniedError(options);
  }
  if (code && INVALID.has(code)) return new InvalidRequestError(`storage rejected the request (${code})`, options);
  if (code && TIMEOUT.has(code)) return new TimeoutError(options);
  if (code && TRANSIENT.has(code)) return new ProviderUnavailableError(options);
  if (syscall && TRANSIENT_SYSCALL.has(syscall)) return new ProviderUnavailableError(options);

  // Fall back to the HTTP status when the code was absent or unrecognised.
  if (status === 404) return new ObjectNotFoundError(options);
  if (status === 401 || status === 403) return new PermissionDeniedError(options);
  if (status === 409) return new ConflictError(options);
  if (status === 412) return new ConflictError(options);
  if (status === 408) return new TimeoutError(options);
  if (status === 429) return new ProviderUnavailableError(options);
  if (status && status >= 500) return new ProviderUnavailableError(options);
  if (status && status >= 400) {
    return new InvalidRequestError('storage rejected the request', options);
  }

  return new UnknownStorageError(options);
}

module.exports = {
  StorageError,
  ObjectNotFoundError,
  PermissionDeniedError,
  ConflictError,
  InvalidRequestError,
  UploadNotFoundError,
  MultipartFailedError,
  ProviderUnavailableError,
  TimeoutError,
  UnknownStorageError,
  StorageConfigError,
  mapStorageError,
  errorCodeOf,
};
