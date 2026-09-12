# 10 — Jobs and Queues

> Durable background processing on **Redis + BullMQ**. Replaces: fire-and-forget promises (`autoProcessRecording`, `index.js:444-446`), the in-process single-slot transcription chain (`transcription.js:56-61`), synchronous Cloudinary renders inside HTTP handlers, and `cron.js`.

---

## 1. Principles

1. **Postgres is the record; the queue is transport.** Every job has a `processing_jobs` row (`07` §8) written transactionally with the mutation that caused it. If Redis is wiped, a reconciler re-enqueues everything `queued`/`active`-but-stalled from Postgres.
2. **Idempotent processors** (invariant #9): running any job twice produces the same end state. Achieved by: deterministic output keys, upserts keyed by dedupe key, and "check before do" (e.g. transcode first checks whether a `ready` asset with this dedupe key already exists → complete immediately).
3. **Dedupe**: `processing_jobs.dedupe_key` UNIQUE + BullMQ `jobId` = the **row id** (`job_…`, 1:1 with the unique dedupe key — BullMQ forbids `:` in custom ids, T-601) — the same logical job can never run twice concurrently.
4. **Jobs never talk to clients.** They write results to Postgres; clients poll `/recordings/:id/status` or the relevant resource.
5. **Failure is a state, not an exception**: exhausted retries → `status='failed'`, `last_error`, surfaced in `/admin/jobs`; user-visible impact defined per job below.

## 2. Infrastructure

- Queues (BullMQ): `media` (probe/transcode/thumbnail/hls/audio), `render`, `stt` (transcribe/translate), `ai` (title/summary/chapters), `maintenance` (cleanup/usage_sync/subscription_sync/upload_expiry), `email`. Reserved for the future: `render-gpu` — same job payloads/contracts as `render`, consumed by on-demand GPU workers (`02` §2.2); routing a job type between CPU and GPU fleets is a queue-name decision, invisible to the API and to clients.
- Interface `JobQueue { enqueue(queue, name, payload, opts): jobId }` wraps BullMQ so pg-boss remains a drop-in (decision `02` §10.4). Worker implementations (CPU FFmpeg, future GPU) are provider-agnostic consumers of the same contracts — no RunPod/host-specific logic in job code.
- **Transactional outbox**: API/worker writes `processing_jobs(status='queued')` inside the business tx; an outbox relay (small loop, 500ms) enqueues rows where `enqueued_at is null` into BullMQ and stamps them. Crash between commit and enqueue → relay picks it up. (Direct enqueue-after-commit is acceptable for non-critical jobs like email.)
- Workers: `apps/worker` process(es); graceful shutdown = stop taking jobs, finish current (≤ timeout), SIGKILL ffmpeg children.
- Stalled jobs: BullMQ stalled-check 60s; a stalled `active` job is re-queued (idempotency makes this safe).
- Backoff default: exponential, base 5s, factor 3, full jitter.

### 2.1 As implemented (T-601)

Package `worker/` (`@veorec/worker`; plain-package layout like `api/`, `db/`, `storage/` — the `apps/worker` path above is aspirational, as `02` notes for `apps/api`). **`JobQueue`** (`worker/src/queue/job-queue.js`): `enqueue({id,type,payload,attempts})` / `has(id,type)` / `subscribe(queue, handler, {concurrency,onFailed})` / `close()`; implementations `createBullJobQueue` (BullMQ 6 over Redis via `ioredis`; every job `removeOnComplete/removeOnFail` — the row keeps result and error; custom backoff = the §2 strategy) and `createInlineJobQueue` (`QUEUE_INLINE=true`, §7: same runner, no Redis, immediate retries). **Catalog** (`worker/src/catalog.js`): job type (`processing_jobs.queue`) → BullMQ queue `media | render | stt | ai | maintenance | email`, default attempts, timeout; asserted identical to the schema CHECK list; `stt` concurrency 1; `backoffMs(attempt)` = full jitter over `[0, min(1 h, 5 s·3^(attempt−1)))`. **Outbox relay** (`worker/src/outbox.js`, `OUTBOX_INTERVAL_MS` 500): `enqueued_at IS NULL` rows → `jobQueue.enqueue` → `markEnqueued`; single-flight; both crash halves verified (commit-then-crash is relayed next pass; enqueue-then-crash is enqueued again and the transport dedupes on the row id, so the job runs exactly once). **Reconciler** (same module, `RECONCILE_INTERVAL_MS` 60 s, `RECONCILE_MIN_AGE_MS` 5 min): stamped `queued` rows unknown to the transport are re-enqueued; `active` rows older than 2× their type's timeout that the transport no longer holds go back to `queued` (attempts kept) for the relay — the §1 "Redis wiped" promise. **Runner** (`worker/src/run-job.js`): reads the row first and skips settled ones (check-before-do); `markActive` increments `attempts` per RUN (a stalled re-delivery counts, so `max_attempts` bounds runs whatever the transport believes); per-type timeout with an `AbortSignal` handed to the processor (`{payload, job, signal, logger, deps, repositories}`); `18` §6 classification — `TerminalError` or exhausted attempts → `failed` + `last_error` and the transport is told not to retry (`UnrecoverableError`); anything else → `queued` + `last_error` and the transport backs off; a type this worker has no processor for is **deferred** (`moveToDelayed`, `WORKER_DEFER_MS` 5 s, no attempt consumed — rolling deploys with mixed worker versions); a job BullMQ gives up on (stalled beyond `maxStalledCount`) is marked `failed` from the `failed` event. **Stalled jobs**: lock 30 s / check 60 s (`WORKER_LOCK_DURATION_MS`, `WORKER_STALLED_INTERVAL_MS`); verified by SIGKILLing a real child worker mid-job. **Graceful shutdown** (`worker/src/app.js`): relay stops, consumers finish in-flight jobs ≤ `WORKER_SHUTDOWN_TIMEOUT_MS` (30 s), then every in-flight signal is aborted, child processes registered through `deps.children` are SIGKILLed, connections closed. **Registry** (`worker/src/registry.js`): a worker subscribes only to queues it has processors for; T-601 ships the default registry EMPTY (T-602/T-603/T-701+ register processors) — such a worker still relays and reconciles. **Entry point** `worker/src/main.js` (`npm run worker`): `@veorec/db` env/pool/repositories, optional `@veorec/storage`, pino logger `service=worker` with the API's redaction paths; SIGTERM/SIGINT → graceful stop → exit 0. **Admin**: `/api/v1/admin/jobs` (`08` §15) lists by status (default `failed`) and retries a failed job by resetting the row (`attempts 0`, unstamped) — the API never touches Redis. Tests: `tests/job-queue.test.js` (82), `tests/outbox.test.js` (37, real PostgreSQL + Redis), `tests/admin-jobs.test.js` (30). Local Redis: the docker-compose service, or any `redis-server --port 6380` (WSL works).

## 3. Job catalog

For each: **input** (payload), **output**, **retry**, **timeout**, **idempotency**, **failure impact / dead-letter behavior**.

### `media.probe`
- In: `{recordingId}`; dedupe `probe:{recordingId}`.
- Out: recording duration/dims; source asset facts; fan-out of transcode/thumbnail/(hls)/audio_extract; entitlement verdict (`09` §2).
- Retry 5× / timeout 5m. Idempotent: re-probing overwrites the same facts.
- Fail: recording `failed(probe_invalid)` only after retries exhausted **and** the error is deterministic (corrupt file); infra errors keep retrying. Dead-letter: admin triage; user sees "processing failed — Retry" (maps to `reprocess`).

> **As implemented (T-701):** see `09` §2.1 — facts + entitlement + fan-out; the job fails terminally with `probe_invalid` only for deterministic verdicts (corrupt/unsupported/size mismatch/missing source), keeps retrying on infrastructure errors; fan-out enqueues transcode/thumbnail/audio_extract (+ hls when earned) by dedupe key.

### `media.transcode`
- In: `{recordingId, sourceAssetId, variant:'mp4'}`; dedupe `transcode:{recordingId}:mp4`.
- Out: `video_assets(kind='mp4', status='ready')`; flips recording → `ready` when poster also ready (a tiny `maybe_mark_ready` check runs at the end of both jobs, in a tx, so whichever finishes second promotes).
- Retry 3× / timeout max(10m, 3×duration). Fail: recording `failed(transcode_failed)`; **source remains** — retryable from admin/user.

> **As implemented (T-702):** `09` §3.1 — check-before-do skip, asset-id-scoped output, progress on the row, verification before publish, publish + `maybe_mark_ready` in one transaction, `transcode_failed` only from the runner's post-settlement hook once attempts are exhausted; `transcode`/`hls`/`render` serialised per process by the runner (`TYPE_CONCURRENCY`).

### `media.thumbnail`
- In: `{recordingId}`; dedupe `thumb:{recordingId}`. Out: poster/thumb/preview assets. Retry 3× / 3m. Fail: non-fatal — a placeholder poster is served; job flagged for triage (does NOT block `ready` if the MP4 is done and poster generation failed 3× → promote with `poster:'placeholder'`; pragmatism over purity, logged loudly).

> **As implemented (T-703):** `09` §4.1 — non-black frame selection, poster + play-overlay + thumbnail + WebP preview as asset-id-scoped rows, promotion via `maybe_mark_ready` in the publishing transaction, and the placeholder promotion from the post-settlement hook when attempts are exhausted.

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

> **As implemented (T-603):** `worker/src/processors/stt.js` registers `transcribe` (queue `stt`, concurrency 1), `translate` (`stt`), `ai_title` / `ai_summary` / `ai_chapters` (queue `ai`). The pipeline itself is `worker/src/stt/transcription.js` (relocated `server/transcription.js`, every binary/URL/key/tuning value injectable; `15` §2.1) and the LLM helper `worker/src/stt/ai.js` (relocated `server/ai.js`). **Input**: the `audio` asset when the media pipeline produced one, else the immutable `source` (ffmpeg reads both; `09` §6) — downloaded to scratch, never through the API. **Groq budget**: one Redis fixed-window gate (`worker/src/stt/rate-gate.js`, `GROQ_RPM_BUDGET` 18/min) shared by every worker, plus the 3.1 s chunk pacing inside the job. **Statuses**: `transcripts.status` queued → running → done | failed and `recordings.ai_status` (aggregate, settled by a post-completion hook so the last job of a chain always lands on `done`; a terminal failure lands on `failed`). **Chain** (`15` §6): a finished transcript enqueues `ai_title` always and `ai_summary` + `ai_chapters` when the API said the user has AI docs (`payload.aiDocs` — the worker has no plan store); a re-transcription requeues settled chain rows so they run against the new transcript. **Failure classes** (`18` §6): undecodable media → terminal `audio_decode_failed`; no media → terminal `no_source`; no provider → terminal `transcription_unconfigured`; Groq 5xx/network, whisper failure, rate-limit exhaustion, missing ffmpeg → transient (job retries, transcript visibly `queued` between attempts). `no_speech` is a `done` transcript with zero segments (no chain). Idempotent: one transcript row per recording (upsert), segments replaced atomically. Restart-safe: verified by SIGKILLing a worker mid-transcription (the survivor re-runs from scratch). The API side is `api/src/ai.router.js` (`08` §12): 202 + rows only, and the T-301 upload completion enqueues the auto chain in the same transaction when `AUTO_PROCESS_ON_UPLOAD` is on, the user is entitled and the clip is ≥ 3 s.

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

> **As implemented (T-602):** the PostgreSQL-side maintenance jobs are plain functions in `@veorec/db` — `db/src/maintenance/usage-sync.js`, `upload-expiry.js`, `cleanup.js` (retention purge of soft-deleted recordings with `pending_deletion −= bytes` under the usage row lock, `rejected_limit` purge after the 7-day grace, expired/revoked auth-session purge, and the **report-only** weekly orphan scan of `09` §10), `storage-verification.js` (over-limit report from the live aggregates, plan resolved from PostgreSQL rows through the one catalog) — and run in the worker as **repeatables**: BullMQ job schedulers on the `maintenance` queue are only the *ticker*; each tick creates the job as a `processing_jobs` row whose dedupe key is the time bucket (`usage_sync:2026-09-12`, `upload_expiry:2026-09-12T14`, `cleanup:2026-09-12`, `cleanup:orphans:2026-W37`), so a bucket runs at most once however many workers tick, every run is visible and retryable in `/admin/jobs`, and a lost Redis costs one tick at most (`worker/src/scheduler.js`; `WORKER_SCHEDULER=false` opts a worker out; only a worker that runs the maintenance types installs the ticker). `storage_verification` runs inside `usage_sync` (one daily pass over the same users; its report is the job result). `node db/src/cli/maintenance.js <usage_sync|upload_expiry|cleanup [--orphans]>` still runs one by hand. The legacy `server/cron.js` schedules **nothing v1** any more; it keeps only the three jobs that read/write the legacy JSON stores (see `subscription_sync` below).

### `maintenance.subscription_sync` (repeat daily)
Reconcile each subscription with Paddle via `billing.service.syncSubscription` (replaces `cron.dailySubscriptionSync`). Also `maintenance.storage_verification` — flag over-limit accounts (as `cron.js:45-56`).

> **Deferred (T-602):** `subscription_sync` reconciles the LEGACY JSON subscription store (`server/subscriptions.js`, written by `billing.service.syncSubscription`), and a file store has exactly one writer — the API process. Until billing lives in PostgreSQL (`23` Phase 9–13) it stays on `server/cron.js` (with the legacy `dailyUsageSync` and `dailyStorageVerification` over the legacy stores); the job type is kept in the catalog so its move is a processor registration, not a contract change. `cron.js` is deleted with the legacy stores in Phase 14, not in Phase 6. The PostgreSQL over-limit report (`storage_verification`) already runs in the worker inside `usage_sync`.

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

docker-compose Redis; `npm run worker` runs all processors in one process; `QUEUE_INLINE=true` mode executes jobs synchronously in-process for API integration tests (same code path through the JobQueue interface). *(T-601: `cd worker && npm run worker`; `REDIS_URL` defaults to `redis://127.0.0.1:6380` for local/test only and is required for staging/production; `QUEUE_PREFIX` namespaces the keys; the inline queue is `createInlineJobQueue()` and is what `tests/admin-jobs.test.js` uses to run a retried row without Redis.)*
