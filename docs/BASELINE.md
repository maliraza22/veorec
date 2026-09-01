# BASELINE — Verified state before migration (T-001)

> Captured 2026-09-01 on the developer machine (Windows 11 Pro), repo `C:\Users\DELL\ScreenRecorder`, branch `main` @ `ab972bb`, working tree clean. Anything listed under "Baseline failures/warnings" predates the migration — do not attribute it to later changes.

## Environment

| Item | Value |
|---|---|
| OS | Windows 11 Pro 10.0.26200 (dev shell: Git Bash / PowerShell) |
| Node (installed) | v24.15.0 |
| Node (declared) | `server/.node-version` = 20; `server/package.json` engines `>=18`; production Docker image `node:20-bookworm-slim` |
| npm | 11.12.1 |
| Package manager | npm (package-lock.json in `client/` and `server/`; no workspaces, no root package.json) |
| Git remote | `origin = https://github.com/codingclicks-sketch/screenrec.git` |

**Note:** local Node 24 is ahead of the declared Node 20. Everything passes under 24, but production parity checks should use Node 20 (Docker).

## Commands & results (all run 2026-09-01)

| Purpose | Command | Result |
|---|---|---|
| Existing tests | `node tests/fixwebm.test.js` | ✅ **21 passed, 0 failed** (exit 0) |
| Server syntax | `node --check server/*.js` (each file) | ✅ all pass |
| Extension syntax | `node --check extension/*.js extension/make-icons.cjs` | ✅ all pass |
| Frontend build | `cd client && npm run build` (vite build) | ✅ built in 7.43s → `dist/` (index.html 0.71 kB, css 125.15 kB, js 413.82 kB) |
| Backend build | — (no build step; CommonJS run directly) | N/A |
| Backend boot smoke | `cd server && node index.js` (6s, then killed) | ✅ prints `Server :3001 | Cloudinary: false` — boots in local/no-Cloudinary mode without any env vars |
| Extension build | — (no build step; store zips made by hand) | N/A |
| Typecheck | — | **Not configured** (no TypeScript, no tsconfig anywhere) |
| Lint | — | **Not configured** (no eslint config anywhere) |

> **Note (T-101):** local infrastructure and database commands were added after this baseline — `docker compose up -d` at the repo root and `cd db && npm run db:migrate|db:status|db:reset|test`. See `07` §14 and `db/README.md`. The legacy commands below are unchanged.

### Canonical commands (as of baseline)

- Frontend dev: `cd client && npm run dev` (vite, proxies `/api` + `/uploads` → localhost:3001)
- Frontend build: `cd client && npm run build`
- Backend dev: `cd server && npm run dev` (nodemon) · start: `npm start`
- Tests: `node tests/fixwebm.test.js` (the only test in the repo)
- Extension: load `extension/` unpacked; no build/test commands exist

## Baseline failures

**None.** Test suite, syntax checks, client build, and server boot all pass before any migration change.

## Baseline warnings (pre-existing)

1. `vite build`: "The CJS build of Vite's Node API is deprecated" (Vite 5.4.21). Cosmetic; will disappear with any future Vite/ESM config touch — do not fix out-of-band.
2. Server boots with **zero** required env vars in local mode (falls back to dev JWT secret, local `uploads/` disk storage, `recordings.json`). Deployed mode requires the env set documented in `01` §8; there is no env validation at boot except `JWT_SECRET` (deployed only).
3. Node 24 vs declared Node 20 mismatch (above).
4. Running the server locally uses the **local-mode** code fork (`USE_CLOUDINARY=false`), which is a different code path from production (`01` §2.3) — local green does not fully exercise production paths.

## Environment assumptions for future tasks

- Production: API on Railway (Dockerfile, Node 20, whisper.cpp + ffmpeg baked in), client on Vercel, media on Cloudinary, JSON data on Railway volume `DATA_DIR`. *(Target hosting moves to a provider-agnostic VPS + R2 — `02` §6 — from Phase 2 onward; the legacy deployment is untouched so far.)*
- No CI exists; all checks above are manual. (CI introduction is part of later tasks, not baseline.)
- **Production legacy data is not available on this machine** (verified 2026-09-01 during T-104): no Cloudinary credentials in the environment and no copy of the Railway `DATA_DIR` volume. The importer is therefore fixture-tested here; its production dry run must be executed by an operator who has both, and its report attached to the Phase-1 record.
- **Local dev machine has no Docker and no native PostgreSQL** (verified 2026-09-01). T-101's Docker Compose stack is therefore authored-and-reviewed but *unexecuted* here; its migrations were verified against PostgreSQL 16.15 running in WSL2 Ubuntu (same version/port/credentials as the compose service). Docker Compose itself still needs a one-time verification on a machine that has Docker — tracked as a T-102 pre-flight step.
- `ffmpeg`/`ffprobe` are NOT on the dev machine PATH by assumption — transcription features are exercised only in Docker.

