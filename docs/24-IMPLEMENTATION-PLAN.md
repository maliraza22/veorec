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

**T-002 · Structured logging on legacy server** — ✅ DONE (2026-09-01). `server/log.js` (pino 10 + pino-http 11 + optional @sentry/node 10) wired into `server/index.js` top-level only: X-Request-Id in/out (inbound accepted only when it matches `^[A-Za-z0-9._-]{6,64}$`, else `req_<uuid>` generated), one structured completion line per request (`request_id`, allowlisted `req{method,url-sans-query}`, `res.status`, `responseTime`), error middleware captures to Sentry with request-id tags, `uncaughtExceptionMonitor` observes fatals without changing crash semantics (Sentry's OnUnhandledRejection pinned to `mode:'strict'` for the same reason). JSON logs in production, pino-pretty in dev. Env (all optional): `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, `LOG_LEVEL`, `LOG_PRETTY`. Tests: `tests/observability.test.js` (26 assertions incl. redaction + behavior-preservation; `npm test` in server/ runs both suites). **Scope decision:** client-side Sentry deferred out of T-002 (server-only instrumentation per approval) → folded into T-802 watch-page work. **Legacy quirk documented, deliberately preserved:** malformed JSON bodies answer `500 {"error":"Server error"}` (not 400) — fixed only by the `/api/v1` error contract (`08` §2), not here. Accept met: every request logs one line with request_id; unhandled errors reach Sentry when configured.

**T-003 · Baseline KPI capture** — ✅ DONE (2026-09-01, instrumentation; 7-day number collection pending production deploy). `server/kpi.js` (injectable-logger module) + 13 insertions in `server/index.js`: `upload_started`/`upload_finished` (outcome success|rejected_limit|error + code + sizeBytes + durationMs + store) on both upload handlers and the error middleware (multer-level failures imply attempts), `watch_404_retry`/`watch_recovered_after_404` (Cloudinary index-lag measurement keyed by recording id, 5-min window), 15-min `kpi_snapshot` aggregates (successRatePct excl. policy rejections, acceptRatePct incl., inFlightOrLost, p50/p95). Event schema, calculation rules, comparison method, and limitations recorded in `docs/BASELINE.md` §Baseline KPIs, with the 7-day pre-cutover table to fill from production logs before Phase 3. Tests: `tests/kpi.test.js` (29 assertions, unit + integration). Accept: instrumentation verified; **remaining acceptance item — fill the 7-day table from production before the Phase-3 cutover.**

## Phase 1 — PostgreSQL

**T-101 · DB scaffolding** — ✅ DONE (2026-09-01). `db/` package (`@veorec/db`): `env.js` (APP_ENV local|test|staging|production, defaults for local/test only, staging/production require explicit `DATABASE_URL`, destructive guard always refusing production, credential redaction), `pool.js` (pg Pool: timeouts, SSL, shared pool), `client.js` (Drizzle), `migration-state.js`, CLIs `db:migrate`/`db:status`/`db:reset`/`db:generate`; `migrations/0000_foundation.sql` (**no application tables** — `citext` + `set_updated_at()` only, so T-102 is a pure table diff) + journal; root `docker-compose.yml` (Postgres 16, Redis 7, MinIO, MailHog on non-default ports 5433/6380/9100/1025) and `.env.example`; `db/README.md`. Migration policy: forward-only, tracked, idempotent; `drizzle-kit push` never used; no down-migrations (rollback = corrective forward migration; `db:reset` is the local/test-only teardown) — rationale in `07` §14. Tests: `tests/db.test.js` (34 assertions: env guards, clean-DB migrate, idempotency, reset/re-migrate, citext/trigger existence, constraint conventions incl. FK cascade + CHECK + NOT NULL, teardown; skips loudly without infrastructure, `DB_TESTS_REQUIRED=1` enforces in CI). Accept met: `db:migrate` verified green against live PostgreSQL 16.15. **Deliberately NOT done:** no schema tables, no dual-write, no application code reads Postgres.

**T-102 · Schema migration 0001** — ✅ DONE (2026-09-01). All 30 tables from `07` §2–§10 as `migrations/0001_application_schema.sql` (46 FKs, 52 CHECKs, 58 indexes, `updated_at` triggers on 19 tables), with Drizzle definitions in `db/src/schema/` (identity, jobs, recordings, uploads, engagement, transcripts, editing, billing, misc). **Storage-provider-neutral**: media addressed only by `video_assets.storage_key`; no Cloudinary columns anywhere (asserted by test) — legacy identifiers get an isolated, migration-only `legacy_media_map` table in T-104, dropped in Phase 14 (`07` §13). Quota model represented: `usage` ledger (retained/reserved/pending-deletion/active-count/reserved-slots, all CHECK ≥ 0), `storage_reservations` (one open per upload session, upload-XOR-render), `upload_sessions.byte_ceiling`, `video_assets.counts_toward_quota`. Tests: `tests/schema.test.js` (46 assertions: schema parity vs Drizzle definitions, ER parity vs `07` §12, provider neutrality, UNIQUE/CHECK/FK/NOT NULL behaviour, cascade & set-null deletion, trigger). Accept met: clean-database migration verified; introspected FK graph matches the documented ER diagram. **Deliberately NOT done:** no repositories, no importer, no dual-write, no application reads/writes, no quota enforcement logic (T-306), no R2/Cloudinary work.

**T-103 · Repository layer** — ✅ DONE (2026-09-01). 18 repositories in `db/src/repositories/` (users, sessions, recordings, folders, assets, uploads, usage, shareLinks, comments, reactions, viewSessions, leads, analytics, transcripts, jobs, subscriptions, billingEvents, audit) behind `createRepositories(db)` / `repositories()` / `withTransaction(fn)`. **Scope-required**: owned-data methods take `{userId}` first and apply the ownership predicate in SQL (join-enforced for child rows); the unscoped surface is limited to explicitly named `*ForPublicWatch` / `*System` / `*AsAdmin`, the latter two requiring a stated reason. Field whitelists stop owners writing lifecycle/verified-media/ownership columns (invariant #11). **Transactions**: one executor bound per repo set; `usage.getForUpdate` refuses to run outside a transaction, giving T-306 atomic reservation without bypassing the layer. **Errors**: NotFound/Conflict/ConstraintViolation/InvalidState/Database with `retryable`, mapped from SQLSTATE through drizzle's wrapper — no raw pg errors escape, no HTTP concepts enter. Tests: `tests/repositories.test.js` (93 assertions incl. cross-user prevention on every owned entity, transaction commit/rollback, a two-transaction race proving exactly one reservation is granted, idempotent enqueue/webhook ledger, monotonic watch progress, timestamps). Docs: `07` §15. **Deliberately NOT done:** no application code uses it, no dual-write, no importer, no quota algorithm, no StorageProvider/R2, no Cloudinary changes.

**T-104 · Importer** — ✅ DONE (2026-09-01, code + fixtures; production dry-run still pending an operator with volume + credentials access). `db/src/migration/` (not `apps/api/…` — that app does not exist yet): `sources.js` (read-only readers, malformed JSON throws), `importer.js` (phased, FK-ordered, Drizzle-builder writes), `report.js` (per-entity source/imported/already/skipped/conflict/orphan/unmappedMedia/failed + problem list), `legacy-store.js` (transitional `legacy` schema), `export-legacy-media.js` (the **only** Cloudinary-touching file; resolves the SDK from the legacy server so `db/` declares no Cloudinary dependency), CLI `db:import` (**dry run by default**, `--apply` to write, exit 2 on problems, exit 3 if a legacy source changed). Migration `0002_legacy_migration_schema` adds `legacy.media_map` / `import_checkpoints` / `import_runs` in a **separate `legacy` schema** (invisible to drizzle-kit via `schemaFilter`, removed by one `DROP SCHEMA legacy CASCADE` in Phase 14). Idempotent via deterministic ids + ON CONFLICT, checkpoints for append-only logs; resume = re-run. No `video_assets` rows are created — media stays outside R2 until T-204. Tests: `tests/importer.test.js` (63 assertions covering the full required matrix). Docs: `07` §16. **Deliberately NOT done:** no runtime migration, no dual-write, no R2/StorageProvider, no Cloudinary removal, no legacy data deleted.

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

**T-306 · Quota ledger & atomic reservation** — New free-plan quota model (`16` §1.1: 50 active videos AND 5 GiB retained, whichever first). Ledger columns on `usage` (retained/reserved/pending-deletion/active-count/reserved-slots) + `storage_reservations`; guarded-UPDATE check-and-reserve (`reserve = min(max_upload_bytes, available)`, floor `min_start_bytes`) wired into upload-session creation; **per-recording byte ceiling enforced at three layers** (recorder auto-stop, Content-Length-signed presigns + cumulative refusal, exact completion check — `16` §4.3a); reconciliation at complete; release on abort/expiry; soft-delete frees quota; `counts_toward_quota` on assets; dual-meter `/me/usage`; plan catalog updated to the `16` §1.1 integers; grandfathering flag for over-quota legacy users (`23` Phase 3). Deps: T-301, T-302. Tests: Q1–Q17 (`20` §7.1). Accept: Q-suite green incl. 50-parallel-session race; ledger drift 0 after usage_sync on seeded data.

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
