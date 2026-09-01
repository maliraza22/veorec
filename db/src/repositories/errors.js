// ─────────────────────────────────────────────────────────────────────────────
// REPOSITORY ERROR MODEL (T-103)
//
// Repositories translate PostgreSQL failures into a small, stable set of domain
// errors. Callers branch on `error.code`; the HTTP layer maps those codes to
// the wire contract in docs/18 §2.
//
// Repositories deliberately know NOTHING about HTTP: no status codes, no
// response shapes, no user-facing copy. A raw pg error must never escape this
// layer — `constraint`/`detail` can leak column values and table structure.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

class RepositoryError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.entity = options.entity || null;
    this.constraint = options.constraint || null;   // constraint NAME only, never values
    this.retryable = !!options.retryable;
    if (options.cause) this.cause = options.cause;
  }
}

/** The row does not exist, or is not visible in the caller's scope. */
class NotFoundError extends RepositoryError {
  constructor(entity, options = {}) {
    super('not_found', `${entity} not found`, { ...options, entity });
  }
}

/** Unique violation — the row already exists. */
class ConflictError extends RepositoryError {
  constructor(entity, options = {}) {
    super('conflict', `${entity} already exists`, { ...options, entity });
  }
}

/** CHECK / FOREIGN KEY / NOT NULL violation — the write is not valid. */
class ConstraintViolationError extends RepositoryError {
  constructor(entity, options = {}) {
    super('constraint_violation', `${entity} violates a database constraint`, { ...options, entity });
  }
}

/** The operation is not legal for the row's current state (domain rule). */
class InvalidStateError extends RepositoryError {
  constructor(entity, message, options = {}) {
    super('invalid_state', message, { ...options, entity });
  }
}

/** Infrastructure failure. `retryable` distinguishes transient from terminal. */
class DatabaseError extends RepositoryError {
  constructor(message, options = {}) {
    super('database_error', message, options);
  }
}

// PostgreSQL SQLSTATE classes we care about.
const PG = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  NOT_NULL_VIOLATION: '23502',
  CHECK_VIOLATION: '23514',
  EXCLUSION_VIOLATION: '23P01',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  LOCK_NOT_AVAILABLE: '55P03',
  CONNECTION_FAILURE: '08006',
  CONNECTION_DOES_NOT_EXIST: '08003',
  ADMIN_SHUTDOWN: '57P01',
  QUERY_CANCELED: '57014',
};

const TRANSIENT = new Set([
  PG.SERIALIZATION_FAILURE, PG.DEADLOCK_DETECTED, PG.LOCK_NOT_AVAILABLE,
  PG.CONNECTION_FAILURE, PG.CONNECTION_DOES_NOT_EXIST, PG.ADMIN_SHUTDOWN,
]);

/**
 * Find the underlying pg error. Drizzle wraps driver failures (DrizzleQueryError),
 * so the SQLSTATE lives on `cause` — sometimes several levels down.
 */
function unwrapPgError(err, depth = 0) {
  if (!err || depth > 5) return null;
  if (typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) return err;
  return unwrapPgError(err.cause, depth + 1);
}

/** Map a driver error onto the domain error model. */
function mapPgError(err, entity = 'record') {
  if (err instanceof RepositoryError) return err;
  const pg = unwrapPgError(err);
  const code = pg && pg.code;
  const opts = { cause: err, constraint: (pg && pg.constraint) || null };

  switch (code) {
    case PG.UNIQUE_VIOLATION:
      return new ConflictError(entity, opts);
    case PG.FOREIGN_KEY_VIOLATION:
    case PG.NOT_NULL_VIOLATION:
    case PG.CHECK_VIOLATION:
    case PG.EXCLUSION_VIOLATION:
      return new ConstraintViolationError(entity, opts);
    default:
      if (TRANSIENT.has(code)) {
        return new DatabaseError(`transient database failure (${code})`, { ...opts, entity, retryable: true });
      }
      // Deliberately generic: the original error is attached as `cause` for
      // structured logging, never for the response body.
      return new DatabaseError(`database operation failed${code ? ` (${code})` : ''}`, { ...opts, entity });
  }
}

/** Run a database operation, translating any driver error. */
async function exec(entity, fn) {
  try {
    return await fn();
  } catch (err) {
    throw mapPgError(err, entity);
  }
}

module.exports = {
  RepositoryError, NotFoundError, ConflictError, ConstraintViolationError,
  InvalidStateError, DatabaseError, mapPgError, unwrapPgError, exec, PG,
};
