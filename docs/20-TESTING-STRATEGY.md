# 20 — Testing Strategy

> From one test file (`tests/fixwebm.test.js`) to a strategy where **every production feature has failure-path tests** (invariant #18). Tooling: Vitest (unit/integration), Playwright (browser/E2E/extension), Testcontainers or docker-compose services (Postgres/Redis/MinIO) for integration.

---

## 1. Test pyramid & placement

| Layer | Tooling | Runs | Scope |
|---|---|---|---|
| Unit | Vitest | every commit, <60s | pure logic: entitlements, plans, authz, upload manifest validation, state machine, VAD chunking math, webm patcher (existing test migrates) |
| Integration (API) | Vitest + supertest + real Postgres/Redis/MinIO | every commit | routes ↔ DB ↔ storage-mock behaviors, tx correctness, idempotency |
| Worker integration | Vitest + real ffmpeg + fixture videos | every commit (small fixtures) | probe/transcode/thumbnail/render correctness |
| Browser (recorder) | Playwright + Chrome w/ fake media flags | CI nightly + pre-release | recorder machine against real MediaRecorder/getDisplayMedia fakes |
| E2E | Playwright against full docker-compose stack | nightly + pre-release | record→upload→process→watch happy + failure paths |
| Load / failure injection | k6 + chaos scripts | pre-release, on demand | §10–11 |

CI gates: unit+integration green to merge; browser/E2E green to release; recorder matrix (§9) green to ship any recorder/upload change.

## 2. Unit test priorities

- **RecorderMachine**: every transition in `03` §2 + every ignored-event case; disposer registry emptiness on idle; limit enforcement (encoder-clock and wall-clock paths); pause accounting math.
- **Uploader**: part sealing at boundaries, retry/backoff classification (each transient/terminal branch of `18` §5), resume diff logic (server-has/local-has matrices from `06` §10).
- **Entitlements/permissions**: port the semantics as table-driven tests (comp expiry, past_due grace, canceled-with-period-end fix from `16` §2, every gate).
- **Authz matrix**: `authorize()` against the `12` §2 table.
- **Upload manifest validation**, **billing event application** (ordering guard, duplicate skip), **plan override whitelist**, **fixWebmDuration** (existing tests kept + Cues-refusal cases).

## 3. API integration tests

For each endpoint (from `08`): happy path, authz failure (non-owner 404), validation failure, and its **specific** failure contracts:
- upload complete: idempotent replay returns canonical result; manifest mismatch 422; limit rejection 403 with grace-record created; crash-simulation between S3-complete and DB-commit (inject) → retry converges.
- webhook: duplicate event 200-skip; out-of-order skipped; processing exception → 500 + failed row; signature invalid → 401.
- delete recording: usage decremented in same tx; watch immediately 404; assets purged by cleanup job run.
- meta gates: password/leadCapture/branding without Pro → 403 `feature_locked` + paywall event row.

## 4. Recorder tests (browser)

Playwright with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` + a test harness page hosting the recorder bundle (the machine + capture + durability are importable modules, not welded to recorder.html). `fake-indexeddb` for unit level; real IndexedDB in Playwright.

## 5. Extension tests

Playwright `chromium.launchPersistentContext` with `--load-extension`: popup opens recorder window; overlay injects and re-injects across tab switch/navigation; bridge token sync both directions; typed messages reach the machine; storage projection updates.

## 6. Database & authorization tests

Migration up/down on empty + seeded DBs; JSON/Cloudinary importer idempotency (run twice = same rows); cross-tenant enumeration (every owner route × other-user token → 404); soft-delete visibility.

## 7. Upload protocol tests (integration, MinIO)

Part upload/re-upload idempotency; presign expiry re-mint; abort; expiry job aborts multipart; single-file mode; complete with storage-side ListParts disagreement (server adopts storage view); checksum mismatch rejected by storage → uploader retries.

## 8. Processing/worker tests

Fixture library: 5s webm (vp9/opus), webm w/o duration header, video-only webm, corrupt file, 0-byte, mp4 upload, 1080p+ file, mixed-language audio sample. Assert: probe facts; transcode output probes valid (+faststart present via `ffprobe -show_format`); thumbnail non-black; hls playlist integrity; render concat duration ±2%; **idempotency**: run each job twice, assert single asset row set and identical state; **crash**: kill worker mid-transcode, re-run, converges.

## 9. Recorder test matrix (release gate)

| # | Scenario | Expected |
|---|---|---|
| R1 | screen + mic, 30s, stop | ready video, audio present, duration 30±2s (probed) |
| R2 | tab mode + tab audio + mic | both audio sources mixed; tab still audible locally |
| R3 | window mode (no system audio) | warning shown; mic-only audio |
| R4 | camera-only | 720p cam video |
| R5 | screen + camera bubble on captured tab | bubble visible in recording |
| R6 | bubble + different-surface share | `bubble_not_captured` warning |
| R7 | mic permission denied | explicit choice UI; "continue muted" yields silent-but-valid file |
| R8 | picker cancelled | back to start, no orphan session |
| R9 | pause 10s mid-recording | duration excludes pause ±1s |
| R10 | stop via browser "Stop sharing" bar | normal finalize + upload |
| R11 | plan limit reached | auto-stop, upload accepted (grace), UI notice |
| R12 | kill recorder window at 10s | relaunch → recovery card → resume → playable video ≥ 9s |
| R13 | kill browser during post-stop upload | recovery resumes; zero re-upload of completed parts (assert via server part timestamps) |
| R14 | network offline during recording; online after stop | upload completes |
| R15 | network flaps during upload | retries; completes; no duplicate parts |
| R16 | token expired mid-upload | pause + re-auth + resume |
| R17 | cancel / restart | no upload; no orphan local session; restart records fresh take |
| R18 | 45-min recording (Pro) | memory flat (< 300MB renderer), upload streams during recording |
| R19 | second recorder window while recording | refused |
| R20 | mic unplugged mid-recording | continues; `mic_lost` warning; file valid |
| R21 | device sleep/resume mid-recording | recording stops or recovers; no corrupt upload (probe passes or recovery offered) |
| R22 | extension reload mid-recording | next launch recovers captured portion |

## 10. Failure injection (chaos, staging)

Scripted: kill worker during each job type; kill API during upload complete; drop Redis; revoke R2 credentials temporarily; inject 429s from a Groq mock; corrupt a source object then reprocess. Assert: no lost recordings, no duplicate assets, alerts fired, admin triage shows failures.

## 11. Load tests (k6)

Upload path: 50 concurrent multipart sessions (presign RPS, part-record RPS); watch path: 500 RPS mixed watch/media/engagement; webhook burst replay (1000 duplicate events → 1 applied). Targets from `19` §7.

## 12. E2E happy-path suite (nightly)

signup → record (fake media) → auto-title appears → watch → comment/react from second anonymous context → analytics reflects → trim (virtual) → render copy → share link with password + expiry → gate works → delete → purge job. Billing E2E against Paddle sandbox: checkout → webhook → entitlements flip → cancel → period-end drop.
