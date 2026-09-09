// Video assets — the physical media rows (docs/07 §3).
//
// `storage_key` is an opaque, provider-neutral object key. This repository
// never talks to R2/S3/Cloudinary; resolving a key to bytes or a signed URL is
// the StorageProvider's job (T-201).
//
// Owner-facing reads join through `recordings` so ownership is enforced in SQL
// rather than by the caller. Writes come from the processing pipeline and are
// therefore *System methods.
'use strict';

const { and, eq, isNull } = require('drizzle-orm');
const { videoAssets, recordings } = require('../schema');
const { newId } = require('../ids');
const { exec, NotFoundError } = require('./errors');
const { requireScope, requireSystemReason } = require('./scope');

module.exports = function assetsRepo(db) {
  return {
    /** Ownership enforced by the join — no way to read another user's assets. */
    async listForRecording(scope, recordingId) {
      const { userId } = requireScope(scope);
      const rows = await exec('video_asset', () => db.select({ asset: videoAssets })
        .from(videoAssets)
        .innerJoin(recordings, eq(videoAssets.recordingId, recordings.id))
        .where(and(
          eq(videoAssets.recordingId, recordingId),
          eq(recordings.userId, userId),
          isNull(recordings.deletedAt),
        )));
      return rows.map((r) => r.asset);
    },

    async getForRecording(scope, recordingId, { kind, variant = null } = {}) {
      const assets = await this.listForRecording(scope, recordingId);
      return assets.find((a) => a.kind === kind && (a.variant ?? null) === variant) || null;
    },

    // ── Pipeline surface (workers have no user scope) ───────────────────────
    async createSystem(data, reason) {
      requireSystemReason(reason);
      const [row] = await exec('video_asset', () => db.insert(videoAssets).values({
        id: data.id || newId('asset'),
        recordingId: data.recordingId,
        kind: data.kind,
        storageKey: data.storageKey,
        status: data.status || 'pending',
        sizeBytes: data.sizeBytes ?? null,
        width: data.width ?? null,
        height: data.height ?? null,
        duration: data.duration ?? null,
        codecVideo: data.codecVideo ?? null,
        codecAudio: data.codecAudio ?? null,
        container: data.container ?? null,
        checksum: data.checksum ?? null,
        variant: data.variant ?? null,
        // Source media is immutable and is what bills the user; derived
        // renditions are platform overhead (docs/16 §4.1).
        immutable: data.immutable ?? (data.kind === 'source'),
        countsTowardQuota: data.countsTowardQuota ?? (data.kind === 'source'),
        createdByJobId: data.createdByJobId ?? null,
      }).returning());
      return row;
    },

    /**
     * Idempotently record a mirrored SOURCE asset (T-203).
     *
     * The upload mirror can run more than once for the same recording — a
     * retried request, a replayed journal entry — and every attempt writes the
     * SAME deterministic storage key. A plain insert would hit
     * `video_assets_storage_key_uniq` on the second attempt and be reported as
     * a failure when nothing is wrong, so this converges on the existing row.
     *
     * The conflict target is the storage key, not the id: the key is what
     * uniquely identifies the object in the bucket, so "two rows describing one
     * object" is the state that must be impossible.
     *
     * System-scoped: the mirror runs outside any user request, and ownership
     * was already established by the legacy handler that produced the
     * recording. `reason` is mandatory so an unscoped write stays attributable.
     */
    async upsertSourceSystem(data, reason) {
      requireSystemReason(reason);
      const [row] = await exec('video_asset', () => db.insert(videoAssets).values({
        id: data.id || newId('asset'),
        recordingId: data.recordingId,
        kind: data.kind || 'source',
        storageKey: data.storageKey,
        status: data.status || 'ready',
        sizeBytes: data.sizeBytes ?? null,
        width: data.width ?? null,
        height: data.height ?? null,
        duration: data.duration ?? null,
        container: data.container ?? null,
        checksum: data.checksum ?? null,
        // The original upload is never rewritten, and it is the recording's
        // primary media, so it is the asset that bills the user (docs/16 §4.1).
        immutable: data.immutable ?? true,
        countsTowardQuota: data.countsTowardQuota ?? true,
      }).onConflictDoUpdate({
        target: videoAssets.storageKey,
        set: {
          // Only facts about the SAME object may change on a re-run (a size we
          // learned later, a probe result). Never the recording it belongs to —
          // re-pointing an object at a different owner's recording is exactly
          // the cross-tenant mistake this layer exists to prevent.
          sizeBytes: data.sizeBytes ?? null,
          status: data.status || 'ready',
          container: data.container ?? null,
          checksum: data.checksum ?? null,
          updatedAt: new Date(),
        },
      }).returning());
      return row;
    },

    async updateSystem(id, patch, reason) {
      requireSystemReason(reason);
      const allowed = ['status', 'sizeBytes', 'width', 'height', 'duration',
        'codecVideo', 'codecAudio', 'container', 'checksum', 'createdByJobId'];
      const values = Object.fromEntries(
        Object.entries(patch || {}).filter(([k, v]) => allowed.includes(k) && v !== undefined));
      if (Object.keys(values).length === 0) return null;
      const [row] = await exec('video_asset', () =>
        db.update(videoAssets).set(values).where(eq(videoAssets.id, id)).returning());
      if (!row) throw new NotFoundError('video_asset');
      return row;
    },

    async listByRecordingSystem(recordingId, reason) {
      requireSystemReason(reason);
      return exec('video_asset', () =>
        db.select().from(videoAssets).where(eq(videoAssets.recordingId, recordingId)));
    },

    /** Playback resolution, after the caller has authorised the recording. */
    async findReadySystem(recordingId, kind, reason, { variant = null } = {}) {
      requireSystemReason(reason);
      const rows = await exec('video_asset', () => db.select().from(videoAssets)
        .where(and(
          eq(videoAssets.recordingId, recordingId),
          eq(videoAssets.kind, kind),
          eq(videoAssets.status, 'ready'),
        )));
      return rows.find((r) => (r.variant ?? null) === variant) || null;
    },
  };
};
