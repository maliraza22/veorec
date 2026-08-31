# 00 — Executive Summary

> **Status:** Canonical specification for rebuilding VeoRec. Written 2026-09-01 after a full audit of the existing codebase at `C:\Users\DELL\ScreenRecorder`.
> **Audience:** Any engineer (human or Claude Code session) working on this project. Read this first, then `01-CURRENT-CODEBASE-AUDIT.md` and `02-ARCHITECTURE.md`.

---

## 1. What the product is

**VeoRec** is a Loom-style screen recording and video messaging platform:

- A **Chrome extension (MV3)** records the screen, a browser tab, a window, the camera, the microphone, and tab/system audio; shows an on-page control overlay, camera bubble, drawing/annotation tools, and click highlighting.
- Recordings upload automatically and produce an **instant share link** (`veorec.com/watch/:id`).
- A **web app** (React) provides the library/dashboard, folders, a watch page with comments/reactions/transcript, a multi-clip timeline editor (trim/split/stitch), viewer analytics, lead capture, and account/billing management.
- **AI features**: multilingual transcription (Groq Whisper large-v3 with a VAD chunking pipeline, self-hosted whisper.cpp fallback), auto-title, summary, chapters, translation to ~99 languages, silence removal.
- **Monetization**: Free/Pro plans (Paddle billing, capability-based entitlements), usage limits (video count, storage, recording length), an admin panel with business metrics.
- **Integrations**: Slack incoming-webhook sharing, a Gmail compose "insert video" button, email (Brevo), Google sign-in.

The **feature set is good and should be preserved**. The architecture underneath it is not production-grade and is the source of the recording/upload unreliability.

## 2. Current architectural condition

| Layer | Current state | Verdict |
|---|---|---|
| Recording engine | In-memory `chunks[]` in a popup window; state = scattered booleans across 4 contexts | **Replace** |
| Upload | One monolithic multipart POST through the app server → Cloudinary | **Replace** |
| Local durability | None. Only an in-memory blob + a manual "save to device" button after failure | **Build new** |
| Application database | **Cloudinary Search/Admin API used as the database** + 10 JSON files on a Railway volume | **Replace** |
| Processing | Synchronous inside HTTP handlers, or fire-and-forget promises; in-process promise-chain "queue" | **Replace** |
| Media transforms | Cloudinary derived-URL transforms (trim/splice) triggered synchronously | **Replace with FFmpeg workers** |
| Auth | JWT (30d) in localStorage, bcrypt, Google tokeninfo; no revocation | **Redesign (keep concepts)** |
| Billing | Paddle webhooks → JSON subscription store; sound capability model | **Keep model, move storage to Postgres** |
| Entitlements/plans | Capability-based plan catalog (`plans.js`, `entitlements.js`, `permissions.service.js`) | **Keep design as-is** |
| Frontend | React 18 + Vite; `Watch.jsx` is a 1,353-line god component but works | **Keep, refactor incrementally** |
| Extension UX | Overlay/bubble/annotation UX is genuinely good | **Keep UX, rebuild engine underneath** |
| Tests | One unit test (`tests/fixwebm.test.js`) | **Build full strategy** |
| Observability | `console.log` only | **Build new** |

## 3. Major problems (root causes, not symptoms)

The five root causes that generate almost all observed bugs:

1. **No durable source of truth.** Cloudinary's eventually-consistent Search API is queried as if it were a database. Every "video disappeared / rename reverted / 404 after upload" bug traces here. The code is full of compensating hacks (dual Search+Admin merges in `server/index.js:473-486`, 6× retry loops on the watch page `client/src/pages/Watch.jsx:494-509`).
2. **The recording only exists in RAM.** `extension/recorder.js` accumulates chunks in an array. Closing the recorder popup, a renderer crash, an extension update, or an OOM kill destroys the take irrecoverably. There is no IndexedDB persistence and no recovery path.
3. **Upload is all-or-nothing through the app server.** One `fetch` POST of the whole blob; a network blip at 99% loses everything except a manual download button. The server buffers to a temp file then re-uploads to Cloudinary — double bandwidth, double failure surface, and the server dies on large files.
4. **Recorder state is implicit.** `recording`, `recState`, `isRecording`, `limitReached`, `mediaRecorder.state`, and `opts` live in different contexts (recorder window, popup, service worker, `chrome.storage`) with no single owner and no defined transitions. Every pause/stop/cancel/restart race traces here.
5. **No durable job system.** Transcription/AI runs as fire-and-forget promises (`autoProcessRecording`) or inside HTTP requests (trim/compose can run for minutes). A server restart silently kills work; nothing has a status, a retry, or an idempotency guarantee.

The full ranked list of 20 problems and 20 reliability risks is in `01-CURRENT-CODEBASE-AUDIT.md` §9 and the final report.

## 4. Target architecture (one paragraph)

PostgreSQL is the single source of truth for all application state (users, recordings, upload sessions, assets, jobs, comments, usage). S3-compatible object storage (recommended: **Cloudflare R2**) holds media bytes only. The client records through an **explicit state machine**, persists every chunk to **IndexedDB** as it is produced, and uploads via **resumable multipart direct-to-storage** using presigned part URLs — the API server never touches video bytes. **Redis + BullMQ** workers run FFprobe verification, FFmpeg transcoding (MP4 + HLS), thumbnails, transcription, and AI as idempotent, retryable jobs with explicit statuses. Source video is immutable; edits render new derived assets. Playback uses short-lived signed URLs. Full detail: `02-ARCHITECTURE.md`.

