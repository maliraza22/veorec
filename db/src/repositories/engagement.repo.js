// Engagement: share links, comments, reactions, viewer sessions, leads and the
// analytics event log (docs/07 §4–§5, docs/13).
//
// Two distinct access patterns:
//   • OWNER operations (share links, moderation, analytics reads) are scoped.
//   • VIEWER operations (commenting, reacting, view tracking) are performed by
//     people who do not own the recording, so they are unscoped by nature. The
//     caller must have authorised the recording first (docs/12) and enforced
//     the audience toggles; that is policy, not data access.
'use strict';

const { and, eq, isNull, desc, sql } = require('drizzle-orm');
const { shareLinks, comments, reactions, viewSessions, leads, analyticsEvents, recordings } = require('../schema');
const { newId } = require('../ids');
const { exec, NotFoundError } = require('./errors');
const { requireScope, requireSystemReason } = require('./scope');

/** Ownership guard reused by every owner-scoped engagement query. */
async function assertOwnsRecording(db, userId, recordingId) {
  const [row] = await exec('recording', () => db.select({ id: recordings.id }).from(recordings)
    .where(and(eq(recordings.id, recordingId), eq(recordings.userId, userId), isNull(recordings.deletedAt)))
    .limit(1));
  if (!row) throw new NotFoundError('recording');
  return row;
}

