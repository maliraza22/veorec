// SESSION TOKENS (T-1302, docs/17 §2).
//
// Opaque 256-bit tokens (`vs_` + 43 base64url chars); only sha256(token) is
// stored and matched (`sessions.token_hash`). 30-day rolling expiry: a session
// used within the window is extended, quietly, at most once per `touchEveryMs`.
// Revocation is a row update — logout (self), password change/reset (all
// others / all), admin (all for a user). Replaces the irrevocable 30-day JWT.
'use strict';

const crypto = require('crypto');

const PREFIX = 'vs_';
const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 5 * 60 * 1000;

const isSessionToken = (token) => typeof token === 'string' && token.startsWith(PREFIX) && token.length >= PREFIX.length + 40;
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const mintToken = () => PREFIX + crypto.randomBytes(TOKEN_BYTES).toString('base64url');

/**
 * Create a session for a PostgreSQL user. Returns the ONE-TIME plain token and the row.
 * @param {object} repos     repositories (sessions)
 * @param {{ userId: string, client?: 'web'|'extension', userAgent?: string|null, ip?: string|null, now?: number, ttlMs?: number }} p
 */
async function issueSession(repos, { userId, client = 'web', userAgent = null, ip = null, now = Date.now(), ttlMs = SESSION_TTL_MS }) {
  const token = mintToken();
  const row = await repos.sessions.create({
    userId, tokenHash: hashToken(token), client: client === 'extension' ? 'extension' : 'web',
    userAgent: userAgent ? String(userAgent).slice(0, 400) : null, ip: ip || null, expiresAt: new Date(now + ttlMs),
  });
  return { token, session: row, expiresAt: row.expiresAt };
}

/**
 * Resolve a bearer token to its live session (null when unknown, revoked or
 * expired), extending the rolling window when it is time to.
 */
async function resolveSession(repos, token, { now = Date.now(), ttlMs = SESSION_TTL_MS, touchEveryMs = TOUCH_EVERY_MS } = {}) {
  if (!isSessionToken(token)) return null;
  const row = await repos.sessions.findActiveByTokenHash(hashToken(token), new Date(now));
  if (!row) return null;
  const last = row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : 0;
  if (now - last >= touchEveryMs) {
    // Best effort: a failed touch must not fail the request.
    repos.sessions.touch(row.id, { lastUsedAt: new Date(now), expiresAt: new Date(now + ttlMs) }).catch(() => {});
  }
  return row;
}

module.exports = { PREFIX, SESSION_TTL_MS, TOUCH_EVERY_MS, isSessionToken, hashToken, mintToken, issueSession, resolveSession };
