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
const { exec, NotFoundError } = require('./errors');
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

    /** Cleanup job: soft-deleted rows past their retention window. */
    async listPurgeableSystem({ before, limit = 100 }, reason) {
      requireSystemReason(reason);
      return exec('recording', () => db.select().from(recordings)
        .where(and(isNotNull(recordings.deletedAt), lt(recordings.deletedAt, before)))
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
