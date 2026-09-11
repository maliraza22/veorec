// ─────────────────────────────────────────────────────────────────────────────
// LEGACY → POSTGRESQL IDENTITY BRIDGE (prerequisite for T-304)
//
// The legacy JWT carries the LEGACY user id. Every PostgreSQL row that T-104's
// importer and T-105's dual-write produced is keyed `usr_<legacyId>`. The v1
// routers were building their ownership scope from the raw legacy id, so every
// scoped query looked for a user id that does not exist in PostgreSQL — a
// recording create failed on the users foreign key, and a scoped read simply
// found nothing.
//
// This bridge translates ONCE, at the v1 router boundary, and nowhere else.
//
// ── WHY HERE AND NOT IN requireAuth ─────────────────────────────────────────
// `requireAuth` is the SAME function instance used by 59 legacy routes. Those
// routes read `req.userId` as the legacy id to reach the JSON stores and
// Cloudinary. Translating inside it would silently repoint all of them at ids
// that mean nothing to the legacy system. So `req.userId` is left EXACTLY as it
// was, and the translated value lands on a separate property that only v1 code
// reads.
//
// ── WHY A LOOKUP AND NOT JUST A STRING ──────────────────────────────────────
// Deriving the id is not the same as the account existing. A user who signed up
// before dual-write was enabled has no PostgreSQL row at all, and without the
// check their first v1 call would surface as a foreign-key violation — a 422
// that reads like the client sent something wrong when in fact the server has
// not finished migrating them. That distinction matters during the staged
// rollout, where "how many flagged users have no mirror yet" is precisely the
// number an operator needs.
//
// The mapping itself is NOT invented here: `idFor` is the canonical
// deterministic mapping from `db/src/legacy-ids.js`, the same one the importer,
// the dual-write mirror and the reconciler all use. There is one format, in one
// place.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const path = require('path');
const { ApiError } = require('./errors');

/** The canonical mapping (T-104). Injectable only so tests can assert it is used. */
function canonicalIdFor() {
  // Same module server/dualwrite.js uses, so the two can never diverge.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(path.join(__dirname, '..', '..', 'db', 'src', 'legacy-ids.js')).idFor;
}

/**
 * Express middleware. Runs immediately after `requireAuth` on the v1 routers.
 *
 * Sets:
 *   req.legacyUserId  the untouched legacy id (explicit, for clarity)
 *   req.pgUserId      `usr_<legacyId>` — what v1 ownership scopes use
 *
 * Leaves `req.userId` alone, because legacy routes still depend on it.
 *
 * @param {{repositories: () => object, idFor?: Function, logger?: object}} deps
 */
function createIdentityBridge(deps) {
  const { repositories, idFor = canonicalIdFor(), logger = console } = deps;

  return async function identityBridge(req, res, next) {
    try {
      const legacyUserId = req.userId;
      if (!legacyUserId) {
        // requireAuth should have rejected this already; refuse rather than
        // continue with an undefined owner, which would scope a query to
        // "usr_undefined" and could match a real row if one ever existed.
        return next(new ApiError(401, 'unauthorized', 'Authentication required'));
      }

      const pgUserId = idFor('usr', legacyUserId);
      req.legacyUserId = legacyUserId;
      req.pgUserId = pgUserId;

      // Existence check on the caller's OWN id, derived from their own verified
      // token — not an enumeration vector, and it never reveals anything about
      // another account.
      const user = await repositories().users.findById(pgUserId);
      if (!user) {
        (logger.warn ? logger : console).warn(
          { pg_user_id: pgUserId, request_id: req.id || null },
          'v1 request from an account with no PostgreSQL mirror — the migration has not reached this user');
        // 503, not 403 or 404: the caller is legitimately authenticated and has
        // done nothing wrong. This is a server-side migration state, and it is
        // temporary by definition, so a client may retry later.
        return next(new ApiError(503, 'account_not_migrated',
          'Your account is still being migrated. Please try again shortly.'));
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * The ONE place a v1 ownership scope is constructed.
 *
 * Every scoped repository call in every v1 router goes through this, so the
 * translation cannot be applied inconsistently or forgotten by a future router.
 * It refuses to build a scope from an untranslated request rather than falling
 * back to the legacy id — a silent fallback would reintroduce exactly the bug
 * this bridge exists to fix, and it would do so invisibly.
 */
function scopeOf(req) {
  if (!req || !req.pgUserId) {
    throw new ApiError(500, 'internal_error', 'Something went wrong on our side.');
  }
  return { userId: req.pgUserId };
}

module.exports = { createIdentityBridge, scopeOf, canonicalIdFor };
