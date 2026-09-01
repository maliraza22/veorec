// Data access for the transitional `legacy` schema (T-104).
//
// Deliberately NOT part of the repository barrel: these tables exist only for
// the migration window, and keeping their access here means the application's
// data-access layer never learns about Cloudinary or import bookkeeping.
// Phase 14 deletes this file together with `DROP SCHEMA legacy CASCADE`.
'use strict';

const { sql } = require('drizzle-orm');

module.exports = function legacyStore(db) {
  return {
    /**
     * Record where a recording's bytes currently live. Idempotent: re-running
     * the importer refreshes the pointer without disturbing backfill progress.
     */
    async upsertMediaMap(entry) {
      const rows = await db.execute(sql`
        INSERT INTO legacy.media_map
          (recording_id, legacy_provider, legacy_public_id, legacy_url, legacy_bytes, legacy_duration, legacy_format)
        VALUES (${entry.recordingId}, ${entry.provider || 'cloudinary'}, ${entry.publicId},
                ${entry.url ?? null}, ${entry.bytes ?? null}, ${entry.duration ?? null}, ${entry.format ?? null})
        ON CONFLICT (recording_id) DO UPDATE SET
          legacy_provider = EXCLUDED.legacy_provider,
          legacy_public_id = EXCLUDED.legacy_public_id,
          legacy_url = EXCLUDED.legacy_url,
          legacy_bytes = EXCLUDED.legacy_bytes,
          legacy_duration = EXCLUDED.legacy_duration,
          legacy_format = EXCLUDED.legacy_format
        RETURNING recording_id, (xmax = 0) AS inserted`);
      return rows.rows ? rows.rows[0] : rows[0];
    },

    async countPendingBackfill() {
      const res = await db.execute(sql`SELECT count(*)::int AS n FROM legacy.media_map WHERE backfilled_at IS NULL`);
      const rows = res.rows || res;
      return Number(rows[0].n);
    },

    async getMediaMap(recordingId) {
      const res = await db.execute(sql`SELECT * FROM legacy.media_map WHERE recording_id = ${recordingId}`);
      const rows = res.rows || res;
      return rows[0] || null;
    },

    // ── Checkpoints: idempotency for append-only sources with no natural key ──
    async hasCheckpoint(source, key) {
      const res = await db.execute(
        sql`SELECT 1 FROM legacy.import_checkpoints WHERE source = ${source} AND key = ${key}`);
      const rows = res.rows || res;
      return rows.length > 0;
    },

    async putCheckpoint(source, key, detail = null) {
      await db.execute(sql`
        INSERT INTO legacy.import_checkpoints (source, key, detail)
        VALUES (${source}, ${key}, ${detail ? JSON.stringify(detail) : null}::jsonb)
        ON CONFLICT (source, key) DO NOTHING`);
    },

    async loadCheckpointKeys(source) {
      const res = await db.execute(sql`SELECT key FROM legacy.import_checkpoints WHERE source = ${source}`);
      const rows = res.rows || res;
      return new Set(rows.map((r) => r.key));
    },

    // ── Run log ─────────────────────────────────────────────────────────────
    async startRun({ dryRun, sourceDir }) {
      const res = await db.execute(sql`
        INSERT INTO legacy.import_runs (dry_run, source_dir) VALUES (${dryRun}, ${sourceDir}) RETURNING id`);
      const rows = res.rows || res;
      return rows[0].id;
    },

    async finishRun(id, report, error = null) {
      await db.execute(sql`
        UPDATE legacy.import_runs
        SET finished_at = now(), report = ${JSON.stringify(report)}::jsonb, error = ${error}
        WHERE id = ${id}`);
    },
  };
};
