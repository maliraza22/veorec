// Recordings + folders — the core owned entities (docs/07 §3).
//
// Every user-facing method is scoped: the ownership predicate
// (`user_id = scope.userId AND deleted_at IS NULL`) is applied here, not by the
// caller. Unscoped access exists only for the public watch page and for
// background workers, through explicitly named methods.
//
// Nothing in this file knows about storage providers: media lives in
// video_assets.storage_key and is resolved by StorageProvider (T-201).
'use strict';

const { and, eq, isNull, desc, lt, inArray, isNotNull, sql } = require('drizzle-orm');
const { recordings, folders } = require('../schema');
const { newId } = require('../ids');
const { exec, NotFoundError, InvalidStateError } = require('./errors');
const { requireScope, requireSystemReason } = require('./scope');

// Owner-editable metadata. Lifecycle (`status`), verified media facts
// (duration/width/height/size) and ownership are NOT patchable here — they are
// set by the pipeline via the *System methods (invariant #11).
const OWNER_UPDATABLE = [
  'title', 'description', 'privacy', 'passwordHash', 'folderId', 'trimStart', 'trimEnd',
  'segments', 'chapters', 'tags', 'audience', 'cta', 'recommendedSpeed',
  'animatedThumbnail', 'archived', 'removeBranding',
];
// Written by workers/pipeline only.
const SYSTEM_UPDATABLE = [
  'status', 'failureCode', 'duration', 'width', 'height', 'sizeBytes',
  'aiStatus', 'description', 'title', 'chapters',
];
const ACTIVE_STATUSES = ['recording', 'uploading', 'uploaded', 'processing', 'ready'];

const pick = (patch, allowed) => Object.fromEntries(
  Object.entries(patch || {}).filter(([k, v]) => allowed.includes(k) && v !== undefined)
);

