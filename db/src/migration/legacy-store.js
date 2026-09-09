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

    // ── T-204 backfill checklist ────────────────────────────────────────────
    //
    // Claiming is ONE atomic statement. That matters more than it looks: the
    // transfer that follows can take minutes for a large recording, and holding
    // a PostgreSQL transaction open across it would pin a connection and block
    // vacuum for the whole copy. So the claim commits immediately and the bytes
    // move with no database transaction open at all.
    //
    // FOR UPDATE SKIP LOCKED is what makes several workers safe: each grabs a
    // disjoint set instead of blocking on the same rows, so two copiers never
    // process the same recording concurrently.
    async claimBackfillBatch({ claimId, limit = 5, staleClaimMs = 15 * 60 * 1000, excludeIds = [] } = {}) {
      // Items already attempted in THIS run are excluded. Without it a
      // retryable failure is re-claimed by the very next batch, burning its
      // whole attempt budget in one tight loop and hammering a legacy provider
      // that is already returning 5xx — the opposite of throttled. A transient
      // failure should be retried on a LATER run, not immediately.
      const exclude = excludeIds.length
        ? sql` AND m2.recording_id NOT IN (${sql.join(excludeIds.map((id) => sql`${id}`), sql`, `)})`
        : sql``;
      const res = await db.execute(sql`
        WITH eligible AS (
          SELECT m2.recording_id FROM legacy.media_map m2
           WHERE m2.backfilled_at IS NULL${exclude}
             AND (
               m2.backfill_status IN ('pending', 'failed')
               -- A worker that crashed mid-copy leaves its row 'claimed'
               -- forever. Ageing the claim out is what makes the crash
               -- recoverable without anyone intervening.
               OR (m2.backfill_status = 'claimed'
                   AND m2.backfill_claimed_at < now() - (${staleClaimMs} || ' milliseconds')::interval)
             )
             -- 'skipped' and 'unsafe' are deliberate terminal decisions and are
             -- never re-claimed automatically.
             AND (m2.backfill_retryable IS DISTINCT FROM false)
           ORDER BY m2.imported_at
           LIMIT ${limit}
           FOR UPDATE SKIP LOCKED
        )
        UPDATE legacy.media_map m
           SET backfill_status = 'claimed',
               backfill_claim_id = ${claimId},
               backfill_claimed_at = now(),
               backfill_attempts = m.backfill_attempts + 1
          FROM eligible e
         WHERE m.recording_id = e.recording_id
        RETURNING m.*`);
      return res.rows || res;
    },

    /** Completion. Only reached after the object was re-read and its size matched. */
    async markBackfillVerified(recordingId, { bytes = null } = {}) {
      await db.execute(sql`
        UPDATE legacy.media_map
           SET backfill_status = 'verified', backfilled_at = now(),
               backfill_error = NULL, backfill_retryable = NULL,
               backfill_claim_id = NULL, backfill_claimed_at = NULL,
               backfill_bytes = ${bytes}
         WHERE recording_id = ${recordingId}`);
    },

    /**
     * A failed attempt. `retryable` decides whether the next run picks it up
     * again — an unreachable provider should be retried, a size mismatch or a
     * broken mapping should not be retried forever behind a human's back.
     */
    async markBackfillFailed(recordingId, { error, retryable = true, status = 'failed' } = {}) {
      await db.execute(sql`
        UPDATE legacy.media_map
           SET backfill_status = ${status},
               backfill_error = ${String(error || '').slice(0, 500)},
               backfill_retryable = ${!!retryable},
               backfill_claim_id = NULL, backfill_claimed_at = NULL
         WHERE recording_id = ${recordingId}`);
    },

    async backfillStats() {
      const res = await db.execute(sql`
        SELECT backfill_status AS status, count(*)::int AS n
          FROM legacy.media_map GROUP BY backfill_status`);
      const rows = res.rows || res;
      const out = { pending: 0, claimed: 0, verified: 0, failed: 0, skipped: 0, unsafe: 0 };
      for (const r of rows) out[r.status] = Number(r.n);
      out.total = Object.values(out).reduce((a, b) => a + b, 0);
      return out;
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
