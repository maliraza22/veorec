# 25 — Definition of Done (Production Release Criteria)

> The rebuilt platform is "production done" only when every box below is checked, with the evidence noted (test id from `20`, KPI from `19`, or manual verification recorded). No box may be checked by assertion alone.

---

## Recording

- [ ] **Screen recording** — monitor capture with system-audio option; matrix R1 green; macOS system-audio limitation messaged (`21` §2)
- [ ] **Tab recording** — pickerless tabCapture, tab audio always captured, tab remains audible locally (R2)
- [ ] **Window recording** — with explicit no-audio warning (R3)
- [ ] **Camera** — camera-only mode (R4); bubble mode with one-time permission iframe (R5) and `bubble_not_captured` warning (R6)
- [ ] **Microphone** — mixed with system/tab audio into one track; denial produces an explicit choice, never a silent mic-less recording (R7)
- [ ] **System audio** — mixer handles present/absent tracks; suspended-AudioContext safeguard verified (silence bug cannot recur)
- [ ] **Pause/resume** — duration excludes paused time ±1s (R9); overlay reflects state from the single projection
- [ ] **Recovery** — killed window/browser at any point → recovery card → resumed upload produces a playable video (R12, R13, R22); recovery KPI ≥ 90%
- [ ] **Cleanup** — disposer registry empty in idle (leak assertion in CI); no orphaned streams/timers/wake locks; cancel/restart leave no local or server orphans (R17)
- [ ] **State machine** — all lifecycle transitions covered by unit tests at 100% branch coverage; no ad-hoc recording booleans in shipped code (grep gate)
- [ ] **Limits** — plan limit auto-stop works under timer throttling; entitlement fetch failure falls back to cached entitlement (R11)

## Upload

- [ ] **Resumable** — restart resumes from recorded parts; zero re-upload of completed parts verified via server part timestamps (R13)
- [ ] **Retryable** — every transient failure class (network, 5xx, 429, presign expiry, timeout) auto-retries with jittered backoff (unit branches + R15)
- [ ] **Idempotent** — session creation (Idempotency-Key), part record, and complete are idempotent; double-complete returns the canonical result (integration test)
- [ ] **Network recovery** — offline-during-recording and flapping-during-upload both converge to success (R14, R15)
- [ ] **Verification** — per-part CRC32C enforced by storage; size reconciliation at complete; FFprobe as final arbiter
- [ ] **No bytes through the API** — video traffic on the API measured ≈ 0 (dashboard) — thumbnail images are the only multipart surface

## Processing

- [ ] **FFprobe** — every source probed before playability; corrupt fixture rejected with `probe_invalid`; client metadata never written to authoritative columns
- [ ] **FFmpeg** — MP4 (H.264/AAC, faststart) produced for 100% of ready recordings; output verified by second probe
- [ ] **Thumbnails/Posters** — non-black poster + thumb + preview generated; placeholder path works when generation fails
- [ ] **HLS/MP4** — HLS for long/high-res recordings; hls.js + Safari native verified; MP4 fallback on HLS fatal error
- [ ] **Retries** — every job idempotent (run-twice test per job); stalled/crashed workers re-run without duplicates; failed jobs visible + retryable in admin
- [ ] **Isolation** — AI/STT outage does not affect `ready` (chaos test); `time_to_ready` p95 within target

## Data

- [ ] **PostgreSQL** — sole source of application truth; no Cloudinary/JSON reads in serving paths (grep + runtime metric)
- [ ] **Transactions** — upload complete, delete+usage, billing event application, render apply each verified atomic under injected failure
- [ ] **Indexes** — every list/filter endpoint has a matching index; no seq-scan on hot paths (EXPLAIN check in CI for repo queries)
- [ ] **Authorization** — central `authorize()`; cross-tenant matrix test green on every owner endpoint
- [ ] **Soft deletion** — recordings/users soft-delete → invisible immediately, hard-purged with storage cleanup after 30 days (E2E)
- [ ] **Migration** — importer idempotent; reconciliation at zero diffs for 7 days before each legacy read cutover; legacy data archived

## Quotas (free plan: 50 active videos AND 5 GB retained storage — whichever first)

- [ ] **Exact limits enforced** — `free.max_active_videos=50`, `free.max_storage_bytes=5_368_709_120`, `free.max_recording_duration_seconds=600`, `free.max_resolution=1080p`, `free.max_upload_bytes=536_870_912` (`16` §1.1); either quota cap independently blocks new recordings
- [ ] **Atomic reservation** — quota check-and-reserve is one guarded statement (`reserve = min(max_upload_bytes, available)`, floor `min_start_bytes`); Q1/Q16 concurrency tests green (two tabs can never double-spend the last 300 MB)
- [ ] **Byte ceiling enforced, not estimated** — recorder auto-stop at ceiling (R23), presign refusal + Content-Length-signed part URLs, exact completion check (Q14, Q17); a legitimate 10-min 1080p recording is never rejected by the ceiling
- [ ] **Server-authoritative accounting** — ledger built only from server-observed sizes (storage HEAD, asset rows); client size/count/duration claims verifiably ignored (hostile-client test Q14)
- [ ] **Ledger categories** — retained / reserved / temporary-processing / pending-deletion distinguished; temp processing files never count toward user storage; derived platform assets never bill the user
- [ ] **Deletion semantics** — soft-delete frees video count and storage quota immediately (Q15); hard purge drains pending-deletion within the 30-day window
- [ ] **Reservation lifecycle** — reconciled at complete, released on abort/expiry; server-restart and abandoned-session leaks healed by expiry job (Q6, Q12); nightly usage_sync drift < 1%
- [ ] **Dual-meter UX** — storage and video meters shown separately with exact block/warning copy (`16` §4.6); recorder pre-flight warns near limit before capture starts; in-progress takes never discarded by a quota verdict

## Security

- [ ] **CORS** — allowlist only (web origins + extension id); no `origin:'*'` anywhere
- [ ] **Signed URLs** — private bucket; TTL policy per privacy level; leaked-URL expiry test green
- [ ] **Rate limiting** — Redis-backed limits on auth, unlock, engagement, uploads, AI; 429 + Retry-After verified
- [ ] **Secure secrets** — env-schema boot validation; no secrets in repo (scan); rotation runbook exercised once
- [ ] **Webhook validation** — Paddle signature + timestamp freshness + event-id dedup + 500-on-failure (replay test)
- [ ] **Sessions** — revocable auth sessions; password change revokes others; reset tokens hashed + single-use
- [ ] **Media privacy** — privacy enforced at the media URL level, not just metadata; lead-gate server-side

## Observability

- [ ] **Logs** — structured, redacted, correlated (request/recording/upload/job ids) across API+worker+client breadcrumbs
- [ ] **Metrics** — recording funnel, pipeline, API, playback dashboards live with real traffic
- [ ] **Tracing** — a single recording traceable end-to-end (upload→jobs→ready) from its id alone (manual drill verification)
- [ ] **Alerts** — the `19` §5 alert set configured and test-fired; on-call doc exists

## Product completeness (parity gate)

- [ ] All current features function on the new stack: library/folders/archive, watch (comments, reactions, transcript+translate, chapters, CTA, speed, embed), editor (trim/split/stitch/silence), sharing (privacy, password, Slack, Gmail button), analytics + leads, notifications, billing/plans/admin — verified against the feature inventory in `01` §1
- [ ] Extension published update passes Chrome review; legacy upload usage < 1% before removal
- [ ] KPIs ≥ baseline captured in Phase 0, and recording success rate ≥ 99%
