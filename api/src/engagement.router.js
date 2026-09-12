// /api/v1 engagement (T-1001, docs/08 §7, docs/13 §1–§4)
//
//   POST   /watch/:id/view                 {visitorId?} → {views}
//   POST   /watch/:id/progress             {pct, visitorId?} → 204
//   GET    /watch/:id/engagement           {views, reactions, comments}
//   POST   /watch/:id/comment              {text, name?, t?, parentId?} → Comment
//   DELETE /watch/:id/comments/:commentId  owner moderation or the signed-in author → {ok}
//   POST   /watch/:id/react                {emoji, t?, name?} → {reactions}
//
// PostgreSQL only — no JSON store, no dual-write. Every route authorises the
// recording through the shared watch context (privacy, share links, tokens),
// then applies the audience toggles. Views are one row per unique viewer key
// (signed-in user → visitorId → salted daily IP hash); the owner's own rows are
// recorded with is_owner and excluded from every count BY USER ID. Actor
// identity comes from the session: a signed-in caller's display name is the
// account name, an anonymous name is display-only.
'use strict';

const crypto = require('crypto');
const express = require('express');
const { errorHandler, badRequest, forbidden, notFound } = require('./errors');
const { createWatchContext, asyncRoute } = require('./watch-context');
const { createRateLimiter, ipOf } = require('./rate-limit');

const MAX_COMMENT = 2000;
const MAX_NAME = 80;
const MAX_EMOJI_CHARS = 8;
const DEFAULT_LIMITS = {
  view: { max: 60, windowMs: 60 * 1000 },          // docs/08 §1: views/progress 60/min·IP
  engage: { max: 30, windowMs: 60 * 1000 },        // comments/reactions 30/min·IP
};

const ms = (d) => (d ? new Date(d).getTime() : null);
const num = (v) => (v === null || v === undefined ? null : Number(v));
const wireComment = (c) => ({ id: c.id, name: c.authorName, text: c.deletedAt ? '' : c.body, t: num(c.t), at: ms(c.createdAt), parentId: c.parentId ?? null, verified: !!c.userId, removed: !!c.deletedAt });
const wireReaction = (r) => ({ id: r.id, emoji: r.emoji, t: num(r.t), at: ms(r.createdAt), name: r.authorName ?? null, verified: !!r.userId });

/**
 * @param {object} deps
 * @param {() => object} deps.repositories
 * @param {(req) => Promise<{id: string, isAdmin?: boolean}|null>} deps.viewer
 * @param {string} deps.accessSecret
 * @param {string} [deps.ipSalt]         salt for the daily IP hash (never a raw IP at rest)
 * @param {object} [deps.rateLimits]
 * @param {() => number} [deps.now]
 * @param {object} [deps.logger]
 */
