// ─────────────────────────────────────────────────────────────────────────────
// WATCH AUTHORISATION (T-801, docs/12 §1–§6)
//
// The ONE place that decides whether a viewer may watch a recording. Route
// handlers call `resolveWatchAccess` and act on its answer; none of them checks
// privacy inline (docs/12 §2: "enforcement is centralized").
//
// Inputs are plain data — the recording row, the viewer (or null), the share
// link row the request presented (or null), and the grants carried by a watch
// access token — so the matrix is unit-testable without a database.
//
// Access tokens: an unlock (password), a share-link password, or a lead-gate
// email submission grants access for a while. The grant is an HMAC-signed,
// recording-bound, expiring token the client sends back on `/media`, the
// transcript and the HLS playlist proxy (`X-Watch-Access` header or `?a=`).
// Nothing is stored server-side; revoking = the recording's privacy or the
// link changing, which the resolver re-checks on every call.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const crypto = require('crypto');

const PRIVACY_LEVELS = ['public', 'unlisted', 'workspace', 'login', 'password'];
/** Private-ish media URLs live 10 minutes; public ones 24 h (docs/12 §5.1). */
const TTL_PRIVATE_SECONDS = 10 * 60;
const TTL_PUBLIC_SECONDS = 24 * 60 * 60;
/** An unlock/lead grant outlives many media refreshes; it is the "session". */
const ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest();

/**
 * Mint a watch access token.
 * @param {string} secret
 * @param {{rec: string, grants: string[], exp?: number, sub?: string|null}} claims
 *        grants: 'password' (recording password verified), 'share:<linkId>'
 *        (share-link password verified), 'lead' (email submitted), 'hls'
 *        (playlist proxy access minted by /media)
 */
function signAccess(secret, { rec, grants, exp, sub = null }, now = () => Date.now()) {
  if (!secret) throw new Error('signAccess: secret is required');
  if (!rec) throw new Error('signAccess: rec is required');
  const payload = { rec, g: [...new Set(grants || [])], exp: exp || Math.floor(now() / 1000) + ACCESS_TOKEN_TTL_SECONDS, sub };
  const body = b64u(JSON.stringify(payload));
  return `${body}.${b64u(hmac(secret, body))}`;
}

/** Verify a token; null when malformed, tampered, expired or for another recording. */
function verifyAccess(secret, token, { rec, now = () => Date.now() } = {}) {
  if (!secret || typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1), 'base64url');
  const expect = hmac(secret, body);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(sig, expect)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object' || typeof payload.rec !== 'string' || !Array.isArray(payload.g)) return null;
  if (!(payload.exp > Math.floor(now() / 1000))) return null;
  if (rec && payload.rec !== rec) return null;
  return { rec: payload.rec, grants: payload.g.filter((g) => typeof g === 'string'), exp: payload.exp, sub: payload.sub ?? null };
}

/** Share-link validity (docs/12 §3): revoked, expired or over its view cap is dead. */
function shareLinkState(link, now = () => Date.now()) {
  if (!link) return 'none';
  if (link.revokedAt) return 'revoked';
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= now()) return 'expired';
  if (link.maxViews != null && Number(link.viewCount || 0) >= Number(link.maxViews)) return 'exhausted';
  return 'valid';
}

/**
 * The matrix. Pure.
 *
 * @param {object} input
 * @param {object} input.recording        recording row (deletedAt checked by the caller's lookup)
 * @param {{id: string, isAdmin?: boolean}|null} input.viewer  signed-in viewer (PostgreSQL id) or null
 * @param {object|null} input.shareLink   the share_links row presented with ?s=, or null
 * @param {boolean} input.shareTokenPresented  a ?s= was sent (an unknown token is a dead link, never a fallback)
 * @param {{grants: string[]}|null} input.access   verified access token for THIS recording, or null
 * @param {string|null} input.workspaceRole  viewer's role in recording.workspaceId (null when none)
 * @returns {{ok: true, via: string, isOwner: boolean, isAdmin: boolean, shareLink: object|null}
 *         | {ok: false, reason: 'login_required'|'password_required'|'link_expired'|'not_found', shareLink: object|null}}
 */
