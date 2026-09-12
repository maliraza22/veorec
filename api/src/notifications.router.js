// /api/v1 notifications (T-803, docs/08 §9, docs/13 §6)
//
//   GET  /notifications       {items:[Event], unread, lastReadAt}
//   POST /notifications/read  {lastReadAt}
//
// Event: {type:'comment'|'reaction'|'view', name, videoId, videoTitle, text?, emoji?, at}
// — `at` is epoch milliseconds, the shape the bell already renders. The feed
// is query-derived from PostgreSQL; the owner's own activity is excluded by
// user id (docs/08 §9), never by display-name matching.
'use strict';

const express = require('express');
const { errorHandler } = require('./errors');
const { createIdentityBridge, scopeOf } = require('./identity');

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const FEED_LIMIT = 50;
const ms = (d) => (d ? new Date(d).getTime() : 0);

function createNotificationsRouter({ repositories, requireAuth, logger = console }) {
  const router = express.Router();
  router.use('/notifications', requireAuth);
  router.use('/notifications', createIdentityBridge({ repositories, logger }));

  router.get('/notifications', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const [events, readAt] = await Promise.all([
      repos.notifications.feedForOwner(scope, { limit: FEED_LIMIT }),
      repos.notifications.getReadAt(scope),
    ]);
    const lastReadAt = ms(readAt);
    const items = events.map((e) => ({
      type: e.type, name: e.name, videoId: e.recordingId, videoTitle: e.videoTitle,
      ...(e.type === 'comment' ? { text: e.text } : {}),
      ...(e.type === 'reaction' ? { emoji: e.emoji } : {}),
      at: ms(e.at),
    }));
    res.set('Cache-Control', 'no-store');
    return res.json({ items, unread: items.filter((i) => i.at > lastReadAt).length, lastReadAt });
  }));

  router.post('/notifications/read', asyncRoute(async (req, res) => {
    const at = await repositories().notifications.markRead(scopeOf(req), new Date());
    res.set('Cache-Control', 'no-store');
    return res.json({ lastReadAt: ms(at) });
  }));

  router.use(errorHandler(logger));
  return router;
}

module.exports = { createNotificationsRouter, FEED_LIMIT };
