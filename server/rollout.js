// ─────────────────────────────────────────────────────────────────────────────
// CUTOVER ROLLOUT — deterministic bucketing + eligibility (T-304)
//
// Decides, per user, whether the v1 upload path is used. The SERVER decides;
// the client is told the answer and obeys. A client claiming membership in the
// rollout is never believed.
//
// ── SAFE BY DEFAULT ─────────────────────────────────────────────────────────
// Absent, malformed, or out-of-range configuration all resolve to 0% — the
// legacy path. A configuration mistake must never be the thing that switches
// every user onto the new path; it must fail toward the behaviour production
// already has.
//
// ── DETERMINISTIC, AND MONOTONIC ────────────────────────────────────────────
// A user's bucket is a pure function of their identity: `sha256(SALT:userId)`
// reduced to 0–99. Selected iff `bucket < percent`.
//
// There is no randomness, no per-request state and no counter, because all
// three would make a user flip between paths between requests — a recorder that
// opened a v1 session and then resumed onto the legacy path would lose the
// upload it had already started.
//
// Because selection is a `<` comparison against a FIXED bucket, staging the
// rollout only ever adds users:
//
//   bucket 7  → selected at 10, 50 and 100
//   bucket 40 → selected at 50 and 100, never at 10
//
// so the 10% population is a strict subset of the 50% population, which is a
// strict subset of 100%. Raising the percentage never reshuffles anyone, and
// lowering it removes users in the reverse order — which is what makes a
// partial rollback predictable rather than a new random draw.
//
// The SALT is a fixed constant on purpose. Changing it re-buckets everybody, so
// it must never be made configurable or derived from anything that varies.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const crypto = require('crypto');

const SALT = 'veorec-upload-cutover-v1';
const BUCKETS = 100;

/** Every decision a client-config lookup can produce. */
const DECISION = {
  // v1 is switched off entirely, or the rollout is at 0%.
  legacyDisabled: 'legacy_disabled',
  // The rollout is live, but this user's bucket is outside the percentage.
  legacyRollout: 'legacy_rollout',
  // Selected for the new path.
  v1Rollout: 'v1_rollout',
  // Selected by bucket, but this account has no PostgreSQL mirror yet, so the
  // v1 API could not serve it. Reported as ITS OWN reason, never folded into a
  // generic "legacy" — otherwise a known, fixable population would be invisible
  // behind a healthy-looking success rate.
  accountNotMigrated: 'account_not_migrated',
};

/** Stable 0–99 bucket for a user. Pure; no clock, no randomness, no state. */
function bucketFor(userId) {
  const digest = crypto.createHash('sha256').update(`${SALT}:${String(userId)}`).digest();
  // First 4 bytes as an unsigned 32-bit integer, then modulo the bucket count.
  return digest.readUInt32BE(0) % BUCKETS;
}

/**
 * Resolve the rollout percentage from the environment.
 * Anything not a clean integer in [0, 100] is treated as 0 — see SAFE BY
 * DEFAULT above.
 */
function resolvePercent(raw) {
  if (raw === undefined || raw === null) return 0;
  // A PLAIN decimal integer only. Number() alone would accept '1e2', ' 100 '
  // and '0x64' as 100 — a typo in the deploy configuration must not be able to
  // read as a full rollout.
  if (!/^[0-9]{1,3}$/.test(String(raw))) return 0;
  const n = Number(raw);
  if (n < 0 || n > BUCKETS) return 0;
  return n;
}

/** Is the v1 upload API even mounted? Only the literal 'true' counts. */
const v1ApiEnabled = (env = process.env) => env.V1_UPLOAD_API === 'true';

/**
 * Decide the upload path for one user.
 *
 * @param {object} opts
 * @param {string} opts.userId              stable legacy user id
 * @param {object} [opts.env]
 * @param {boolean} [opts.hasPostgresMirror] result of the mirror check; only
 *        consulted when the user is otherwise selected, so an unselected user
 *        costs no database work.
 * @returns {{path:'legacy'|'v1', decision:string, bucket:number, percent:number}}
 */
