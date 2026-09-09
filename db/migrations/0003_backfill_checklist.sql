-- ─────────────────────────────────────────────────────────────────────────────
-- T-204 — backfill checklist state on legacy.media_map
--
-- T-104 already created legacy.media_map as the per-recording record of where
-- the bytes live today, with `backfilled_at` reserved for T-204. That timestamp
-- alone cannot express work that is IN PROGRESS, has been attempted and failed,
-- or must not be attempted at all — and without that, a crashed worker's items
-- would either be retried forever or lost.
--
-- These columns turn the same row into the checklist. Deliberately NOT a second
-- table: two tables tracking one recording would be two sources of truth about
-- the same fact, and they would drift.
--
-- Everything here lives in the migration-only `legacy` schema and disappears
-- with `DROP SCHEMA legacy CASCADE` in Phase 14 (T-1402).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE legacy.media_map
  -- pending  : never attempted (the initial state for every imported row)
  -- claimed  : a worker holds it right now; `backfill_claimed_at` ages the claim
  -- verified : bytes are in R2 AND the object was re-read and its size matched
  -- failed   : an attempt failed; `backfill_retryable` says whether to try again
  -- skipped  : deliberately not copied (e.g. bytes unreachable from this host)
  -- unsafe   : ambiguous mapping — needs a human, never auto-repaired
  ADD COLUMN IF NOT EXISTS backfill_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS backfill_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS backfill_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS backfill_claim_id text,
  ADD COLUMN IF NOT EXISTS backfill_retryable boolean,
  ADD COLUMN IF NOT EXISTS backfill_bytes bigint;
--> statement-breakpoint

ALTER TABLE legacy.media_map
  DROP CONSTRAINT IF EXISTS legacy_media_map_backfill_status_chk;
--> statement-breakpoint

ALTER TABLE legacy.media_map
  ADD CONSTRAINT legacy_media_map_backfill_status_chk
  CHECK (backfill_status IN ('pending','claimed','verified','failed','skipped','unsafe'));
--> statement-breakpoint

-- A verified row must carry the completion stamp, and a stamped row must be
-- verified. This is what stops "the database says done" from drifting away from
-- "the object was actually checked", which is the failure mode that would make
-- the whole backfill untrustworthy.
ALTER TABLE legacy.media_map
  DROP CONSTRAINT IF EXISTS legacy_media_map_backfilled_consistency_chk;
--> statement-breakpoint

ALTER TABLE legacy.media_map
  ADD CONSTRAINT legacy_media_map_backfilled_consistency_chk
  CHECK ((backfill_status = 'verified') = (backfilled_at IS NOT NULL));
--> statement-breakpoint

ALTER TABLE legacy.media_map
  DROP CONSTRAINT IF EXISTS legacy_media_map_backfill_attempts_chk;
--> statement-breakpoint

ALTER TABLE legacy.media_map
  ADD CONSTRAINT legacy_media_map_backfill_attempts_chk CHECK (backfill_attempts >= 0);
--> statement-breakpoint

-- Rows already stamped by an earlier run (none expected yet, but the migration
-- must be correct if one exists) are verified by definition.
UPDATE legacy.media_map SET backfill_status = 'verified'
  WHERE backfilled_at IS NOT NULL AND backfill_status = 'pending';
--> statement-breakpoint

-- The claim queue: work that is eligible now, cheapest-first for the worker.
-- Partial index so the queue stays small as the verified set grows.
CREATE INDEX IF NOT EXISTS legacy_media_map_backfill_queue_idx
  ON legacy.media_map (backfill_status, imported_at)
  WHERE backfill_status IN ('pending','failed');
--> statement-breakpoint

-- Ages out claims left behind by a crashed worker.
CREATE INDEX IF NOT EXISTS legacy_media_map_backfill_claim_idx
  ON legacy.media_map (backfill_claimed_at)
  WHERE backfill_status = 'claimed';
