// ─────────────────────────────────────────────────────────────────────────────
// /api/v1 ERROR CONTRACT (T-301)
//
// One place turns a domain error into the wire shape from docs/08 §2:
//
//   { error: { code, message, upgradeRequired?, details?, requestId } }
//
// The legacy API answers a FLAT `{error, code, upgradeRequired}` and must keep
// doing so — `/api/v1` uses the nested shape, and the two never mix.
//
// Nothing below leaks an internal error. A raw PostgreSQL error carries table
// and column names and sometimes row VALUES; a raw S3/R2 error carries the
// bucket, the endpoint host and request ids. Both are mapped to a code, and the
// original is logged server-side only.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

/** An error the API deliberately shows the caller. */
class ApiError extends Error {
  constructor(status, code, message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.upgradeRequired = options.upgradeRequired || undefined;
    this.details = options.details || undefined;
    this.meta = options.meta || undefined;
    if (options.cause) this.cause = options.cause;
  }
}

const badRequest = (code, message, o) => new ApiError(400, code, message, o);
const unauthorized = (message = 'Authentication required') => new ApiError(401, 'unauthorized', message);
const forbidden = (code, message, o) => new ApiError(403, code, message, o);
const notFound = (code, message) => new ApiError(404, code, message);
const conflict = (code, message, o) => new ApiError(409, code, message, o);
const unprocessable = (code, message, o) => new ApiError(422, code, message, o);

// Repository error codes (T-103) → wire codes. A repository NotFound for an
// owned entity is reported as 404 rather than 403: telling an attacker that a
// session exists but belongs to someone else is itself a disclosure, so the
// scoped lookup makes "not yours" and "not there" indistinguishable.
const REPO_STATUS = {
  not_found: [404, 'upload_session_not_found'],
  conflict: [409, 'conflict'],
  constraint_violation: [422, 'invalid_request'],
  invalid_state: [409, 'invalid_state'],
  database_error: [503, 'service_unavailable'],
};

// Storage taxonomy (T-201) → wire codes. `retryable` decides 503 vs 4xx.
const STORAGE_STATUS = {
  object_not_found: [404, 'object_not_found'],
  permission_denied: [503, 'storage_unavailable'],   // our credentials, not the caller's
  upload_not_found: [409, 'upload_session_conflict'],
  multipart_failed: [422, 'upload_manifest_invalid'],
  invalid_request: [422, 'upload_manifest_invalid'],
  conflict: [409, 'conflict'],
  provider_unavailable: [503, 'storage_unavailable'],
  timeout: [503, 'storage_unavailable'],
  unknown_storage_error: [500, 'internal_error'],
  storage_config_error: [500, 'internal_error'],
};

/** Translate any thrown value into an ApiError. Never returns raw internals. */
function toApiError(err) {
  if (err instanceof ApiError) return err;

  const code = err && err.code;
  if (code && REPO_STATUS[code]) {
    const [status, wire] = REPO_STATUS[code];
    return new ApiError(status, wire, publicMessage(wire), { cause: err });
  }
  if (code && STORAGE_STATUS[code]) {
    const [status, wire] = STORAGE_STATUS[code];
    return new ApiError(status, wire, publicMessage(wire), { cause: err });
  }
  return new ApiError(500, 'internal_error', 'Something went wrong on our side.', { cause: err });
}

function publicMessage(wire) {
  switch (wire) {
    case 'upload_session_not_found': return 'Upload session not found.';
    case 'object_not_found': return 'The uploaded object could not be found.';
    case 'storage_unavailable': return 'Storage is temporarily unavailable. Please retry.';
    case 'upload_manifest_invalid': return 'The upload manifest is not valid.';
    case 'upload_session_conflict': return 'This upload session is no longer usable.';
    case 'invalid_state': return 'That is not valid for the current state of this upload.';
    case 'service_unavailable': return 'Temporarily unavailable. Please retry.';
    case 'conflict': return 'That conflicts with the current state.';
    default: return 'The request could not be completed.';
  }
}

/**
 * Express error handler for the v1 router.
 * Logs the real cause; sends only the contract.
 */
function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const api = toApiError(err);
    const requestId = req.id || null;

    if (api.status >= 500) {
      (logger && logger.error ? logger : console).error({
        request_id: requestId, code: api.code,
        // The cause is logged, never sent.
        err: { message: String((api.cause && api.cause.message) || api.message).slice(0, 300) },
      }, 'v1 upload API error');
    }

    res.status(api.status).json({
      error: {
        code: api.code,
        message: api.message,
        ...(api.upgradeRequired ? { upgradeRequired: true } : {}),
        ...(api.details ? { details: api.details } : {}),
        ...(api.meta ? { meta: api.meta } : {}),
        requestId,
      },
    });
  };
}

module.exports = {
  ApiError, toApiError, errorHandler,
  badRequest, unauthorized, forbidden, notFound, conflict, unprocessable,
};