function createEngagementRouter({ repositories, viewer, accessSecret, ipSalt = 'veorec-view-key', rateLimits = {}, now = () => Date.now(), logger = console }) {
  const ctx = createWatchContext({ repositories, viewer, accessSecret, now });
  const limits = { ...DEFAULT_LIMITS, ...rateLimits };
  const limitView = createRateLimiter({ ...limits.view, keyOf: ipOf, now });
  const limitEngage = createRateLimiter({ ...limits.engage, keyOf: ipOf, now });
  const router = express.Router();
  router.use('/watch/:id', ctx.middleware);

  /** docs/13 §3: signed-in user → visitorId → salted daily IP hash. */
  function viewerKey(req, body) {
    if (req.watchViewer) return { key: `u:${req.watchViewer.id}`, viewerUserId: req.watchViewer.id, visitorId: null, ipHash: null };
    const vid = body && typeof body.visitorId === 'string' ? body.visitorId.trim().slice(0, 64) : '';
    if (vid) return { key: `v:${vid}`, viewerUserId: null, visitorId: vid, ipHash: null };
    const day = new Date(now()).toISOString().slice(0, 10);
    const ipHash = crypto.createHash('sha256').update(`${ipSalt}:${day}:${ipOf(req)}`).digest('hex').slice(0, 32);
    return { key: `ip:${ipHash}`, viewerUserId: null, visitorId: null, ipHash };
  }

  /** The actor's display name: the account name for signed-in callers, display-only otherwise. */
  async function actorName(repos, req, body) {
    if (req.watchViewer) {
      const u = await repos.users.findById(req.watchViewer.id);
      return { name: (u && u.name) || 'Member', userId: req.watchViewer.id };
    }
    const raw = body && typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME) : '';
    return { name: raw || 'Anonymous', userId: null };
  }

  // docs/13 §4: append-only behaviour facts (a repeat view is still a view).
  // Awaited so a read that follows the response sees the event; a failure
  // never fails the request.
  const record = (repos, event, recordingId, userId, props = {}) => repos.analytics.record({ event, recordingId, userId, props }).catch((e) => logger.warn({ err: e && e.message }, 'T-1001: analytics event not recorded'));

  // ── POST /watch/:id/view ───────────────────────────────────────────────
  router.post('/watch/:id/view', limitView.middleware, asyncRoute(async (req, res) => {
    const { repos, recording, decision } = await ctx.authorise(req);
    const k = viewerKey(req, req.body);
    const isOwner = decision.isOwner;
    await repos.viewSessions.recordView(recording.id, { viewerKey: k.key, viewerUserId: k.viewerUserId, visitorId: k.visitorId, ipHash: k.ipHash, isOwner });
    const views = await repos.viewSessions.countUnique(recording.id);
    if (!isOwner) await record(repos, 'view', recording.id, k.viewerUserId, { via: decision.via });
    return res.json({ views, self: isOwner || undefined });
  }));

  // ── POST /watch/:id/progress → 204 ─────────────────────────────────────
  router.post('/watch/:id/progress', limitView.middleware, asyncRoute(async (req, res) => {
    const pct = Number(req.body && req.body.pct);
    if (!Number.isFinite(pct)) return res.status(204).end();
    const { repos, recording } = await ctx.authorise(req);
    const k = viewerKey(req, req.body);
    await repos.viewSessions.recordProgress(recording.id, k.key, pct);
    return res.status(204).end();
  }));

  // ── GET /watch/:id/engagement ──────────────────────────────────────────
  router.get('/watch/:id/engagement', asyncRoute(async (req, res) => {
    const { repos, recording } = await ctx.authorise(req);
    const [views, reactions, comments] = await Promise.all([
      repos.viewSessions.countUnique(recording.id),
      repos.reactions.listForRecording(recording.id),
      repos.comments.listForRecording(recording.id),
    ]);
    return res.json({ views, reactions: reactions.map(wireReaction), comments: comments.map(wireComment) });
  }));

  // ── POST /watch/:id/comment ────────────────────────────────────────────
  router.post('/watch/:id/comment', limitEngage.middleware, asyncRoute(async (req, res) => {
    const { repos, recording, decision } = await ctx.authorise(req);
    if ((recording.audience || {}).comments === false && !(decision.isOwner || decision.isAdmin)) throw forbidden('audience_disabled', 'Comments are turned off for this video.');
    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_COMMENT) : '';
    if (!text) throw badRequest('invalid_request', 'Comment text required');
    const t = body.t === undefined || body.t === null || body.t === '' ? null : Number(body.t);
    if (t !== null && (!Number.isFinite(t) || t < 0)) throw badRequest('invalid_request', 't must be a non-negative number of seconds.');
    let parentId = null;
    if (body.parentId) {
      const parent = await repos.comments.getForRecording(recording.id, String(body.parentId));
      if (!parent || parent.deletedAt) throw badRequest('invalid_request', 'The comment you are replying to does not exist.');
      if (parent.parentId) throw badRequest('comment_depth', 'Replies can only be made to top-level comments.');
      parentId = parent.id;
    }
    const actor = await actorName(repos, req, body);
    const row = await repos.comments.addForViewer(recording.id, { authorName: actor.name, body: text, t: t === null ? null : Math.floor(t), parentId, userId: actor.userId });
    await record(repos, 'comment', recording.id, actor.userId, { t: row.t === null ? null : Number(row.t) });
    return res.status(201).json(wireComment(row));
  }));

  // ── DELETE /watch/:id/comments/:commentId — moderation / author ────────
  router.delete('/watch/:id/comments/:commentId', asyncRoute(async (req, res) => {
    const { repos, recording, decision } = await ctx.authorise(req);
    const c = await repos.comments.getForRecording(recording.id, req.params.commentId);
    if (!c) throw notFound('comment_not_found', 'Comment not found');
    const mayModerate = decision.isOwner || decision.isAdmin;
    const isAuthor = !!(req.watchViewer && c.userId && c.userId === req.watchViewer.id);
    if (!mayModerate && !isAuthor) throw forbidden('forbidden', 'Only the recording owner or the comment author can remove it.');
    if (!c.deletedAt) await repos.comments.softDeleteSystem(c.id, 'T-1001 engagement: comment removed by the owner/admin or its signed-in author');
    return res.json({ ok: true, id: c.id });
  }));

  // ── POST /watch/:id/react ──────────────────────────────────────────────
  router.post('/watch/:id/react', limitEngage.middleware, asyncRoute(async (req, res) => {
    const { repos, recording, decision } = await ctx.authorise(req);
    if ((recording.audience || {}).reactions === false && !(decision.isOwner || decision.isAdmin)) throw forbidden('audience_disabled', 'Reactions are turned off for this video.');
    const body = req.body || {};
    const emoji = typeof body.emoji === 'string' ? body.emoji.trim() : '';
    if (!emoji || [...emoji].length > MAX_EMOJI_CHARS) throw badRequest('invalid_request', 'emoji required (at most 8 characters).');
    const t = body.t === undefined || body.t === null || body.t === '' ? null : Number(body.t);
    if (t !== null && (!Number.isFinite(t) || t < 0)) throw badRequest('invalid_request', 't must be a non-negative number of seconds.');
    const actor = await actorName(repos, req, body);
    await repos.reactions.addForViewer(recording.id, { emoji, t: t === null ? null : Math.floor(t), authorName: actor.name, userId: actor.userId });
    await record(repos, 'reaction', recording.id, actor.userId, { emoji });
    const reactions = await repos.reactions.listForRecording(recording.id);
    return res.status(201).json({ reactions: reactions.map(wireReaction) });
  }));

  router.use(errorHandler(logger));
  return router;
}

module.exports = { createEngagementRouter, wireComment, wireReaction, MAX_COMMENT, MAX_EMOJI_CHARS, DEFAULT_LIMITS };
