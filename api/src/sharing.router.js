// /api/v1 sharing (T-901, docs/08 §8, docs/12 §3)
//
//   GET    /recordings/:id/share-links      the owner's managed links (tokens never re-shown)
//   POST   /recordings/:id/share-links      {label?, password?, expiresAt?, maxViews?} → 201 {id, token, url, …}
//   DELETE /share-links/:id                 revoke (sets revoked_at); idempotent
//   POST   /recordings/:id/share/slack      post the watch link to the owner's Slack webhook
//
// A managed link is a 128-bit random token whose HASH is stored; the plaintext
// exists in exactly one response. Gate resolution on watch (expiry, max views,
// revocation, the link's own password) lives in authz.resolveWatchAccess
// (T-801) — this router only creates and revokes rows. A recording the caller
// does not own is 404, indistinguishable from missing.
'use strict';

const crypto = require('crypto');
const express = require('express');
const { errorHandler, badRequest, forbidden, notFound, ApiError } = require('./errors');
const { createIdentityBridge, scopeOf } = require('./identity');
const { paywall } = require('./paywall');   // T-1003

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const MAX_LABEL = 80;
const MAX_VIEWS = 1_000_000;
const MIN_PASSWORD = 4;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const wire = (l) => ({
  id: l.id, label: l.label ?? null,
  expiresAt: l.expiresAt ?? null, maxViews: l.maxViews ?? null, viewCount: l.viewCount ?? 0,
  revokedAt: l.revokedAt ?? null, hasPassword: !!l.passwordHash,
  createdAt: l.createdAt,
  // token/tokenHash are deliberately absent: the plaintext was shown once at creation.
});

/**
 * @param {object} deps
 * @param {() => object} deps.repositories
 * @param {Function} deps.requireAuth
 * @param {object} [deps.entitlements]  { isFeatureEnabled(feature, ctx) } — 'passwordProtection', 'slackEnabled'
 * @param {{post(url, body): Promise<{ok: boolean, status?: number}>}} [deps.slack]  the outbound webhook call (injectable)
 * @param {string} [deps.clientBase]     absolute origin of the watch page (docs/08: CLIENT_URL)
 * @param {object} [deps.logger]
 */
function createSharingRouter({ repositories, requireAuth, entitlements = { isFeatureEnabled: async () => true }, slack = defaultSlack(), clientBase = 'https://veorec.com', logger = console }) {
  const router = express.Router();
  for (const p of ['/recordings', '/share-links']) {
    router.use(p, requireAuth);
    router.use(p, createIdentityBridge({ repositories, logger }));
  }

  async function mustOwn(repos, scope, id) {
    const r = await repos.recordings.get(scope, id);
    if (!r) throw notFound('recording_not_found', 'Recording not found');
    return r;
  }
  const watchUrl = (id, token) => `${String(clientBase).replace(/[/]+$/, '')}/watch/${encodeURIComponent(id)}${token ? `?s=${encodeURIComponent(token)}` : ''}`;

  // ── GET /recordings/:id/share-links ────────────────────────────────────
  router.get('/recordings/:id/share-links', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const recording = await mustOwn(repos, scope, req.params.id);
    const items = await repos.shareLinks.list(scope, recording.id);
    res.set('Cache-Control', 'no-store');
    return res.json({ items: items.map(wire), url: watchUrl(recording.id) });
  }));

  // ── POST /recordings/:id/share-links ───────────────────────────────────
  router.post('/recordings/:id/share-links', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const recording = await mustOwn(repos, scope, req.params.id);
    const body = req.body || {};
    const data = {};
    if (body.label !== undefined && body.label !== null) {
      if (typeof body.label !== 'string') throw badRequest('invalid_request', 'label must be a string.');
      data.label = body.label.trim().slice(0, MAX_LABEL) || null;
    }
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      const t = new Date(body.expiresAt);
      if (Number.isNaN(t.getTime())) throw badRequest('invalid_request', 'expiresAt must be an ISO timestamp.');
      if (t.getTime() <= Date.now()) throw badRequest('invalid_request', 'expiresAt must be in the future.');
      data.expiresAt = t;
    }
    if (body.maxViews !== undefined && body.maxViews !== null) {
      const n = Number(body.maxViews);
      if (!Number.isInteger(n) || n < 1 || n > MAX_VIEWS) throw badRequest('invalid_request', `maxViews must be an integer between 1 and ${MAX_VIEWS}.`);
      data.maxViews = n;
    }
    if (body.password !== undefined && body.password !== null && body.password !== '') {
      if (typeof body.password !== 'string' || body.password.length < MIN_PASSWORD) throw badRequest('invalid_request', `password must be at least ${MIN_PASSWORD} characters.`);
      const on = await entitlements.isFeatureEnabled('passwordProtection', { repos, scope, recording, req });
      if (!on) throw await paywall(repos, { userId: req.pgUserId, recordingId: recording.id, feature: 'passwordProtection', message: 'Password-protected links are a Pro feature. Upgrade to unlock them.' }, logger);
      data.passwordHash = sha256(body.password);
    }
    const token = crypto.randomBytes(16).toString('base64url');
    const row = await repos.shareLinks.create(scope, recording.id, { ...data, tokenHash: sha256(token) });
    logger.info({ recording_id: recording.id, share_link_id: row.id, request_id: req.id || null }, 'T-901: share link created');
    return res.status(201).json({ ...wire(row), token, url: watchUrl(recording.id, token) });
  }));

  // ── DELETE /share-links/:id ────────────────────────────────────────────
  router.delete('/share-links/:id', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    try {
      const row = await repos.shareLinks.revoke(scope, req.params.id);
      return res.json({ ok: true, revoked: true, revokedAt: row.revokedAt });
    } catch (e) {
      if (e && e.code === 'not_found') throw notFound('share_link_not_found', 'Share link not found');
      throw e;
    }
  }));

  // ── POST /recordings/:id/share/slack ───────────────────────────────────
  router.post('/recordings/:id/share/slack', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const recording = await mustOwn(repos, scope, req.params.id);
    const on = await entitlements.isFeatureEnabled('slackEnabled', { repos, scope, recording, req });
    if (!on) throw await paywall(repos, { userId: req.pgUserId, recordingId: recording.id, feature: 'slack', message: 'Sharing to Slack is a Pro feature. Upgrade to unlock it.' }, logger);
    const user = await repos.users.findById(req.pgUserId);
    const webhook = user && user.slackWebhook;
    if (!webhook || !/^https:\/\/hooks\.slack\.com\//.test(webhook)) throw badRequest('needs_webhook', 'Add your Slack webhook in account settings first.', { meta: { needsWebhook: true } });
    const url = watchUrl(recording.id);
    let r;
    try { r = await slack.post(webhook, { text: `🎥 *${recording.title || 'a VeoRec recording'}*\n${url}` }); } catch (e) { throw new ApiError(502, 'slack_unreachable', 'Could not reach Slack.'); }
    if (!r || !r.ok) throw new ApiError(502, 'slack_rejected', 'Slack rejected the message — re-check your webhook URL.');
    logger.info({ recording_id: recording.id, request_id: req.id || null }, 'T-901: shared to Slack');
    return res.json({ ok: true });
  }));

  router.use(errorHandler(logger));
  return router;
}

/** The real webhook call. The body never contains anything but the title and the watch URL. */
function defaultSlack() {
  return {
    async post(url, body) {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      return { ok: r.ok, status: r.status };
    },
  };
}

module.exports = { createSharingRouter, defaultSlack, MAX_LABEL, MAX_VIEWS, MIN_PASSWORD };
