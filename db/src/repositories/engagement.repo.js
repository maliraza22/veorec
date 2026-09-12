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
const { shareLinks, comments, reactions, viewSessions, leads, analyticsEvents, recordings, users } = require('../schema');
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
      /**
       * T-801: one successful watch through the link counts against max_views.
       * Atomic increment guarded by the cap, so concurrent viewers cannot push
       * the count past it; returns the row when counted, null when the link is
       * already exhausted (the caller answers link_expired).
       */
      async countViewSystem(id, reason) {
        requireSystemReason(reason);
        const [row] = await exec('share_link', () => db.update(shareLinks)
          .set({ viewCount: sql`${shareLinks.viewCount} + 1`, updatedAt: new Date() })
          .where(and(eq(shareLinks.id, id), isNull(shareLinks.revokedAt),
            sql`(${shareLinks.maxViews} IS NULL OR ${shareLinks.viewCount} < ${shareLinks.maxViews})`))
          .returning());
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
      /** T-1001: one comment on THIS recording (deleted ones included, so replies/moderation can see them). */
      async getForRecording(recordingId, id) {
        const [row] = await exec('comment', () => db.select().from(comments)
          .where(and(eq(comments.recordingId, recordingId), eq(comments.id, id))).limit(1));
        return row || null;
      },
      /**
       * T-1001: soft delete after the ROUTER established the actor may (the
       * recording owner/admin, or the signed-in author). Reason required.
       */
      async softDeleteSystem(id, reason) {
        requireSystemReason(reason);
        const [row] = await exec('comment', () => db.update(comments)
          .set({ deletedAt: new Date() }).where(and(eq(comments.id, id), isNull(comments.deletedAt))).returning());
        return row || null;
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
      /**
       * T-1002: the viewers list for the owner (docs/13 §5) — signed-in ones
       * named from `users`, anonymous ones labelled; newest activity first.
       */
      async viewersForOwner(scope, recordingId, { limit = 200 } = {}) {
        const { userId } = requireScope(scope);
        await assertOwnsRecording(db, userId, recordingId);
        const rows = await exec('view_session', () => db.select({
          viewerUserId: viewSessions.viewerUserId, name: users.name, email: users.email,
          startedAt: viewSessions.startedAt, lastSeenAt: viewSessions.lastSeenAt,
          maxProgress: viewSessions.maxProgress, completed: viewSessions.completed,
        }).from(viewSessions).leftJoin(users, eq(viewSessions.viewerUserId, users.id))
          .where(and(eq(viewSessions.recordingId, recordingId), eq(viewSessions.isOwner, false)))
          .orderBy(desc(viewSessions.lastSeenAt), desc(viewSessions.startedAt)).limit(limit));
        return rows.map((r) => ({ ...r, name: r.viewerUserId ? (r.name || 'Member') : 'Anonymous viewer', email: r.viewerUserId ? r.email : null }));
      },
      /**
       * T-1002: the retention curve — for each decile d (0..9) how many
       * non-owner viewers reached at least d/10 of the video.
       * @returns {Promise<Array<{decile: number, viewers: number}>>}
       */
      async retentionForOwner(scope, recordingId) {
        const { userId } = requireScope(scope);
        await assertOwnsRecording(db, userId, recordingId);
        const res = await exec('view_session', () => db.execute(sql`
          select d.decile::int as decile,
                 count(v.id) filter (where v.max_progress >= d.decile / 10.0)::int as viewers
          from generate_series(0, 9) as d(decile)
          left join view_sessions v on v.recording_id = ${recordingId} and v.is_owner = false
          group by d.decile order by d.decile`));
        return (res.rows || []).map((r) => ({ decile: Number(r.decile), viewers: Number(r.viewers) }));
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
      /**
       * T-1002: per-recording rollup for the owner's analytics overview —
       * unique non-owner views, avg progress, completed, live comments,
       * reactions — one grouped query per source, merged per recording.
       */
      async rollupForOwner(scope, { limit = 200 } = {}) {
        const { userId } = requireScope(scope);
        const res = await exec('recording', () => db.execute(sql`
          select r.id, r.title, r.created_at,
                 coalesce(v.views, 0)::int as views, coalesce(v.avg_progress, 0)::float as avg_progress, coalesce(v.completed, 0)::int as completed,
                 coalesce(c.n, 0)::int as comments, coalesce(x.n, 0)::int as reactions
          from recordings r
          left join (select recording_id, count(*) as views, avg(max_progress) as avg_progress, count(*) filter (where completed) as completed
                     from view_sessions where is_owner = false group by recording_id) v on v.recording_id = r.id
          left join (select recording_id, count(*) as n from comments where deleted_at is null group by recording_id) c on c.recording_id = r.id
          left join (select recording_id, count(*) as n from reactions group by recording_id) x on x.recording_id = r.id
          where r.user_id = ${userId} and r.deleted_at is null
          order by r.created_at desc limit ${limit}`));
        return (res.rows || []).map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, views: Number(r.views), avgProgress: Number(r.avg_progress), completed: Number(r.completed), comments: Number(r.comments), reactions: Number(r.reactions) }));
      },
      /**
       * T-1002: the owner's day-by-day trend from analytics_events over the
       * last `days` days (UTC), every day present even when empty.
       * @returns {Promise<Array<{day: string, views: number, comments: number, reactions: number, paywallHits: number}>>}
       */
      async trendForOwner(scope, { days = 30 } = {}) {
        const { userId } = requireScope(scope);
        const n = Math.max(1, Math.min(90, Number(days) || 30));
        const res = await exec('analytics_event', () => db.execute(sql`
          select to_char(d.day, 'YYYY-MM-DD') as day,
                 count(e.id) filter (where e.event = 'view')::int as views,
                 count(e.id) filter (where e.event = 'comment')::int as comments,
                 count(e.id) filter (where e.event = 'reaction')::int as reactions,
                 count(e.id) filter (where e.event = 'paywall_hit')::int as paywall_hits
          from generate_series((now() at time zone 'utc')::date - (${n}::int - 1), (now() at time zone 'utc')::date, interval '1 day') as d(day)
          left join analytics_events e
            on (e.created_at at time zone 'utc')::date = d.day::date
           and (e.recording_id in (select id from recordings where user_id = ${userId}) or (e.recording_id is null and e.user_id = ${userId}))
          group by d.day order by d.day`));
        return (res.rows || []).map((r) => ({ day: r.day, views: Number(r.views), comments: Number(r.comments), reactions: Number(r.reactions), paywallHits: Number(r.paywall_hits) }));
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
