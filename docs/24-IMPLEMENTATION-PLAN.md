# 24 — Implementation Plan

> The migration plan (`23`) broken into small, sequential tasks an engineer (or Claude Code session) can execute one at a time. Task format: **ID · Title** — Objective / Deps / Files / Details / Tests / Acceptance. IDs are stable; reference them in commits (`T-103: ...`). Do not start a task whose deps aren't merged.

Repo layout target (created incrementally):
```
/apps/api  /apps/worker  /apps/web (moved client/)  /apps/extension (moved extension/)
/packages/shared (types, error codes, plan catalog)  /db (drizzle schema + migrations)
/docs  /tests
```

---

## Phase 0 — Freeze & baseline

**T-001 · Repo hygiene & secrets** — ✅ DONE (2026-09-01). Untracked the 10 stale release zips (≤v1.7.3); verified `extension.pem`/`.crx` were never in git history (no rotation needed); imported the `docs/` package into the repo (canonical copy) + root `README.md`; established the verified baseline in `docs/BASELINE.md`. Accept met: `git ls-files` clean of `.zip/.crx/.pem`.

**T-002 · Structured logging on legacy server** — pino + request-id middleware wrapping existing routes (no behavior change); error tracking (Sentry) on server + client. Files: `server/index.js` (top-level only), `server/log.js`. Accept: every request logs one line with `request_id`; unhandled errors reach Sentry.

**T-003 · Baseline KPI capture** — Count upload attempts/success (log-derived), watch 404-retry occurrences. Files: `server/index.js` counters. Accept: 7 days of baseline numbers recorded in `docs/baseline.md`.

## Phase 1 — PostgreSQL

**T-101 · DB scaffolding** — drizzle + pg pool + migration runner + docker-compose (postgres, redis, minio, mailhog). Files: `/db`, `docker-compose.yml`, `.env.example`. Tests: migration up/down empty DB. Accept: `npm run db:migrate` green locally & on Railway Postgres.

**T-102 · Schema migration 0001** — All tables from `07` (including workspaces, jobs, billing_events — empty is fine). Deps: T-101. Tests: schema snapshot test; FK/constraint assertions. Accept: `07` §12 ER diagram matches introspection.

**T-103 · Repository layer** — Typed repos (users, sessions, recordings, assets, uploads, folders, engagement, transcripts, subscriptions, usage, billing_events, jobs, audit) with scope-required methods (`17` §12). Deps: T-102. Tests: unit per repo against test DB. Accept: no raw SQL outside repos except analytics module.

**T-104 · Importer** — Idempotent import: users.json, subscriptions.json, usage.json, folders.json, contacts, notif-reads, plan_overrides, upgrade_events → analytics_events; Cloudinary listing + meta.json → recordings/comments/reactions/view_sessions/leads/transcripts (`07` §13). Deps: T-103. Files: `apps/api/src/migration/importer.ts` (CLI). Tests: fixture JSON set; run-twice = same counts. Accept: production dry-run report with row counts + anomalies list.

**T-105 · Dual-write** — Legacy server writes to Postgres repos alongside JSON/Cloudinary for: user CRUD, meta mutations (comments/reactions/views/meta patch), subscriptions, usage, folders, contacts. Deps: T-104. Files: `server/index.js` (+repo import), guarded by `PG_DUAL_WRITE=true`. Tests: integration: legacy endpoint call → both stores updated. Accept: 7-day reconciliation report at ~0 diffs (importer heals drift nightly).

**T-106 · Reconciliation report job** — Nightly diff (counts + sampled rows) legacy vs Postgres, logged + emailed. Deps: T-105. Accept: report visible; diffs trending to zero.

## Phase 2 — Storage

**T-201 · StorageProvider** — Interface + R2 impl + MinIO-backed tests (put/get/head/delete/presign GET+PUT/multipart lifecycle). Files: `apps/api/src/storage/`. Tests: full contract suite against MinIO. Accept: suite green vs MinIO **and** real R2 (smoke).

**T-202 · Buckets & lifecycle** — Provision R2: private bucket, 48h incomplete-multipart abort, CORS for PUT from extension/web origins. Files: infra notes + `storage/config.ts`. Accept: presigned PUT from a browser origin succeeds; unauthorized GET fails.

**T-203 · Mirror new uploads to R2** — Legacy upload handler streams temp file → `sources/{recId}` after Cloudinary success; asset row recorded. Deps: T-201, T-105. Files: `server/index.js` upload route. Tests: integration upload → R2 object exists, size matches. Accept: 100% of new uploads mirrored for 1 week.