function decide({ userId, env = process.env, hasPostgresMirror = null }) {
  const percent = resolvePercent(env.V1_UPLOAD_ROLLOUT_PERCENT);
  const enabled = v1ApiEnabled(env);

  if (!enabled || percent === 0) {
    return { path: 'legacy', decision: DECISION.legacyDisabled, bucket: null, percent: enabled ? percent : 0 };
  }

  const bucket = bucketFor(userId);
  if (bucket >= percent) {
    return { path: 'legacy', decision: DECISION.legacyRollout, bucket, percent };
  }

  // Selected — but the v1 API cannot serve an account with no mirror. Send it
  // to legacy (so the upload still succeeds) and record WHY, so the population
  // is counted rather than hidden.
  if (hasPostgresMirror === false) {
    return { path: 'legacy', decision: DECISION.accountNotMigrated, bucket, percent };
  }

  return { path: 'v1', decision: DECISION.v1Rollout, bucket, percent };
}

// ── WEB UPLOAD GATE (T-305) ─────────────────────────────────────────────────
// A separate, plain on/off switch for the web editor's upload path. It is
// deliberately NOT the extension rollout: no percentage, no bucket, no salt.
// Enabling it does not move a single extension user, and the extension
// percentage cannot enable it. The two surfaces have different clients and
// different risk profiles, and coupling them would make each impossible to
// roll back on its own.
//
// It also cannot turn the v1 API on: if the routers are not mounted, a "v1"
// answer would only send the browser to a 404, so the truthful — and safe —
// answer is legacy. Neither flag implies the other.
const WEB_DECISION = {
  legacyDisabled: 'web_legacy_disabled',
  v1Enabled: 'web_v1_enabled',
  accountNotMigrated: 'account_not_migrated',
};

/** Only the literal 'true' enables the web path. Anything else is OFF. */
function webUploadEnabled(env = process.env) {
  return env.V1_WEB_UPLOAD === 'true' && v1ApiEnabled(env);
}

function decideWeb({ env = process.env, hasPostgresMirror = null } = {}) {
  if (!webUploadEnabled(env)) return { path: 'legacy', decision: WEB_DECISION.legacyDisabled };
  // Same rule as the extension: an account with no PostgreSQL mirror cannot be
  // served by v1, and the reason is recorded rather than hidden.
  if (hasPostgresMirror === false) return { path: 'legacy', decision: WEB_DECISION.accountNotMigrated };
  return { path: 'v1', decision: WEB_DECISION.v1Enabled };
}

// ── T-802: the WATCH PAGE gate ───────────────────────────────────────────────
// A third, independent on/off gate: anonymous viewers read it from the PUBLIC
// config route (they have no Bearer), so it is per-deployment, never per-user.
const WATCH_DECISION = {
  legacyDisabled: 'watch_legacy_disabled',
  v1Enabled: 'watch_v1_enabled',
};

/** Only the literal 'true' enables the v1 watch page, and only while the v1 API is on. */
function watchPageEnabled(env = process.env) {
  return env.V1_WATCH_PAGE === 'true' && v1ApiEnabled(env);
}

function decideWatch({ env = process.env } = {}) {
  return watchPageEnabled(env)
    ? { path: 'v1', decision: WATCH_DECISION.v1Enabled }
    : { path: 'legacy', decision: WATCH_DECISION.legacyDisabled };
}

/** The wire body for GET /api/client-config/public — no auth, no identifiers. */
function publicConfigBody(watchDecision = { path: 'legacy' }) {
  return {
    watch: { path: watchDecision.path, v1Enabled: watchDecision.path === 'v1' },
    refreshAfterSeconds: 300,
  };
}

/** The wire body for GET /api/client-config. Contains no identifiers. */
function clientConfigBody(decision, webDecision = { path: 'legacy' }, watchDecision = { path: 'legacy' }) {
  return {
    upload: {
      // The client obeys this; it never computes eligibility itself.
      path: decision.path,
      v1Enabled: decision.path === 'v1',
    },
    // T-305: the web editor's decision, independent of `upload` above.
    webUpload: {
      path: webDecision.path,
      v1Enabled: webDecision.path === 'v1',
    },
    // T-802: the watch page's decision (also served without auth on /client-config/public).
    watch: {
      path: watchDecision.path,
      v1Enabled: watchDecision.path === 'v1',
    },
    // Advisory only — a client may refresh sooner. Short, so a rollback reaches
    // clients quickly rather than waiting out a long cache.
    refreshAfterSeconds: 300,
  };
}

module.exports = {
  decide, bucketFor, resolvePercent, clientConfigBody, v1ApiEnabled,
  decideWeb, webUploadEnabled, WEB_DECISION,
  decideWatch, watchPageEnabled, publicConfigBody, WATCH_DECISION,
  DECISION, SALT, BUCKETS,
};