function resolveWatchAccess({ recording, viewer = null, shareLink = null, shareTokenPresented = false, access = null, workspaceRole = null, now = () => Date.now() }) {
  if (!recording || recording.deletedAt) return { ok: false, reason: 'not_found', shareLink: null };
  const isOwner = !!(viewer && viewer.id && viewer.id === recording.userId);
  const isAdmin = !!(viewer && viewer.isAdmin);
  const grants = new Set((access && access.grants) || []);
  const base = { isOwner, isAdmin, shareLink: null };

  if (isOwner) return { ok: true, via: 'owner', ...base };
  if (isAdmin) return { ok: true, via: 'admin', ...base };

  // A presented share link decides FIRST: a dead link never falls back to the
  // recording's own privacy, and a live one satisfies any privacy level.
  if (shareTokenPresented) {
    const state = shareLinkState(shareLink, now);
    if (state !== 'valid' || shareLink.recordingId !== recording.id) return { ok: false, reason: 'link_expired', shareLink: null };
    if (shareLink.passwordHash && !grants.has(`share:${shareLink.id}`)) return { ok: false, reason: 'password_required', shareLink };
    return { ok: true, via: 'share', ...base, shareLink };
  }

  switch (recording.privacy) {
    case 'public': return { ok: true, via: 'public', ...base };
    case 'unlisted': return { ok: true, via: 'unlisted', ...base };
    case 'login':
      return viewer ? { ok: true, via: 'login', ...base } : { ok: false, reason: 'login_required', shareLink: null };
    case 'password':
      if (!recording.passwordHash) return { ok: true, via: 'unlisted', ...base };   // no password set yet → link access
      return grants.has('password') ? { ok: true, via: 'password', ...base } : { ok: false, reason: 'password_required', shareLink: null };
    case 'workspace':
      if (!viewer) return { ok: false, reason: 'login_required', shareLink: null };
      // A signed-in non-member learns nothing: same answer as a missing id.
      return workspaceRole ? { ok: true, via: 'workspace', ...base } : { ok: false, reason: 'not_found', shareLink: null };
    default:
      return { ok: false, reason: 'not_found', shareLink: null };
  }
}

/** Media URL TTL by privacy (docs/12 §5.1): public 24 h, everything else 10 min. */
function mediaTtlSeconds(recording, via) {
  return recording.privacy === 'public' && via !== 'share' ? TTL_PUBLIC_SECONDS : TTL_PRIVATE_SECONDS;
}

/**
 * Lead gate (docs/12 §6 "lead-gate bypass"): when the owner requires an email,
 * media is minted only for the owner/admin or a viewer holding a 'lead' grant.
 */
function leadGateSatisfied(recording, decision, access) {
  const audience = (recording && recording.audience) || {};
  if (audience.requireEmail !== true) return true;
  if (decision.isOwner || decision.isAdmin) return true;
  return !!(access && access.grants && access.grants.includes('lead'));
}

/**
 * Password verification for recording/share-link hashes. The v1 recordings
 * router stores sha256 hex (T-302); legacy rows imported from meta.json carry
 * bcrypt. Both are accepted so a migrated recording keeps its password.
 * `bcryptCompare` is injected by the host (the api package has no bcrypt).
 */
function createPasswordVerifier({ bcryptCompare = null } = {}) {
  return async function verifyPassword(password, hash) {
    if (typeof password !== 'string' || typeof hash !== 'string' || !hash) return false;
    if (/^\$2[aby]\$/.test(hash)) return bcryptCompare ? !!(await bcryptCompare(password, hash)) : false;
    const digest = crypto.createHash('sha256').update(password).digest();
    let stored;
    try { stored = Buffer.from(hash, 'hex'); } catch { return false; }
    return stored.length === digest.length && crypto.timingSafeEqual(stored, digest);
  };
}

const hashShareToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

module.exports = {
  PRIVACY_LEVELS, TTL_PRIVATE_SECONDS, TTL_PUBLIC_SECONDS, ACCESS_TOKEN_TTL_SECONDS,
  signAccess, verifyAccess, shareLinkState, resolveWatchAccess, mediaTtlSeconds, leadGateSatisfied,
  createPasswordVerifier, hashShareToken,
};
