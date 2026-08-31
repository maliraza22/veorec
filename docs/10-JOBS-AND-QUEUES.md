# 10 — Jobs and Queues

> Durable background processing on **Redis + BullMQ**. Replaces: fire-and-forget promises (`autoProcessRecording`, `index.js:444-446`), the in-process single-slot transcription chain (`transcription.js:56-61`), synchronous Cloudinary renders inside HTTP handlers, and `cron.js`.

---

## 1. Principles

1. **Postgres is the record; the queue is transport.** Every job has a `processing_jobs` row (`07` §8) written transactionally with the mutation that caused it. If Redis is wiped, a reconciler re-enqueues everything `queued`/`active`-but-stalled from Postgres.
2. **Idempotent processors** (invariant #9): running any job twice produces the same end state. Achieved by: deterministic output keys, upserts keyed by dedupe key, and "check before do" (e.g. transcode first checks whether a `ready` asset with this dedupe key already exists → complete immediately).
3. **Dedupe**: `processing_jobs.dedupe_key` UNIQUE + BullMQ `jobId = dedupe_key` — the same logical job can never run twice concurrently.
4. **Jobs never talk to clients.** They write results to Postgres; clients poll `/recordings/:id/status` or the relevant resource.
5. **Failure is a state, not an exception**: exhausted retries → `status='failed'`, `last_error`, surfaced in `/admin/jobs`; user-visible impact defined per job below.

## 2. Infrastructure

- Queues (BullMQ): `media` (probe/transcode/thumbnail/hls/audio), `render`, `stt` (transcribe/translate), `ai` (title/summary/chapters), `maintenance` (cleanup/usage_sync/subscription_sync/upload_expiry), `email`.
- Interface `JobQueue { enqueue(queue, name, payload, opts): jobId }` wraps BullMQ so pg-boss remains a drop-in (decision `02` §10.4).
- **Transactional outbox**: API/worker writes `processing_jobs(status='queued')` inside the business tx; an outbox relay (small loop, 500ms) enqueues rows where `enqueued_at is null` into BullMQ and stamps them. Crash between commit and enqueue → relay picks it up. (Direct enqueue-after-commit is acceptable for non-critical jobs like email.)
- Workers: `apps/worker` process(es); graceful shutdown = stop taking jobs, finish current (≤ timeout), SIGKILL ffmpeg children.
- Stalled jobs: BullMQ stalled-check 60s; a stalled `active` job is re-queued (idempotency makes this safe).
- Backoff default: exponential, base 5s, factor 3, full jitter.

## 3. Job catalog

For each: **input** (payload), **output**, **retry**, **timeout**, **idempotency**, **failure impact / dead-letter behavior**.

### `media.probe`
- In: `{recordingId}`; dedupe `probe:{recordingId}`.
- Out: recording duration/dims; source asset facts; fan-out of transcode/thumbnail/(hls)/audio_extract; entitlement verdict (`09` §2).
- Retry 5× / timeout 5m. Idempotent: re-probing overwrites the same facts.
- Fail: recording `failed(probe_invalid)` only after retries exhausted **and** the error is deterministic (corrupt file); infra errors keep retrying. Dead-letter: admin triage; user sees "processing failed — Retry" (maps to `reprocess`).

### `media.transcode`
- In: `{recordingId, sourceAssetId, variant:'mp4'}`; dedupe `transcode:{recordingId}:mp4`.
- Out: `video_assets(kind='mp4', status='ready')`; flips recording → `ready` when poster also ready (a tiny `maybe_mark_ready` check runs at the end of both jobs, in a tx, so whichever finishes second promotes).
- Retry 3× / timeout max(10m, 3×duration). Fail: recording `failed(transcode_failed)`; **source remains** — retryable from admin/user.

### `media.thumbnail`
- In: `{recordingId}`; dedupe `thumb:{recordingId}`. Out: poster/thumb/preview assets. Retry 3× / 3m. Fail: non-fatal — a placeholder poster is served; job flagged for triage (does NOT block `ready` if the MP4 is done and poster generation failed 3× → promote with `poster:'placeholder'`; pragmatism over purity, logged loudly).

### `media.hls`
- In: `{recordingId}`; conditional (>5min or >1080p); dedupe `hls:{recordingId}`. Retry 3× / long timeout. Fail: non-fatal (MP4 remains the playback path).

### `media.audio_extract`
- In: `{recordingId}`; dedupe `audio:{recordingId}`. Out: audio asset; chains `stt.transcribe` when auto-processing is on. Retry 3× / 10m. Fail: transcript status `failed(audio_extract_failed)`.

### `stt.transcribe`
- In: `{recordingId, language?, trigger:'auto'|'manual'}`; dedupe `stt:{recordingId}`.
- Out: `transcripts` + `transcript_segments`; chains `media.captions` + (auto mode) `ai.title`/`ai.summary`/`ai.chapters` per entitlements — the current auto-process behavior (`index.js:340-370`) reproduced as a job chain.
- Rate limit: BullMQ limiter on `stt` queue (Groq 20 RPM shared budget; the VAD chunk pacing from `transcription.js` stays inside the job). Concurrency 1 initially (matches today's single-slot but now restart-safe and observable).
- Retry 3× (429-driven failures retry with longer backoff honoring Retry-After) / timeout 30m. Fail: `transcripts.status='failed'` + error; **video unaffected** (invariant #14). UI shows "transcription failed — retry".

### `stt.translate`
- In: `{recordingId, lang}`; dedupe `translate:{recordingId}:{lang}`. Out: `transcript_translations` row (cached — today recomputed every request). Retry 2×/10m. Fail: user-visible error on the translate control only.

### `ai.title`, `ai.summary`, `ai.chapters`
- In: `{recordingId, trigger}`; dedupe `ai_title:{recordingId}` etc. Preconditions: transcript `done`; title job respects the DEFAULT_TITLES guard (never overwrite a user-set title — port `index.js:339-342`).
- Out: recording title/description/chapters; `ai_status` transitions. Uses `ai.js` logic (summary-first titling for non-English — keep that hard-won fix). Retry 2× / 5m. Fail: `ai_status='failed'`; silent for auto-trigger (video fine), error surfaced for manual trigger.

### `render.render_edit` (spec `14` §5)
- In: `{editSessionId, renderJobId, mode}`; dedupe `render:{editSessionId}:{renderJobId}`.
- Out: `render_output` asset (+ new recording in copy mode); `render_jobs.status`; progress streamed to `processing_jobs.result.progress`.
- Retry 2× / max(15m, 4×output duration). Fail: `render_jobs.failed` + editor error toast; sources untouched (invariant #13 makes render failure always recoverable).

### `maintenance.upload_expiry` (repeat hourly)
Abort S3 multiparts + mark sessions expired past `expires_at` (`06` §8), **releasing each session's quota reservation** (`16` §4.4) — the healing path for abandoned tabs, crashes, and server restarts that left reservations held.

### `maintenance.cleanup` (repeat daily)
Hard-purge soft-deleted recordings >30d (R2 objects then rows); purge `rejected_limit` >7d; purge expired auth sessions; orphan report weekly (`09` §10).

### `maintenance.usage_sync` (repeat daily)
Re-derive the quota ledger per user from Postgres aggregates — `storage_retained_bytes` from `counts_toward_quota` assets, `active_video_count` from recording statuses, `storage_pending_deletion_bytes` from soft-deleted rows — expire orphaned `storage_reservations`, and log drift > 1% (replaces `cron.dailyUsageSync`).

### `maintenance.subscription_sync` (repeat daily)
Reconcile each subscription with Paddle via `billing.service.syncSubscription` (replaces `cron.dailySubscriptionSync`). Also `maintenance.storage_verification` — flag over-limit accounts (as `cron.js:45-56`).

### `email.send`
- In: `{to, template, params}`; dedupe on caller-supplied key where duplicates matter (invites). Retry 5× w/ backoff. Fail: logged; never user-blocking.

## 4. Status model (uniform)

`queued → active → completed | failed | cancelled`. `attempts`, `last_error`, `result` on the row. `GET /recordings/:id/status` projects the pipeline: each queue's latest job for the recording with `{queue,status,progress}`.

## 5. Dead-letter behavior

`failed` rows ARE the dead-letter queue (queryable: `/admin/jobs?status=failed`). Admin actions: retry (re-enqueue same dedupe key with attempts reset), cancel (mark cancelled + apply the job's declared user-visible failure state). Alert when failed-count over 15m exceeds thresholds (`19` §5).

## 6. Ordering & concurrency contracts

- Per-recording pipeline ordering is enforced by **chaining** (a job enqueues its successors), not by queue ordering.
- Two jobs writing the same recording row use short transactions + row locks; none hold locks across I/O.
- `maybe_mark_ready` is the only place `status='ready'` is set; it runs with `SELECT ... FOR UPDATE` on the recording.

## 7. Local development

docker-compose Redis; `npm run worker` runs all processors in one process; `QUEUE_INLINE=true` mode executes jobs synchronously in-process for API integration tests (same code path through the JobQueue interface).