module.exports = function recordingsRepo(db) {
  const owned = (userId, extra) =>
    and(eq(recordings.userId, userId), isNull(recordings.deletedAt), extra);

  return {
    async create(scope, data = {}) {
      const { userId, workspaceId } = requireScope(scope);
      const [row] = await exec('recording', () => db.insert(recordings).values({
        id: data.id || newId('recording'),
        userId,
        workspaceId: data.workspaceId ?? workspaceId ?? null,
        title: data.title ?? undefined,
        sourceKind: data.sourceKind || 'extension',
        status: data.status || 'recording',
        clientDurationHint: data.clientDurationHint ?? null,
        folderId: data.folderId ?? null,
        privacy: data.privacy ?? undefined,
      }).returning());
      return row;
    },

    async get(scope, id) {
      const { userId } = requireScope(scope);
      const [row] = await exec('recording', () =>
        db.select().from(recordings).where(owned(userId, eq(recordings.id, id))).limit(1));
      return row || null;
    },

    async getOrThrow(scope, id) {
      const row = await this.get(scope, id);
      if (!row) throw new NotFoundError('recording');
      return row;
    },

    /** Library listing. Keyset pagination on (created_at, id) — index-aligned. */
    async list(scope, { folderId, archived = false, limit = 50, cursor } = {}) {
      const { userId } = requireScope(scope);
      const conds = [eq(recordings.archived, archived)];
      if (folderId !== undefined) {
        conds.push(folderId === null ? isNull(recordings.folderId) : eq(recordings.folderId, folderId));
      }
      if (cursor) conds.push(lt(recordings.createdAt, cursor));
      return exec('recording', () => db.select().from(recordings)
        .where(owned(userId, and(...conds)))
        .orderBy(desc(recordings.createdAt))
        .limit(Math.min(limit, 100)));
    },

    async update(scope, id, patch) {
      const { userId } = requireScope(scope);
      const values = pick(patch, OWNER_UPDATABLE);
      if (Object.keys(values).length === 0) return this.getOrThrow(scope, id);
      const [row] = await exec('recording', () => db.update(recordings).set(values)
        .where(owned(userId, eq(recordings.id, id))).returning());
      if (!row) throw new NotFoundError('recording');
      return row;
    },

    /**
     * Soft delete. The quota release that accompanies it (docs/16 §4.4) is
     * applied by the caller inside the same transaction — see usage repo.
     */
    async softDelete(scope, id) {
      const { userId } = requireScope(scope);
      const [row] = await exec('recording', () => db.update(recordings).set({ deletedAt: new Date() })
        .where(owned(userId, eq(recordings.id, id))).returning());
      if (!row) throw new NotFoundError('recording');
      return row;
    },

    /** Active-video count — the free-plan video cap reads this (docs/16 §4.2). */
    async countActive(scope) {
      const { userId } = requireScope(scope);
      const [row] = await exec('recording', () => db.select({ n: sql`count(*)::int` }).from(recordings)
        .where(owned(userId, inArray(recordings.status, ACTIVE_STATUSES))));
      return row ? Number(row.n) : 0;
    },

    // ── Deliberately unscoped surface ───────────────────────────────────────
    /**
     * Public watch page. Returns the row regardless of owner — the caller MUST
     * apply the privacy/share-link rules in docs/12 before exposing anything.
     */
    async getForPublicWatch(id) {
      const [row] = await exec('recording', () => db.select().from(recordings)
        .where(and(eq(recordings.id, id), isNull(recordings.deletedAt))).limit(1));
      return row || null;
    },

    /** Background workers (probe/transcode/AI) act without a user scope. */
    async getSystem(id, reason) {
      requireSystemReason(reason);
      const [row] = await exec('recording', () =>
        db.select().from(recordings).where(eq(recordings.id, id)).limit(1));
      return row || null;
    },

    /**
     * SELECT … FOR UPDATE on one recording (T-702 maybe_mark_ready, docs/10 §6):
     * serialises the lifecycle transition. Refuses to run outside a transaction
     * — a lock on a plain connection is released before the caller can use it.
     */
    async getForUpdateSystem(id, reason) {
      requireSystemReason(reason);
      if (typeof db.rollback !== 'function') {
        throw new InvalidStateError('recording', 'getForUpdateSystem must run inside withTransaction() — the row lock is the point');
      }
      const [row] = await exec('recording', () =>
        db.select().from(recordings).where(eq(recordings.id, id)).for('update').limit(1));
      return row || null;
    },

    /** Pipeline writes: verified media facts and lifecycle transitions. */
    async updateSystem(id, patch, reason) {
      requireSystemReason(reason);
      const values = pick(patch, SYSTEM_UPDATABLE);
      if (Object.keys(values).length === 0) return this.getSystem(id, reason);
      const [row] = await exec('recording', () => db.update(recordings).set(values)
        .where(eq(recordings.id, id)).returning());
      if (!row) throw new NotFoundError('recording');
      return row;
    },

    // ── T-706: legacy re-processing backfill ────────────────────────────────

    /**
     * Progress numbers for the pipeline dashboard: active recordings, those
     * with an R2 source, those complete (ready MP4 + ready poster), pending,
     * failed, rejected, and probe jobs in flight.
     */
    async pipelineStatsSystem(reason) {
      requireSystemReason(reason);
      const res = await exec('recording', () => db.execute(sql`
        with active as (
          select r.id, r.status, r.failure_code,
            exists (select 1 from video_assets a where a.recording_id = r.id and a.kind = 'source' and a.status = 'ready') as has_source,
            exists (select 1 from video_assets a where a.recording_id = r.id and a.kind = 'mp4' and a.status = 'ready') as has_mp4,
            exists (select 1 from video_assets a where a.recording_id = r.id and a.kind = 'poster' and a.status = 'ready') as has_poster,
            exists (select 1 from processing_jobs j where j.recording_id = r.id and j.queue = 'probe' and j.status in ('queued','active')) as probe_in_flight
          from recordings r
          where r.deleted_at is null and r.status in ('uploaded','processing','ready','failed','rejected_limit')
        )
        select
          count(*)::int as total_active,
          count(*) filter (where has_source)::int as with_source,
          count(*) filter (where has_source and has_mp4 and has_poster)::int as complete,
          count(*) filter (where has_source and not (has_mp4 and has_poster) and status in ('uploaded','processing','ready'))::int as pending,
          count(*) filter (where status = 'failed')::int as failed,
          count(*) filter (where status = 'rejected_limit')::int as rejected,
          count(*) filter (where probe_in_flight)::int as probe_in_flight
        from active`));
      const row = res.rows[0] || {};
      return {
        totalActive: Number(row.total_active || 0), withSource: Number(row.with_source || 0), complete: Number(row.complete || 0),
        pending: Number(row.pending || 0), failed: Number(row.failed || 0), rejected: Number(row.rejected || 0), probeInFlight: Number(row.probe_in_flight || 0),
      };
    },

    /**
     * Recordings with a ready source but no ready MP4 + poster, not deleted,
     * not rejected, with no probe job already queued/active — oldest first.
     * `includeFailed` adds failed(probe_invalid|transcode_failed) rows.
     */
    async listPipelineGapsSystem({ limit = 100, includeFailed = false } = {}, reason) {
      requireSystemReason(reason);
      const statuses = includeFailed ? ['uploaded', 'processing', 'ready', 'failed'] : ['uploaded', 'processing', 'ready'];
      return exec('recording', () => db.select().from(recordings).where(and(
        isNull(recordings.deletedAt),
        inArray(recordings.status, statuses),
        sql`exists (select 1 from video_assets a where a.recording_id = ${recordings.id} and a.kind = 'source' and a.status = 'ready')`,
        sql`not (exists (select 1 from video_assets a where a.recording_id = ${recordings.id} and a.kind = 'mp4' and a.status = 'ready')
                 and exists (select 1 from video_assets a where a.recording_id = ${recordings.id} and a.kind = 'poster' and a.status = 'ready'))`,
        sql`not exists (select 1 from processing_jobs j where j.recording_id = ${recordings.id} and j.queue = 'probe' and j.status in ('queued','active'))`,
        includeFailed ? sql`(${recordings.status} <> 'failed' or ${recordings.failureCode} in ('probe_invalid','transcode_failed'))` : sql`true`,
      )).orderBy(recordings.createdAt).limit(limit));
    },

    /** Cleanup job: soft-deleted rows past their retention window. */
    /**
     * T-803: where a legacy recording's bytes still live (docs/07 §13
     * `legacy.media_map`), for the READ fallback while the backfill runs.
     * @returns {Promise<Map<string, string>>} recordingId → legacy URL (only rows that have one)
     */
    async legacyMediaSystem(recordingIds, reason) {
      requireSystemReason(reason);
      const out = new Map();
      if (!Array.isArray(recordingIds) || recordingIds.length === 0) return out;
      const res = await exec('recording', () => db.execute(sql`
        select recording_id, legacy_url from legacy.media_map
        where recording_id in ${sql`(${sql.join(recordingIds.map((id) => sql`${id}`), sql`, `)})`} and legacy_url is not null`));
      for (const row of res.rows || []) out.set(row.recording_id, row.legacy_url);
      return out;
    },

    /**
     * T-803: unique non-owner views and live comment counts for a page of
     * recordings (docs/13 §3) — two grouped queries, never one per card.
     * @returns {Promise<Map<string, {views: number, comments: number}>>}
     */
    async engagementCountsSystem(recordingIds, reason) {
      requireSystemReason(reason);
      const out = new Map();
      if (!Array.isArray(recordingIds) || recordingIds.length === 0) return out;
      const list = sql`(${sql.join(recordingIds.map((id) => sql`${id}`), sql`, `)})`;
      const [views, comments] = await Promise.all([
        exec('view_session', () => db.execute(sql`select recording_id, count(*)::int as n from view_sessions where recording_id in ${list} and is_owner = false group by recording_id`)),
        exec('comment', () => db.execute(sql`select recording_id, count(*)::int as n from comments where recording_id in ${list} and deleted_at is null group by recording_id`)),
      ]);
      for (const id of recordingIds) out.set(id, { views: 0, comments: 0 });
      for (const row of views.rows || []) out.get(row.recording_id).views = Number(row.n);
      for (const row of comments.rows || []) out.get(row.recording_id).comments = Number(row.n);
      return out;
    },

    async listPurgeableSystem({ before, limit = 100 }, reason) {
      requireSystemReason(reason);
      return exec('recording', () => db.select().from(recordings)
        .where(and(isNotNull(recordings.deletedAt), lt(recordings.deletedAt, before)))
        .limit(limit));
    },

    /** Cleanup job (T-602): `rejected_limit` rows past their grace window (docs/09 §10). */
    async listRejectedSystem({ before, limit = 100 }, reason) {
      requireSystemReason(reason);
      return exec('recording', () => db.select().from(recordings)
        .where(and(eq(recordings.status, 'rejected_limit'), isNull(recordings.deletedAt), lt(recordings.createdAt, before)))
        .limit(limit));
    },

    async hardDeleteSystem(id, reason) {
      requireSystemReason(reason);
      const rows = await exec('recording', () =>
        db.delete(recordings).where(eq(recordings.id, id)).returning({ id: recordings.id }));
      return rows.length > 0;
    },
  };
};

