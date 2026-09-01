// ─────────────────────────────────────────────────────────────────────────────
// SCOPE — the authorization context every owned-data query runs in (T-103).
//
// Rule (docs/17 §12): a repository method that touches user-owned data takes a
// Scope as its FIRST argument and applies the ownership predicate itself. The
// caller can never "forget the WHERE clause", because there is no unscoped
// entry point for owned data.
//
// The few operations that genuinely have no user scope — public watch pages,
// background workers, admin tooling — use explicitly named methods
// (`*ForPublicWatch`, `*System`, `*AsAdmin`). Those names are intentionally
// awkward and greppable: authorization for them lives in the authz layer
// (docs/12), not here.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { RepositoryError } = require('./errors');

class ScopeError extends RepositoryError {
  constructor(message) { super('invalid_scope', message); }
}

/**
 * @typedef {{ userId: string, workspaceId?: string|null }} Scope
 */

/** Validate and normalise a Scope. Throws rather than silently widening. */
function requireScope(scope) {
  if (!scope || typeof scope !== 'object') {
    throw new ScopeError('a scope ({ userId }) is required for this operation');
  }
  const { userId, workspaceId } = scope;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new ScopeError('scope.userId must be a non-empty string');
  }
  if (workspaceId != null && (typeof workspaceId !== 'string' || workspaceId.length === 0)) {
    throw new ScopeError('scope.workspaceId must be a non-empty string when present');
  }
  return { userId, workspaceId: workspaceId ?? null };
}

/** Build a scope from an authenticated user id. */
const scopeOf = (userId, workspaceId = null) => requireScope({ userId, workspaceId });

/** Guard for the deliberately unscoped surface: forces an explicit reason. */
function requireSystemReason(reason) {
  if (typeof reason !== 'string' || reason.trim().length < 3) {
    throw new ScopeError('unscoped (system) repository calls must state a reason, e.g. "probe worker"');
  }
  return reason.trim();
}

module.exports = { requireScope, scopeOf, requireSystemReason, ScopeError };