**T-204 · Backfill copier** — Worker script: Cloudinary original → R2 per recording, checklist table, throttled, resumable. Deps: T-203. Accept: 100% of non-deleted recordings have R2 sources; sizes match.

## Phase 3 — Upload system

**T-301 · Upload session endpoints** — POST/GET/DELETE `/api/v1/uploads`, parts presign, part record, complete (full `06` semantics incl. idempotent complete, entitlement-at-complete, outbox probe stub). Deps: T-103, T-201. Tests: `20` §7 suite (idempotency, expiry, conflict, manifest). Accept: suite green; complete tx verified under injected crash.

**T-302 · Recordings CRUD v1** — POST/GET/PATCH/DELETE `/api/v1/recordings` on Postgres (list from DB!). Deps: T-103. Tests: authz matrix, soft delete + usage tx. Accept: dashboard can render from v1 behind a flag.

**T-303 · Extension uploader module** — `uploader.ts`: part buffering, prefetch presign, concurrency (2/4), retry/backoff classifier, resume diff; wired to existing recorder via `dataavailable` hook alongside legacy path, flag `newUpload`. Deps: T-301. Tests: unit (mock fetch) each retry branch; Playwright happy path. Accept: R14/R15 green with flag on.

**T-304 · Cutover flag & telemetry** — Remote config endpoint (`GET /client-config`), per-upload path tag in logs; staged rollout 10→50→100%. Deps: T-303. Accept: ≥99% success on new path over 2 weeks; rollback tested once deliberately.

**T-305 · Web upload path** — Editor "upload clip" + future web uploads via single-PUT mode (`06` §12). Deps: T-301. Accept: editor upload works; memory-multer path marked deprecated.

**T-306 · Quota ledger & atomic reservation** — New free-plan quota model (`16` §1.1: 50 active videos AND 5 GB retained, whichever first). Ledger columns on `usage` (retained/reserved/pending-deletion/active-count/reserved-slots) + `storage_reservations`; guarded-UPDATE check-and-reserve wired into upload-session creation; reconciliation at complete; release on abort/expiry; soft-delete frees quota; `counts_toward_quota` on assets; dual-meter `/me/usage`; plan catalog updated to the `16` §1.1 integers; grandfathering flag for over-quota legacy users (`23` Phase 3). Deps: T-301, T-302. Tests: Q1–Q16 (`20` §7.1). Accept: Q-suite green incl. 50-parallel-session race; ledger drift 0 after usage_sync on seeded data.

**T-307 · Quota UX** — Dual meters (“Storage 4.2 GB / 5 GB”, “Videos 38 / 50”) in dashboard/billing; recorder quota pre-flight block + near-limit warning (`03` §3.0); exact block messages from `16` §4.6; recovery-card quota-blocked options (`05` §6.1.3). Deps: T-306, T-403. Tests: Playwright meter rendering + blocked/warning states. Accept: no single blended percentage anywhere; copy matches spec exactly.

## Phase 4 — Local recovery

**T-401 · RecorderStore (IndexedDB)** — sessions/chunks/parts stores + quota checks + persist() request (`05` §2–5). Tests: fake-indexeddb unit suite incl. ordering + prune. Accept: suite green.

**T-402 · Chunk persistence wiring** — dataavailable → store before uploader; finalize path; delete-after-complete. Deps: T-401, T-303. Tests: Playwright: kill window at 10s → data present. Accept: R12 partial (data survives).

**T-403 · Recovery flow + UI** — Launch scan, heartbeat liveness, server reconciliation (`05` §6), recovery card (resume/download/discard), popup badge; local download uses fixWebmDuration. Deps: T-402. Tests: R12, R13, R16, R22. Accept: matrix rows green; recovery KPI emitting.

## Phase 5 — State machine

**T-501 · RecorderMachine core** — States/transitions/guards/disposers (`03`), pure module w/ injected effects. Tests: exhaustive transition unit tests; disposer-leak assertion. Accept: 100% branch coverage on machine.

**T-502 · CaptureManager** — Acquisition per mode, mixer (+resume safeguards), warnings, device-change handlers (`03` §4,5,9). Deps: T-501. Tests: Playwright fake-media: each mode + mic-denied choice + track-ended. Accept: R1–R11, R20 green.

**T-503 · Recorder UI refactor** — recorder.html renders machine projections; overlay/popup consume `recSession` (legacy keys mirrored); mic-denied choice UI; upload progress UI. Deps: T-501, T-502, T-403. Tests: extension Playwright suite. Accept: full matrix (`20` §9) green; beta-channel soak 2 weeks.

## Phase 6 — Queue

