# 18 — Error Handling & Taxonomy

> One error language across client, extension, API, workers. Every error has: a stable `code`, an owner (which layer handles it), a user-facing message policy, and a recovery behavior. The API wire shape is defined in `08` §2.

---

## 1. Principles

1. **Codes are stable API.** UIs and tests branch on `code`, never on message text.
2. **Every failure has a recovery path** (invariant #17): retry, resume, fallback, or an explicit dead end with user guidance — "swallow and hope" is banned (current examples to eliminate: bare `catch {}` around Cloudinary context writes `index.js:363`, webhook blind-200).
3. **Retryable vs terminal is explicit** in every layer: transport carries `retryable: boolean` where a client acts on it.
4. **requestId everywhere**: every API error includes `requestId`; user-facing error UIs show it small ("Error id: req_…") for support.

## 2. API error codes (HTTP → codes)

| HTTP | Codes | Recovery |
|---|---|---|
| 400 | `validation_failed` (with details), `comment_depth`, `bad_request` | fix input |
| 401 | `unauthenticated`, `login_required`, `invalid_password` (unlock), `session_expired` | re-auth; extension clears token + prompts sign-in |
| 403 | `feature_locked`, `video_limit`, `storage_limit`, `recording_limit` (all with `upgradeRequired:true` + meta), `link_expired`, `audience_disabled`, `forbidden` | paywall UI / gate UI |
| 404 | `not_found` | dead end (also used for unauthorized-owner resources — `12` §2) |
| 409 | `email_taken`, `upload_session_conflict` (body carries the existing session), `render_in_progress`, `folder_name_taken` | adopt/replace |
| 410 | `upload_session_expired` | client rebuilds session (`05` §6.1.3) |
| 413 | `payload_too_large` | thumbnail only (video never passes through the API) |
| 422 | `upload_manifest_invalid`, `no_speech`, `nothing_to_trim` | user guidance |
| 429 | `rate_limited` (+Retry-After) | backoff + retry |
| 500 | `internal` (opaque; details in logs by requestId) | client retry-once for idempotent GETs; report |
| 501 | `transcription_unconfigured`, `no_llm` | feature hidden/disabled UI |
| 503 | `dependency_unavailable` (db/redis/storage down) | retry with backoff; status banner |

## 3. Recording lifecycle failure codes (`recordings.failure_code`)

`probe_invalid` (corrupt/unreadable source — terminal, offer local download if client still has chunks), `transcode_failed` (retryable via reprocess), `recording_limit` (status `rejected_limit`, 7-day grace, upgrade rescues), `upload_incomplete_expired` (session expired with no recovery — terminal after local data gone).

## 4. Extension / recorder errors (machine event codes, `03`)

| Code | Trigger | UX |
|---|---|---|
| `permission_dismissed` | picker cancelled | "Click Start, then choose what to share" (existing copy) |
| `permission_denied` | OS/browser deny | help link to re-enable; Retry |
| `mic_denied` | mic getUserMedia fails while audio requested | explicit choice: continue muted / fix / cancel (`03` §3.2) |
| `no_device` | no camera/mic present | disable option with tooltip |
| `tab_capture_failed` | getMediaStreamId/gUM tab failure | "try Entire Screen" (existing copy) |
| `constraint_failed` | OverconstrainedError | retry at lower quality automatically once |
| `audio_context_suspended` | mixer not running | warning banner; auto-resume attempts |
| `no_audio_at_all`, `tab_audio_missing`, `no_system_audio`, `mic_lost`, `tab_audio_lost`, `bubble_not_captured` | capture warnings | non-blocking banners (existing copies kept, `recorder.js:304-315`) |
| `persist_failed` / `insufficient_disk` | IndexedDB failure/quota | banner "recovery protection unavailable" / refuse start (`05` §4) |
| `recorder_error` | MediaRecorder error event | salvage-stop: finalize what exists |
| `recording_in_progress` | second window | refuse with pointer to active session |

## 5. Upload errors (uploader-internal → machine)

Transient (self-retried, never surfaced except as "reconnecting"): network failure, 5xx, 429, presign-expired, timeout. Terminal (surface `upload_failed` state): `session_expired` after rebuild also fails, `video_limit`/`storage_limit`/`recording_limit` at complete (→ upgrade prompt + local save — keep the "never lose a take" behavior), `unauthenticated` unrecoverable after re-auth prompt, `upload_manifest_invalid` (bug — report loudly). Fatal-vs-transient decision lives in one function in the uploader; tests cover each branch (`20` §7).

## 6. Worker/job errors

Every processor classifies errors: `TransientError` (infra, rate limit, timeout → BullMQ retry with backoff) vs `TerminalError` (deterministic: corrupt input, invalid state → fail fast, apply the job's declared user-visible failure state from `10` §3). Unknown exceptions default to transient until max attempts. All failures land in `processing_jobs.last_error` (message + stderr tail for ffmpeg) and are triaged via `/admin/jobs`.

## 7. Database & storage errors

- DB: connection failures → 503 `dependency_unavailable`; serialization/deadlock → automatic retry (3×) inside the repository layer for idempotent transactions; constraint violations map to 409 codes.
- Storage (R2): SDK errors normalized by the StorageProvider to `StorageUnavailable` (transient) / `StorageNotFound` / `StorageDenied` (bug — alert); playback-side handled per `11` §5.

## 8. AI/STT errors

Per `15` §8 — chunk-level retries inside jobs, job-level retries, provider fallback, `no_speech` as a valid outcome, `ai_status='failed'` never affecting video availability. Manual triggers surface `{code, retryable}`; auto triggers fail silently into status fields.

## 9. Billing errors

Webhook: signature 401; duplicate 200-skip; processing failure 500 (Paddle retries) + `billing_events.failed` + alert. API-side Paddle calls: `{ok:false,error}` shaped, non-throwing (pattern kept). Checkout config errors: 400 with reason. **Billing errors never mutate recordings/usage** (invariant #15).

## 10. Frontend handling rules

- Central `apiFetch` maps the error contract to typed `ApiError {code, message, upgradeRequired, requestId}`; components `switch` on code.
- `feature_locked`/limit codes → the existing UpgradeModal path with `meta` numbers.
- Replace every `alert(...)` in `Watch.jsx`/`Editor.jsx` with toast/inline errors during refactor (tracked in `24` tasks).
- Global error boundary + unhandled-rejection reporter → error tracking with requestId correlation (`19` §6).
- Optimistic updates (audience toggles, tags, folder moves — `Watch.jsx:367-416`) must roll back on failure and toast; today failures are silently ignored (`.catch(() => {})`).

## 11. Message policy

User-facing: plain language, action-oriented, no internals ("Upload failed — we'll keep retrying. Your recording is safe on this device."). The current codebase's user-copy quality is good — preserve wording where it exists. Log-facing: full detail, structured, redacted per `17` §10.
