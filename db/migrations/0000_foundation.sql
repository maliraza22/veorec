-- ─────────────────────────────────────────────────────────────────────────────
-- 0000_foundation — database foundation only (T-101)
--
-- Deliberately contains NO application tables. Those are specified in docs/07
-- and created by T-102 (migration 0001). This migration establishes the shared
-- primitives every later table depends on, so 0001 can be a pure table diff:
--
--   • citext  — case-insensitive text, used for email columns (docs/07 §2)
--   • set_updated_at() — the trigger function behind the `updated_at` column
--     convention (docs/07 §1: "updated_at timestamptz not null default now()
--     (trigger-updated) on every table")
--
-- Both are idempotent so re-running against a partially-migrated database is
-- safe.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint

-- Sets NEW.updated_at on every UPDATE. T-102 attaches this to each table:
--   CREATE TRIGGER set_updated_at BEFORE UPDATE ON <table>
--     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
