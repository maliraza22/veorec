-- ─────────────────────────────────────────────────────────────────────────────
-- 0002_legacy_migration_schema — TRANSITIONAL migration tooling (T-104)
--
-- Everything here lives in a separate `legacy` schema, NOT in `public`:
--   • it is physically separated from the application model, so no application
--     query can accidentally depend on it;
--   • drizzle-kit only diffs `public` (schemaFilter), so these tables are
--     invisible to schema generation and can never be dropped by a stray diff;
--   • Phase 14 removal is one statement: DROP SCHEMA legacy CASCADE.
--
-- These tables exist ONLY because production media currently lives in
-- Cloudinary. Cloudinary is a migration SOURCE, never part of the target
-- architecture (docs/02 §2.7). The target end state is PostgreSQL metadata +
-- R2 storage keys with no Cloudinary dependency at all.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS legacy;
--> statement-breakpoint

-- Where a recording's bytes currently live, before T-204 copies them to R2.
-- Deliberately NOT a column on recordings/video_assets: the application model
-- stays storage-provider-neutral (docs/07 §13).
--
-- A recording with a row here and backfilled_at IS NULL has NO video_assets
-- row yet — that absence is the honest signal that its media is not in R2. We
-- never invent an R2 storage_key for an object that does not exist.
CREATE TABLE IF NOT EXISTS legacy.media_map (
  recording_id     text PRIMARY KEY REFERENCES public.recordings(id) ON DELETE CASCADE,
  legacy_provider  text NOT NULL DEFAULT 'cloudinary',
  legacy_public_id text NOT NULL,
  legacy_url       text,
  legacy_bytes     bigint,
  legacy_duration  numeric(10,3),
  legacy_format    text,
  imported_at      timestamptz NOT NULL DEFAULT now(),
  backfilled_at    timestamptz,          -- set by T-204 once the bytes are in R2
  backfill_error   text,
  CONSTRAINT legacy_media_map_provider_chk CHECK (legacy_provider IN ('cloudinary','local_disk'))
);
--> statement-breakpoint

-- Work queue for the T-204 backfill: everything still awaiting a copy to R2.
CREATE INDEX IF NOT EXISTS legacy_media_map_pending_idx
  ON legacy.media_map (imported_at) WHERE backfilled_at IS NULL;
--> statement-breakpoint

-- Idempotency for APPEND-ONLY sources that have no natural key (e.g. the
-- conversion-event log). Entities with stable legacy ids do not need this —
-- they get deterministic primary keys and ON CONFLICT instead.
CREATE TABLE IF NOT EXISTS legacy.import_checkpoints (
  source      text NOT NULL,
  key         text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  detail      jsonb,
  PRIMARY KEY (source, key)
);
--> statement-breakpoint

-- Audit trail of import runs: how many records each run touched, and whether it
-- was a dry run. Makes a partially-completed migration diagnosable.
CREATE TABLE IF NOT EXISTS legacy.import_runs (
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  dry_run     boolean NOT NULL,
  source_dir  text,
  report      jsonb,
  error       text
);
