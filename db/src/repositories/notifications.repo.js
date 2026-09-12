// Notifications (docs/13 §6, docs/08 §9) — T-803.
//
// There is NO feed table: the feed is derived from comments, reactions and
// view sessions on the owner's recordings, newer first, excluding the owner's
// own activity BY USER ID (never by display-name matching — the legacy
// O(all-meta) scan compared names). Three indexed queries, merged in memory,
// capped. `notification_reads` remembers where the owner last looked.
'use strict';

const { and, eq, ne, or, isNull, desc, sql } = require('drizzle-orm');
const { comments, reactions, viewSessions, recordings, users, notificationReads } = require('../schema');
const { exec } = require('./errors');
const { requireScope } = require('./scope');

module.exports = function notificationsRepo(db) {
  return {
    /** When the owner last marked the feed as read (null = never). */
    async getReadAt(scope) {
      const { userId } = requireScope(scope);
      const [row] = await exec('notification_read', () => db.select({ lastReadAt: notificationReads.lastReadAt })
        .from(notificationReads).where(eq(notificationReads.userId, userId)).limit(1));
      return row ? row.lastReadAt : null;
    },

    /** Mark the feed as seen up to `at` (upsert; monotonic — never moves backwards). */
    async markRead(scope, at = new Date()) {
      const { userId } = requireScope(scope);
      const [row] = await exec('notification_read', () => db.insert(notificationReads)
        .values({ userId, lastReadAt: at })
        .onConflictDoUpdate({ target: notificationReads.userId, set: { lastReadAt: sql`greatest(${notificationReads.lastReadAt}, ${at})`, updatedAt: new Date() } })
        .returning({ lastReadAt: notificationReads.lastReadAt }));
      return row.lastReadAt;
    },

    /**
     * Recent activity by OTHER people on the owner's live recordings.
     * @returns {Promise<Array<{type:'comment'|'reaction'|'view', recordingId, videoTitle, name, text?, emoji?, at: Date}>>}
     */
    async feedForOwner(scope, { limit = 50 } = {}) {
      const { userId } = requireScope(scope);
      const per = Math.max(1, Math.min(200, limit));
      const liveOwned = and(eq(recordings.userId, userId), isNull(recordings.deletedAt));
      const notOwner = (col) => or(isNull(col), ne(col, userId));

      const [cs, rs, vs] = await Promise.all([
        exec('comment', () => db.select({
          id: comments.id, recordingId: comments.recordingId, videoTitle: recordings.title,
          name: comments.authorName, text: comments.body, at: comments.createdAt,
        }).from(comments).innerJoin(recordings, eq(comments.recordingId, recordings.id))
          .where(and(liveOwned, isNull(comments.deletedAt), notOwner(comments.userId)))
          .orderBy(desc(comments.createdAt)).limit(per)),
        exec('reaction', () => db.select({
          id: reactions.id, recordingId: reactions.recordingId, videoTitle: recordings.title,
          name: reactions.authorName, emoji: reactions.emoji, at: reactions.createdAt,
        }).from(reactions).innerJoin(recordings, eq(reactions.recordingId, recordings.id))
          .where(and(liveOwned, notOwner(reactions.userId)))
          .orderBy(desc(reactions.createdAt)).limit(per)),
        exec('view_session', () => db.select({
          id: viewSessions.id, recordingId: viewSessions.recordingId, videoTitle: recordings.title,
          name: users.name, at: viewSessions.startedAt,
        }).from(viewSessions).innerJoin(recordings, eq(viewSessions.recordingId, recordings.id))
          .leftJoin(users, eq(viewSessions.viewerUserId, users.id))
          .where(and(liveOwned, eq(viewSessions.isOwner, false), notOwner(viewSessions.viewerUserId)))
          .orderBy(desc(viewSessions.startedAt)).limit(per)),
      ]);
      const events = [
        ...cs.map((c) => ({ type: 'comment', id: c.id, recordingId: c.recordingId, videoTitle: c.videoTitle, name: c.name || 'Someone', text: c.text || '', at: c.at })),
        ...rs.map((r) => ({ type: 'reaction', id: r.id, recordingId: r.recordingId, videoTitle: r.videoTitle, name: r.name || 'Someone', emoji: r.emoji || '👍', at: r.at })),
        ...vs.map((v) => ({ type: 'view', id: v.id, recordingId: v.recordingId, videoTitle: v.videoTitle, name: v.name || 'Someone', at: v.at })),
      ].filter((e) => e.at);
      events.sort((a, b) => new Date(b.at) - new Date(a.at));
      return events.slice(0, per);
    },
  };
};