module.exports.foldersRepo = function foldersRepo(db) {
  const owned = (userId, extra) => and(eq(folders.userId, userId), extra);
  return {
    async create(scope, { name }) {
      const { userId } = requireScope(scope);
      const [row] = await exec('folder', () =>
        db.insert(folders).values({ id: newId('folder'), userId, name }).returning());
      return row;
    },
    async list(scope) {
      const { userId } = requireScope(scope);
      return exec('folder', () => db.select().from(folders)
        .where(eq(folders.userId, userId)).orderBy(folders.name));
    },
    async get(scope, id) {
      const { userId } = requireScope(scope);
      const [row] = await exec('folder', () =>
        db.select().from(folders).where(owned(userId, eq(folders.id, id))).limit(1));
      return row || null;
    },
    async rename(scope, id, name) {
      const { userId } = requireScope(scope);
      const [row] = await exec('folder', () => db.update(folders).set({ name })
        .where(owned(userId, eq(folders.id, id))).returning());
      if (!row) throw new NotFoundError('folder');
      return row;
    },
    /** Recordings survive: recordings.folder_id is ON DELETE SET NULL. */
    async remove(scope, id) {
      const { userId } = requireScope(scope);
      const rows = await exec('folder', () => db.delete(folders)
        .where(owned(userId, eq(folders.id, id))).returning({ id: folders.id }));
      if (rows.length === 0) throw new NotFoundError('folder');
      return true;
    },
  };
};
