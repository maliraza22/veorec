// /api/v1 owner analytics (T-1002, docs/08 §9, docs/13 §5)
//
//   GET /recordings/:id/analytics   Pro `analyticsEnabled` — SQL aggregates over view_sessions
//   GET /analytics/overview         Pro — per-recording rollup + 30-day trend from analytics_events
//
// Numbers come from PostgreSQL only: unique non-owner views, per-viewer max
// progress, avg view-through / completion rate / samples (the figures the UI
// already shows, now per-viewer-accurate), and the NEW retention curve — a
// histogram of max_progress deciles. A locked account gets the paywall
// (`403 feature_locked` + `upgradeRequired`) AND a canonical
// `analytics_attempted` paywall event (T-1003).
'use strict';

const express = require('express');
const { errorHandler, notFound, badRequest } = require('./errors');
const { createIdentityBridge, scopeOf } = require('./identity');
const { paywall } = require('./paywall');

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ms = (d) => (d ? new Date(d).getTime() : null);

/**
 * @param {object} deps
 * @param {() => object} deps.repositories
 * @param {Function} deps.requireAuth
 * @param {object} [deps.entitlements]  { isFeatureEnabled(feature, ctx) } — 'analyticsEnabled'
 * @param {object} [deps.logger]
 */
function createAnalyticsRouter({ repositories, requireAuth, entitlements = { isFeatureEnabled: async () => false }, logger = console }) {
  const router = express.Router();
  for (const p of ['/recordings', '/analytics']) {
    router.use(p, requireAuth);
    router.use(p, createIdentityBridge({ repositories, logger }));
  }

  async function gate(repos, req, recordingId = null) {
    const on = await entitlements.isFeatureEnabled('analyticsEnabled', { repos, scope: scopeOf(req), req });
    if (!on) throw await paywall(repos, { userId: req.pgUserId, recordingId, feature: 'analyticsEnabled', message: 'Viewer analytics are a Pro feature. Upgrade to see who watched and how far.' }, logger);
  }

  // ── GET /recordings/:id/analytics ──────────────────────────────────────
  router.get('/recordings/:id/analytics', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const recording = await repos.recordings.get(scope, req.params.id);
    if (!recording) throw notFound('recording_not_found', 'Recording not found');
    await gate(repos, req, recording.id);
    const [stats, viewers, retention, reactions, comments, leads] = await Promise.all([
      repos.viewSessions.statsForOwner(scope, recording.id),
      repos.viewSessions.viewersForOwner(scope, recording.id, { limit: 200 }),
      repos.viewSessions.retentionForOwner(scope, recording.id),
      repos.reactions.listForRecording(recording.id),
      repos.comments.listForRecording(recording.id),
      repos.leads.listForOwner(scope, recording.id),
    ]);
    res.set('Cache-Control', 'no-store');
    return res.json({
      views: stats.views,
      uniqueViewers: stats.views,
      viewers: viewers.map((v) => ({ name: v.name, email: v.email ?? null, verified: !!v.viewerUserId, at: ms(v.lastSeenAt || v.startedAt), maxProgress: Number(v.maxProgress || 0), completed: !!v.completed })),
      engagement: {
        avgViewThrough: Math.round((Number(stats.avgProgress) || 0) * 100),
        completionRate: stats.views ? Math.round((stats.completed / stats.views) * 100) : 0,
        samples: stats.views,
      },
      retention: retention,   // [{decile: 0..9, viewers}] — how many viewers reached at least that tenth
      reactions: reactions.map((r) => ({ id: r.id, emoji: r.emoji, t: r.t === null ? null : Number(r.t), at: ms(r.createdAt), name: r.authorName ?? null })),
      comments: comments.map((c) => ({ id: c.id, name: c.authorName, text: c.body, t: c.t === null ? null : Number(c.t), at: ms(c.createdAt), verified: !!c.userId })),
      leads: leads.map((l) => ({ email: l.email, name: l.name ?? null, at: ms(l.createdAt) })),
    });
  }));

  // ── GET /analytics/overview ────────────────────────────────────────────
  router.get('/analytics/overview', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    await gate(repos, req);
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 30));
    const [rollup, trend] = await Promise.all([
      repos.analytics.rollupForOwner(scope, { limit: 200 }),
      repos.analytics.trendForOwner(scope, { days }),
    ]);
    if (!Array.isArray(rollup)) throw badRequest('invalid_request', 'Unexpected rollup.');
    const totals = rollup.reduce((a, r) => ({ views: a.views + r.views, comments: a.comments + r.comments, reactions: a.reactions + r.reactions, completed: a.completed + r.completed }), { views: 0, comments: 0, reactions: 0, completed: 0 });
    res.set('Cache-Control', 'no-store');
    return res.json({
      days,
      totals: { recordings: rollup.length, ...totals, completionRate: totals.views ? Math.round((totals.completed / totals.views) * 100) : 0 },
      recordings: rollup.map((r) => ({ id: r.id, title: r.title, created_at: ms(r.createdAt), views: r.views, comments: r.comments, reactions: r.reactions, avgViewThrough: Math.round((Number(r.avgProgress) || 0) * 100), completionRate: r.views ? Math.round((r.completed / r.views) * 100) : 0 })),
      trend: trend.map((d) => ({ day: d.day, views: Number(d.views) || 0, comments: Number(d.comments) || 0, reactions: Number(d.reactions) || 0, paywallHits: Number(d.paywallHits) || 0 })),
    });
  }));

  router.use(errorHandler(logger));
  return router;
}

module.exports = { createAnalyticsRouter };
