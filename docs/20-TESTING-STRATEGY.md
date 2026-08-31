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

### 7.1 Quota & concurrency tests (release gate for the quota model, `16` §4)

| # | Scenario | Expected |
|---|---|---|
| Q1 | Two simultaneous upload-session creations, one reservation of quota left | exactly one succeeds; the other gets 403 `storage_limit` with correct meta; `usage` row never over-reserved (assert with 50 parallel attempts too) |
| Q2 | Multiple browser tabs recording concurrently (within quota) | independent sessions, independent reservations; ledger sums correctly |
| Q3 | Two simultaneous recordings by the same user near the 50-video cap (49 active) | one slot reserved, second gets `video_limit` |
| Q4 | Retrying session creation with the same Idempotency-Key | same session returned, reservation taken **once** |
| Q5 | Duplicate upload completion (double POST complete) | canonical replay; retained bytes and video count incremented exactly once |
| Q6 | Abandoned upload (no parts, tab closed) | expiry job releases reservation + slot; quota back to pre-session values |
| Q7 | Failed upload (abort mid-parts) | reservation released once; re-abort idempotent |
| Q8 | Partial upload then resume then complete | reconciliation uses the real HEAD size, not part-sum drift or client claims |
| Q9 | User deletes a video while another upload is in flight | both txs serialize on the usage row; final ledger = −deleted +uploaded; no deadlock, no negative counters (CHECK constraints) |
| Q10 | Processing failure after complete (probe_invalid) | retained bytes stay (source exists) until the recording is deleted/purged; status failed doesn't corrupt ledger; reprocess doesn't double-count |
| Q11 | Storage reconciliation (`usage_sync`) after injected drift | re-derived values match asset aggregates; drift logged |
| Q12 | Server restart between reservation and first part | reservation row survives; recovery resumes or expiry releases — never leaks |
| Q13 | Worker failure during processing (kill mid-transcode) | retry converges; `counts_toward_quota` assets counted once |
| Q14 | Upload exceeding its reservation (hostile client, manifest > reserved ×1.05) | 422 `upload_manifest_invalid`; no ledger change |
| Q15 | Soft-delete → quota freed immediately; hard purge after 30 d → pending_deletion drained | dual-meter endpoint reflects each step |
| Q16 | Free user at 4.7/5 GB, reservation 330 MB, two tabs | matches the spec example: first reserves, second blocked; no state where both proceed |

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
