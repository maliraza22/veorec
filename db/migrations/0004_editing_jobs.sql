-- ─────────────────────────────────────────────────────────────────────────────
-- T-1204 — the `silence_detect` job type (docs/14 §7, docs/10 §4)
--
-- Silence removal becomes a worker job: `ffmpeg silencedetect` over the
-- recording's audio (transcript-gap fallback) whose result is applied as a
-- VIRTUAL edit (keep-ranges → recordings.segments). The job needs its own
-- type in `processing_jobs.queue` — the CHECK list is the catalog's twin
-- (worker/src/catalog.js is asserted identical to it), so both grow together.
--
-- Nothing else changes: same table, same statuses, same dedupe rule
-- (`silence:{recordingId}` — one detection per recording at a time).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "processing_jobs"
  DROP CONSTRAINT IF EXISTS "processing_jobs_queue_chk";
--> statement-breakpoint

ALTER TABLE "processing_jobs"
  ADD CONSTRAINT "processing_jobs_queue_chk"
  CHECK ("processing_jobs"."queue" IN ('probe','transcode','thumbnail','hls','audio_extract','captions','transcribe','translate','ai_title','ai_summary','ai_chapters','render','silence_detect','cleanup','usage_sync','subscription_sync','upload_expiry','email'));
--> statement-breakpoint