**T-601 · BullMQ infra + outbox** — JobQueue interface, worker app scaffold, processing_jobs outbox relay, graceful shutdown, `/admin/jobs` list+retry. Tests: outbox crash-window test; stalled-job requeue. Accept: enqueue→process→row lifecycle observable.

**T-602 · Maintenance jobs** — usage_sync, subscription_sync, storage_verification, upload_expiry, session purge as repeatables; delete `server/cron.js`. Deps: T-601. Tests: each job idempotent on fixtures. Accept: cron.js gone; jobs visible in admin.

**T-603 · Transcription as job** — Relocate `transcription.js`/`ai.js` into worker; `stt.transcribe` + transcripts tables + status endpoints; API transcribe endpoints → 202. Deps: T-601. Tests: restart-safety (kill worker mid-job); Groq mock w/ 429s; whisper.cpp fallback. Accept: no transcription runs in the API process.

## Phase 7 — Processing

**T-701 · Probe job** — Download, ffprobe, validation, facts write, post-probe entitlement, fan-out (`09` §2). Tests: fixture battery (`20` §8). Accept: corrupt fixture → failed(probe_invalid); valid → facts recorded.

**T-702 · Transcode MP4 + maybe_mark_ready** — `09` §3 + promotion logic. Deps: T-701. Tests: output verification, idempotent re-run, VFR fixture sync check. Accept: uploaded→ready pipeline works end-to-end in staging.

**T-703 · Thumbnails/poster/preview** — `09` §4 incl. play-overlay variant for Gmail. Deps: T-701. Accept: non-black poster on screen-recording fixtures.

**T-704 · Audio extract + captions VTT** — `09` §6–7; captions asset from segments. Deps: T-701, T-603. Accept: watch page `<track>` renders captions.

**T-705 · HLS job** — `09` §5, conditional. Deps: T-702. Accept: hls.js + Safari native playback of a 10-min fixture.

**T-706 · Legacy re-processing backfill** — Queue-fill probe/transcode/thumbnail for all recordings with R2 sources; progress dashboard. Deps: T-702, T-703, T-204. Accept: 100% active recordings have mp4+poster.

## Phase 8 — Watch

**T-801 · Watch/media/status endpoints** — `08` §7 + signed URL minting + privacy enforcement point (media-level). Deps: T-302, T-702. Tests: privacy × endpoint matrix; URL TTL behavior. Accept: no Cloudinary read in watch path (flagged clients).

**T-802 · Watch page refactor** — Decomposition (`11` §4), explicit page states, status polling, URL refresh, keyboard controls, alert() removal; delete 404-retry + 12s hacks (guard legacy). Deps: T-801. Tests: Playwright watch suite incl. processing state + error paths. Accept: Safari + mobile verified; player error rate < 0.5% after rollout.

**T-803 · Dashboard/folders/notifications on v1** — List endpoints on Postgres, notifications queries (`13` §6). Deps: T-302, T-105. Accept: meta.json/Cloudinary reads off for these pages.

## Phase 9–13 (task headlines; expand per phase kickoff)

**T-901** share_links CRUD + gate resolution; **T-902** signed download + audience.download enforcement; **T-903** unlisted default + migration notice.
**T-1001** engagement writes → Postgres only; **T-1002** analytics endpoints + retention decile; **T-1003** paywall events unified.
**T-1101** translation cache; **T-1102** auto-process chain as jobs incl. DEFAULT_TITLES guard; **T-1103** AI status surfaces + retry UI.
**T-1201** edit_sessions/ops endpoints + editor wiring; **T-1202** render job (single-source stream-copy path); **T-1203** multi-source compose render; **T-1204** silence-removal job (audio-based); **T-1205** delete replace/trim/compose legacy handlers (aliases → sessions).
**T-1301** billing_events ledger + webhook rewrite (dup/ordering/500s); **T-1302** sessions-based auth + revocation + bridge compat; **T-1303** subscriptions reads → Postgres only; **T-1304** rate limits → Redis.

## Phase 14

**T-1401** legacy upload route removal (fleet <1% + forced update); **T-1402** delete JSON store modules + Cloudinary SDK + dead client hacks; **T-1403** final import freeze + Cloudinary export & plan cancellation; **T-1404** docs cleanup (remove migration shims from specs).

---

## Ordering summary (critical path)

T-101→T-106 → T-201→T-204 → T-301→T-306 → T-401→T-403 (→ T-307) → T-501→T-503 → T-601→T-603 → T-701→T-706 → T-801→T-803 → then 9–13 in any order → 14.

## Definition of done per task

Code + tests listed + docs updated (if the task changes a contract, the spec doc changes in the same PR — rule from `26`) + observability (new component logs/metrics per `19`) + reviewed against the invariants checklist (`02` §11).