## Git status

- Before T-001: branch `main` @ `ab972bb`, clean tree.
- Tracked release artifacts found: 10 zips `veorec-extension-v1.0.0.zip` … `v1.7.3.zip` (added in `65ed657`, predating the `.gitignore` rules). **Untracked by T-001** (`git rm --cached`; files remain on disk, ignored).
- **Security verification:** `extension.pem` and all `.crx` files were **never committed** — `git log --all -- "*.pem"` / `-- "*.crx"` return empty. The signing key has not leaked via git; no rotation forced (docs `17` §9 corrected accordingly).
- T-001 work is on branch `migration/t-001-baseline`.

## Baseline KPIs (instrumented by T-003 — `server/kpi.js`)

### What is captured and how

All KPI data is **log-derived**: structured pino events (T-002 foundation) correlated by `request_id`, plus a periodic in-memory aggregate. No new endpoints, no behavior change, no personal data (only outcome classes, byte sizes, durations, recording ids).

| Event (`kpi` field) | Emitted where | Fields | Meaning |
|---|---|---|---|
| `upload_started` | both `/api/upload` handler entries | `store: local\|cloudinary`, `sizeBytes` | one upload attempt |
| `upload_finished` | every handler exit path + error middleware | `outcome: success\|rejected_limit\|error`, `code` (`recording_limit`/`video_limit`/`storage_limit`/`file_too_large`/`cloudinary_error`/`unhandled`), `sizeBytes`, `durationMs`, `store` | attempt resolution |
| `watch_404_retry` | `GET /api/watch/:id` on a repeat 404 of the same id | `recordingId`, `attempt`, `sinceFirstMs` | the client's 6×1.5s retry loop hitting Cloudinary index lag |
| `watch_recovered_after_404` | watch hit ≤ 5 min after misses of that id | `recordingId`, `retries`, `waitedMs` | **how long index lag lasted** — the metric migration should drive to ~0 |
| `kpi_snapshot` | every 15 min (in-process timer) | `counters{…}`, `upload{successRatePct, acceptRatePct, inFlightOrLost, durationMsP50/P95, durationSamples}`, `uptimeSec` | rolling aggregate since boot |

### How the KPIs are calculated

- **Upload attempts** = count of `upload_started` (+ implied attempts for multer-level failures that never reach the handler).
- **Upload success rate (reliability)** = `success / (success + error)` — plan/policy rejections (`rejected_limit`) are excluded from reliability but reported separately as **accept rate** = `success / (success + error + rejected_limit)`.
- **Upload duration**: `durationMs` on `upload_finished` covers handler entry → response (i.e. the server→Cloudinary phase; multer has already received the client body). **Total** request duration including client transfer = `responseTime` on the T-002 completion line for `req.url="/api/upload"`. Use both when comparing against the migrated direct-to-R2 path.
- **Watch 404/lag**: per-event lines above; totals also derivable from completion lines (`/api/watch/<id>` + status). `inFlightOrLost` in snapshots (started − finished) signals hung/crashed uploads.

### How to compare after migration

For each production day, aggregate from logs: attempts, successRatePct, acceptRatePct, p50/p95 durations (both handler-scoped and responseTime), count of `watch_404_retry` and `watch_recovered_after_404` (+ median `waitedMs`), `unhandledError`. The migrated pipeline (Phases 3–8) must beat: success rate (target ≥ 99%), time-to-playable (legacy proxy: upload responseTime + observed index lag `waitedMs`), and drive `watch_404_retry` to ~0 (Postgres reads have no index lag). Record 7 days of pre-cutover numbers in the table below before Phase 3 ships.

| Day | Attempts | Success % | Accept % | p50/p95 ms (handler) | 404-retries | Recovered (median waitedMs) | Unhandled |
|---|---|---|---|---|---|---|---|
| *(fill from production logs)* | | | | | | | |

### Limitations of the legacy baseline

1. Counters/snapshots are in-memory — reset on every deploy/restart (per-event lines are the durable record; snapshots are conveniences).
2. `durationMs` excludes the client→server transfer (use `responseTime` for totals); neither captures the client-side blob-assembly time before the request starts.
3. Watch "hit/miss" is server-side only — a viewer who gave up before a retry isn't distinguishable from one who succeeded later on another id.
4. Local-mode (`store:'local'`) numbers from dev machines must be filtered out (`store` field) when computing the production baseline.
5. No persistence/dashboarding — analysis is grep/jq over Railway logs until the migration's metrics stack (docs/19) exists.