module.exports = function engagementRepos(db) {
  return {
    shareLinks: {
      async create(scope, recordingId, data = {}) {
        const { userId } = requireScope(scope);
        await assertOwnsRecording(db, userId, recordingId);
        const [row] = await exec('share_link', () => db.insert(shareLinks).values({
          id: data.id || newId('shareLink'),
          recordingId,
          tokenHash: data.tokenHash,
          label: data.label ?? null,
          passwordHash: data.passwordHash ?? null,
          expiresAt: data.expiresAt ?? null,
          maxViews: data.maxViews ?? null,
          createdBy: userId,
        }).returning());
        return row;
      },
      async list(scope, recordingId) {
        const { userId } = requireScope(scope);
        await assertOwnsRecording(db, userId, recordingId);
        return exec('share_link', () => db.select().from(shareLinks)
          .where(eq(shareLinks.recordingId, recordingId)).orderBy(desc(shareLinks.createdAt)));
      },
      async revoke(scope, id) {
        const { userId } = requireScope(scope);
        const rows = await exec('share_link', () => db.select({ id: shareLinks.id }).from(shareLinks)
          .innerJoin(recordings, eq(shareLinks.recordingId, recordings.id))
          .where(and(eq(shareLinks.id, id), eq(recordings.userId, userId))).limit(1));
        if (rows.length === 0) throw new NotFoundError('share_link');
        const [row] = await exec('share_link', () => db.update(shareLinks)
          .set({ revokedAt: new Date() }).where(eq(shareLinks.id, id)).returning());
        return row;
      },
      /** Link resolution during watch — validity rules applied by the caller. */
      async findByTokenHashForWatch(tokenHash) {
        const [row] = await exec('share_link', () => db.select().from(shareLinks)
          .where(eq(shareLinks.tokenHash, tokenHash)).limit(1));
        return row || null;
      },
    },

    comments: {
      /** Viewer action: anonymous commenting is a product feature (docs/13 §1). */
      async addForViewer(recordingId, { authorName, body, t = null, parentId = null, userId = null }) {
        const [row] = await exec('comment', () => db.insert(comments).values({
          id: newId('comment'), recordingId, parentId, userId, authorName, body, t,
        }).returning());
        return row;
      },
      async listForRecording(recordingId, { limit = 200 } = {}) {
        return exec('comment', () => db.select().from(comments)
          .where(and(eq(comments.recordingId, recordingId), isNull(comments.deletedAt)))
          .orderBy(comments.createdAt).limit(limit));
      },
      /** Moderation: the recording owner may remove any comment on it. */
      async softDeleteAsOwner(scope, commentId) {
        const { userId } = requireScope(scope);
        const rows = await exec('comment', () => db.select({ id: comments.id }).from(comments)
          .innerJoin(recordings, eq(comments.recordingId, recordings.id))
          .where(and(eq(comments.id, commentId), eq(recordings.userId, userId))).limit(1));
        if (rows.length === 0) throw new NotFoundError('comment');
        const [row] = await exec('comment', () => db.update(comments)
          .set({ deletedAt: new Date() }).where(eq(comments.id, commentId)).returning());
        return row;
      },
    },

    reactions: {
      async addForViewer(recordingId, { emoji, t = null, authorName = null, userId = null }) {
        const [row] = await exec('reaction', () => db.insert(reactions).values({
          id: newId('reaction'), recordingId, userId, authorName, emoji, t,
        }).returning());
        return row;
      },
      async listForRecording(recordingId) {
        return exec('reaction', () => db.select().from(reactions)
          .where(eq(reactions.recordingId, recordingId)).orderBy(reactions.createdAt));
      },
    },

    viewSessions: {
      /**
       * One row per unique viewer key — repeat views update rather than insert,
       * so `count(*) WHERE NOT is_owner` is the unique-view metric (docs/13 §3).
       */
      async recordView(recordingId, { viewerKey, viewerUserId = null, visitorId = null, ipHash = null, isOwner = false }) {
        const [row] = await exec('view_session', () => db.insert(viewSessions).values({
          id: newId('viewSession'), recordingId, viewerKey, viewerUserId, visitorId, ipHash,
          isOwner, lastSeenAt: new Date(),
        }).onConflictDoUpdate({
          target: [viewSessions.recordingId, viewSessions.viewerKey],
          set: { lastSeenAt: new Date() },
        }).returning());
        return row;
      },
      /** Progress is monotonic: a later, smaller beacon must not regress it. */
      async recordProgress(recordingId, viewerKey, pct) {
        const clamped = Math.max(0, Math.min(1, Number(pct) || 0));
        const [row] = await exec('view_session', () => db.update(viewSessions).set({
          maxProgress: sql`greatest(${viewSessions.maxProgress}, ${clamped})`,
          completed: sql`(greatest(${viewSessions.maxProgress}, ${clamped}) >= 0.9)`,
          lastSeenAt: new Date(),
        }).where(and(eq(viewSessions.recordingId, recordingId), eq(viewSessions.viewerKey, viewerKey)))
          .returning());
        return row || null;
      },
      async countUnique(recordingId) {
        const [row] = await exec('view_session', () => db.select({ n: sql`count(*)::int` })
          .from(viewSessions)
          .where(and(eq(viewSessions.recordingId, recordingId), eq(viewSessions.isOwner, false))));
        return row ? Number(row.n) : 0;
      },
      /** Owner analytics: engagement aggregates (docs/13 §5). */
      async statsForOwner(scope, recordingId) {
        const { userId } = requireScope(scope);
        await assertOwnsRecording(db, userId, recordingId);
        const [row] = await exec('view_session', () => db.select({
          views: sql`count(*)::int`,
          avgProgress: sql`coalesce(avg(${viewSessions.maxProgress}), 0)::float`,
          completed: sql`count(*) FILTER (WHERE ${viewSessions.completed})::int`,
        }).from(viewSessions)
          .where(and(eq(viewSessions.recordingId, recordingId), eq(viewSessions.isOwner, false))));
        return row || { views: 0, avgProgress: 0, completed: 0 };
      },
    },

    leads: {
      /** Idempotent per (recording, email) — re-submitting is not an error. */
      async capture(recordingId, { email, name = null }) {
        const [row] = await exec('lead', () => db.insert(leads)
          .values({ id: newId('lead'), recordingId, email, name })
          .onConflictDoNothing({ target: [leads.recordingId, leads.email] })
          .returning());
        return row || null;
      },
      async listForOwner(scope, recordingId) {
        const { userId } = requireScope(scope);
        await assertOwnsRecording(db, userId, recordingId);
        return exec('lead', () => db.select().from(leads)
          .where(eq(leads.recordingId, recordingId)).orderBy(desc(leads.createdAt)));
      },
    },

    // Append-only behavioural log. This is the one place raw aggregate SQL is
    // expected to grow (docs/07 §14 acceptance note).
    analytics: {
      async record({ event, recordingId = null, userId = null, props = {} }) {
        const [row] = await exec('analytics_event', () => db.insert(analyticsEvents)
          .values({ event, recordingId, userId, props }).returning());
        return row;
      },
      async countByEventSystem({ since }, reason) {
        requireSystemReason(reason);
        return exec('analytics_event', () => db.select({
          event: analyticsEvents.event, n: sql`count(*)::int`,
        }).from(analyticsEvents)
          .where(sql`${analyticsEvents.createdAt} >= ${since}`)
          .groupBy(analyticsEvents.event));
      },
    },
  };
};