## 5. Most important decisions (made in this package)

| Decision | Choice | Where argued |
|---|---|---|
| Database | PostgreSQL (+ Drizzle ORM) | `07-DATABASE-DESIGN.md`, §Phase-6 comparisons in `02-ARCHITECTURE.md` §10 |
| Object storage | Cloudflare R2 (S3 API, zero egress) | `02-ARCHITECTURE.md` §10.1 |
| Upload protocol | S3 multipart with presigned part URLs, app-managed `upload_sessions` | `06-UPLOAD-PROTOCOL.md` |
| Queue | BullMQ on Redis | `10-JOBS-AND-QUEUES.md` |
| Recorder state | Explicit finite state machine (hand-rolled, XState-compatible design) | `03-RECORDING-ENGINE-SPECIFICATION.md` |
| Local durability | IndexedDB in the recorder document, chunk-per-row | `05-LOCAL-RECOVERY-INDEXEDDB.md` |
| Delivery | MP4 (H.264/AAC) always; HLS for recordings > 5 min | `09-MEDIA-PROCESSING.md`, `11-WATCH-PLAYER.md` |
| Playback auth | Short-lived signed URLs (HMAC), never public bucket reads for private videos | `12-SHARING-PRIVACY-AUTHORIZATION.md` |
| Migration | Strangler-fig, 15 phases, no big-bang rewrite | `23-MIGRATION-PLAN.md` |

## 6. Recommended technology stack

- **API server:** Node 20+, TypeScript, Express (or Fastify) — keep Node to reuse domain logic (`plans.js`/`entitlements.js`/`permissions.service.js` port almost verbatim).
- **DB:** PostgreSQL 16, Drizzle ORM, `node-pg` pool, migrations via `drizzle-kit`.
- **Queue:** Redis 7 + BullMQ; workers as separate Node processes (same repo, `worker/` entrypoint).
- **Storage:** Cloudflare R2 via `@aws-sdk/client-s3` (S3-compatible; swapping to S3/B2 is a config change behind a storage abstraction).
- **Media:** FFmpeg/FFprobe in the worker image (already in the current Dockerfile lineage).
- **Frontend:** keep React 18 + Vite; add TypeScript incrementally.
- **Extension:** keep MV3 vanilla JS or move to TypeScript + esbuild; keep the existing UX components.
- **Transcription/AI:** keep Groq (Whisper large-v3 + gpt-oss) with the existing VAD pipeline, moved into workers.
- **Billing:** keep Paddle; add webhook event dedup + `billing_events` table.
- **Observability:** pino structured logs, request/recording/upload/job IDs, Prometheus metrics or a hosted equivalent, Sentry for errors.

## 7. Rebuild strategy

**Do not rewrite from scratch.** The migration plan (`23-MIGRATION-PLAN.md`) is a strangler-fig sequence: freeze features → stand up Postgres and dual-write → storage abstraction → new upload path (biggest reliability win) → IndexedDB recovery → recorder state machine → queue + workers → processing → watch page → everything else → delete legacy. Each phase ships independently and is reversible.

**Implementation order** (also `24-IMPLEMENTATION-PLAN.md`):

1. Postgres schema + repositories (recordings metadata first — kills the Cloudinary-as-DB problem).
2. Storage abstraction + R2 buckets.
3. Upload sessions + multipart direct upload (extension + web).
4. IndexedDB chunk persistence + crash recovery in the recorder.
5. Recorder state machine (behind the existing UI).
6. Redis/BullMQ + probe/transcode/thumbnail workers.
7. Watch page against `video_assets` with processing states.
8. Migrate sharing, comments, analytics, folders reads to Postgres.
9. Transcription/AI as jobs.
10. Editor → `edit_sessions` + render jobs.
11. Billing hardening (webhook dedup, `billing_events`).
12. Decommission Cloudinary-as-DB and JSON files.

## 8. Critical risks

1. **Data migration** from Cloudinary context/JSON files into Postgres — mitigated by a reconciliation importer and a dual-read window (Phase 1 of `23-MIGRATION-PLAN.md`).
2. **Extension review lag** (Chrome Web Store) — recorder changes must be backward-compatible with the deployed API for at least one version window; version the API (`/api/v1`).
3. **Recorder regressions** — the single highest-value user flow. Mitigated by the recorder test matrix (`20-TESTING-STRATEGY.md` §9) and by building the state machine behind the current UI before switching defaults.
4. **In-flight recordings during cutover** — upload protocol v1 and v2 must coexist; old extension versions keep working until forcibly updated.
5. **Cost** — R2 + Railway/worker compute vs. current Cloudinary free tier; modeled in `02-ARCHITECTURE.md` §10.
6. **Single developer bandwidth** — phases are deliberately small; every phase has acceptance criteria so partial progress is still shippable.

## 9. What NOT to touch until the core recorder is stable

Per the final report (and `23-MIGRATION-PLAN.md` Phase 0): the editor, AI features, billing internals, admin panel, Gmail/Slack integrations, and the marketing pages are **frozen** until Phases 1–7 (Postgres, upload, recovery, state machine, queue, processing, watch) are done. They work today; churn there multiplies migration surface.

---

*Every document in this package cites real files/lines from the existing repo. When the documentation and the code disagree, the documentation wins — update the code, or update the doc in the same change (see `26-CLAUDE-CODE-IMPLEMENTATION-RULES.md`).*
