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

- Production: API on Railway (Dockerfile, Node 20, whisper.cpp + ffmpeg baked in), client on Vercel, media on Cloudinary, JSON data on Railway volume `DATA_DIR`.
- No CI exists; all checks above are manual. (CI introduction is part of later tasks, not baseline.)
- `ffmpeg`/`ffprobe` are NOT on the dev machine PATH by assumption — transcription features are exercised only in Docker.

## Git status

- Before T-001: branch `main` @ `ab972bb`, clean tree.
- Tracked release artifacts found: 10 zips `veorec-extension-v1.0.0.zip` … `v1.7.3.zip` (added in `65ed657`, predating the `.gitignore` rules). **Untracked by T-001** (`git rm --cached`; files remain on disk, ignored).
- **Security verification:** `extension.pem` and all `.crx` files were **never committed** — `git log --all -- "*.pem"` / `-- "*.crx"` return empty. The signing key has not leaked via git; no rotation forced (docs `17` §9 corrected accordingly).
- T-001 work is on branch `migration/t-001-baseline`.

## Baseline KPIs

Runtime KPIs (upload success rate, watch 404-retries) require production log instrumentation and are deferred to **T-002/T-003** as planned — nothing is instrumented at baseline beyond `console.log`.
