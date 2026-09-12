# 08 — API Specification

> REST API, base path `/api/v1`. Legacy unversioned routes remain as aliases during migration (`23`). JSON everywhere; errors follow one contract (§2). Endpoints marked ⚿ require auth; ⚿A require admin.

---

## 1. Conventions

- Auth: `Authorization: Bearer <sessionToken>` (opaque token → `sessions` table; see `17` §2). 401 = missing/invalid, 403 = authenticated but not allowed.
- IDs in paths are typed ids (`rec_…`). Unknown id or not-owned → **404** (never 403 — don't leak existence; same convention the current code follows).
- Pagination: `?limit=` (≤100, default 50) `&cursor=` (opaque); responses `{items, nextCursor|null}`.
- Idempotency: unsafe endpoints that clients may retry accept `Idempotency-Key` (uuid). The server stores `(user_id, key) → response hash` for 24h and replays the stored response on repeat. Endpoints with natural idempotency note it instead.
- Rate limits (Redis, per user or IP): auth 10/15min·IP, signup 15/h·IP, forgot 5/h·IP, comments/reactions 30/min·IP, views/progress 60/min·IP, uploads 10 sessions/h·user, AI endpoints 10/h·user. 429 + `Retry-After`.
- Validation errors: 400 with `details` array (zod-derived).
- **Router auth scope (T-801):** every `/api/v1` router mounted on the same prefix gates ONLY its own paths (`/uploads`, `/recordings`, `/me`, `/admin`) — an unscoped `router.use(requireAuth)` on one router would reject anonymous requests to a sibling's public routes (the watch routes) with the legacy flat 401 before they were ever reached. Rate limits on the watch routes are per-process fixed windows until the Redis limiter lands (Phase 9/10).

## 2. Response & error contract

Success: resource JSON or `{items,...}`. No envelope.
Error (every non-2xx):
```json
{ "error": { "code": "storage_limit", "message": "Human-readable, user-facing.",
             "details": [ ... ],            // optional, machine-readable
             "upgradeRequired": true,        // optional, paywall errors only
             "requestId": "req_abc123" } }
```
`code` values come from the taxonomy in `18` §2. Legacy clients read `error` as a string — during migration the legacy aliases keep the old flat shape `{error, code, upgradeRequired}`; `/api/v1` uses the nested shape.

## 3. Auth

| Method & path | Auth | Request | Response | Notes |
|---|---|---|---|---|
| POST `/auth/signup` | – | `{name,email,password}` | `{token,user}` | pw ≥ 8 (raise from 6); rate-limited; creates personal workspace |
| POST `/auth/login` | – | `{email,password}` | `{token,user}` | generic 401 on bad creds |
| POST `/auth/google` | – | `{credential}` | `{token,user}` | server-side tokeninfo verify, audience + email_verified checks (keep `index.js:191-214` logic) |
| POST `/auth/logout` | ⚿ | – | `{ok}` | revokes the session row |
| GET `/auth/me` | ⚿ | – | `user` (publicUser shape: id,name,email,entitlements,isAdmin,hasSlack,created_at) | |
| PATCH `/auth/profile` | ⚿ | `{name?,email?,slackWebhook?}` | `user` | email uniqueness 409; slack webhook regex as today |
| PATCH `/auth/password` | ⚿ | `{currentPassword,newPassword}` | `{ok}` | revokes all other sessions |
| POST `/auth/forgot` | – | `{email}` | `{ok}` always | token **hash** stored; email via Brevo |
| POST `/auth/reset` | – | `{email,token,password}` | `{token,user}` | single-use; revokes all sessions |
| GET `/auth/config` | – | – | `{googleClientId,emailEnabled}` | |

`user.entitlements` = the summary from `entitlements.summary()` (ported unchanged).

## 4. Recordings

| Method & path | Auth | Request → Response | Errors / idempotency / side effects |
|---|---|---|---|
| POST `/recordings` | ⚿ | `{title?, source:'extension'|'web_upload', clientMeta?}` → `201 {id,status:'recording'}` | Idempotency-Key supported. Side effect: row only. Entitlement `canCreateVideo` **advisory** here; authoritative enforcement is the atomic reservation at upload-session creation (`16` §4.3) |
| GET `/recordings` | ⚿ | `?folder=&archived=&q=&cursor=` → `{items:[RecordingSummary], nextCursor}` | one indexed query; kills the Cloudinary dual-fetch |
| GET `/recordings/:id` | ⚿ owner | → `RecordingDetail` (incl. assets summary, status, capability flags `canTranscribe/canStitch`) | 404 if not owner |
| PATCH `/recordings/:id` | ⚿ owner | `{title}` → `{title}` | title 1–200 after trim |
| PATCH `/recordings/:id/meta` | ⚿ owner | any of `{description,tags,audience,cta,privacy,password,folder,trimStart,trimEnd,segments,recommendedSpeed,animatedThumbnail,archived,removeBranding}` → updated meta | validation identical to current route (`index.js:926-1019`); Pro gates: password (`passwordProtection`), requireEmail (`leadCapture`), removeBranding — each 403 `feature_locked` + paywall analytics event |
| DELETE `/recordings/:id` | ⚿ owner | → `{ok}` | soft delete; tx decrements usage from stored size/duration; hard purge after 30d. Idempotent (deleting deleted → 200) |
| POST `/recordings/:id/duplicate` | ⚿ owner | → `{id,title}` | enqueues a copy job (server-side R2 copy of source + re-process); returns new recording with status 'processing' |
| POST `/recordings/:id/thumbnail` | ⚿ owner, Pro | small image upload (≤5MB, the one multipart the API accepts) → `{ok}` | gate `customThumbnailEnabled` |

`RecordingSummary`: `{id,title,status,duration,size_bytes,created_at,privacy,folder_id,thumbnailUrl,posterUrl,views,commentCount,archived,tags,ai_status}` — URLs are signed (`12` §5).

## 5. Upload (full detail in `06`)

| Method & path | Auth | Notes |
|---|---|---|
| POST `/uploads` | ⚿ | create session; Idempotency-Key; **atomic quota reservation** (`16` §4.3) — 403 `storage_limit`/`video_limit` (+`upgradeRequired`, `meta`) when either free-plan cap (5 GB storage / 50 active videos) blocks; 409 `upload_session_conflict` if another active session for the recording (returns it, no double reservation) |
| GET `/uploads/:id` | ⚿ owner | status + parts (server⊕storage reconciled) — the resume source of truth |
| POST `/uploads/:id/parts` | ⚿ owner | `{partNumbers:[≤20]}` → presigned URLs; repeatable |
| PUT `/uploads/:id/parts/:n` | ⚿ owner | `{etag,size,crc32c}` → upsert; naturally idempotent |
| POST `/uploads/:id/complete` | ⚿ owner | idempotent (completed → replay canonical result); tx per `06` §7; enqueues probe |
| DELETE `/uploads/:id` | ⚿ owner | abort; idempotent; releases the quota reservation exactly once |

**Atomic quota reservation (T-306, `16` §4.3).** `POST /uploads` reserves `min(plan.max_upload_bytes, available)` bytes and one video slot inside the same transaction that inserts the session; `byteCeiling` in the response **is** that reservation. Guard failure ⇒ `403 {error:{code:'storage_limit'|'video_limit', upgradeRequired:true, meta:{usedBytes,reservedBytes,limitBytes,videoCount,reservedSlots,maxVideos,plan}}}` and **no session is created**. Completion reconciles with the HEAD size; abort, expiry, an over-ceiling manifest and a refused completion release it. `GET /me/usage` (below) reads the same live aggregates as the guard.

**Single-PUT mode (T-305, `06` §12).** `POST /uploads` with `{recordingId, mimeType, mode:'single', sizeBytes}` returns `201 {uploadSessionId, mode:'single', uploadUrl, uploadUrlExpiresAt, uploadHeaders:{'Content-Type','Content-Length'}, byteCeiling, expiresAt, status}`; the browser PUTs the whole file to `uploadUrl`, then `POST /uploads/:id/complete` with `{parts:[]}`. `sizeBytes` is required (`400 invalid_request`), capped at 33,554,432 (`400`, use multipart) and at the plan ceiling (`403 storage_limit`, `upgradeRequired`). Part endpoints answer `409 invalid_state`; completing before the PUT answers `409 upload_object_missing`. The web editor's "Add video → Upload" uses this when `GET /client-config` answers `webUpload.path:"v1"` (§14a); the application server never receives the bytes.

**Deprecated (T-305): `POST /recordings/:id/replace`** (memory-multer). Kept functional and unchanged; every use is logged as `deprecated_replace_used` and counted (`19` §8.3). Removed in Phase 14 once that count stays at zero over a full observation window. Do not add callers.

## 6. Processing & assets

| Method & path | Auth | Response |
|---|---|---|
| GET `/recordings/:id/status` | ⚿ owner (or public shape via watch) | `{status, failureCode, jobs:[{queue,status,progress}], assets:[{kind,variant,status}]}` — the watch page polls this while `status!='ready'` |
| POST `/recordings/:id/reprocess` | ⚿ owner | re-enqueue failed pipeline stages (dedupe keys prevent duplicates) → `{ok}` — *delivered by T-703 on `/api/v1`: requeues the `probe:{id}` job (attempts reset; the probe re-establishes facts, re-applies the entitlement and requeues the derived jobs) → `202 {ok, jobId, status, reused}`; 409 `not_reprocessable` before the media landed or without a source* |

## 7. Watch (public, privacy-aware — enforcement per `12`)

| Method & path | Auth | Request → Response |
|---|---|---|
| GET `/watch/:id` | optional | → `WatchPayload` or `401 {code:'login_required'}` or `200 {requiresPassword:true,title,shareLink?:{label}}` or `403 {code:'link_expired'}`; `?s=`/`?shareToken=` for share-link access; workspace non-members and deleted/unknown ids are **404** *(T-801 ✅; each fetch through a share link counts one view against `max_views`)* |
| POST `/watch/:id/unlock` | optional | `{password}` → `WatchPayload + {accessToken, accessExpiresAt}`; `401 invalid_password`; rate-limited 10/15min·IP (`429 rate_limited` + `Retry-After`) *(T-801 ✅: verifies the recording password, or the share link's own password when `?s=` is present; the **access token** (HMAC, recording-bound, 24 h, grants `password` / `share:<linkId>` / `lead`) is sent back as `X-Watch-Access` or `?a=` on `/media`, `/transcript` and the HLS proxy — nothing is stored server-side; sha256 (v1) and bcrypt (legacy) hashes both verify)* |
| POST `/watch/:id/view` | optional | `{visitorId?}` → `{views}`; upserts `view_sessions` (unique viewer_key; owner ⇒ `is_owner`, not counted); naturally idempotent |
| POST `/watch/:id/progress` | optional | `{pct}` (0–1, sendBeacon) → 204; upsert max_progress |
| GET `/watch/:id/engagement` | optional | `{views,reactions,comments}` |
| POST `/watch/:id/comment` | optional | `{text,name?,t?,parentId?}` → `Comment`; 403 if audience.comments=false; rate-limited |
| POST `/watch/:id/react` | optional | `{emoji,t?,name?}` → `{reactions}`; 403 if disabled; rate-limited |
| POST `/watch/:id/lead` | optional | `{email,name?}` → `{ok, accessToken, accessExpiresAt}`; unique per (recording,email); rate-limited 30/min·IP *(T-801 ✅: the email gate — with `audience.requireEmail` the server refuses `/media` (`403 email_required`) until a lead token is presented; the payload carries `requiresEmail`)* |
| GET `/watch/:id/transcript` | optional | `{status:'none'|'queued'|'running'|'done'|'failed', configured, language, text, segments}` — real statuses at last (today only done/none) *(T-801 ✅: gated exactly like `/media` incl. the lead gate; `403 audience_disabled` for viewers when `audience.transcript=false`)* |
| GET `/watch/:id/media` | optional | `{status, mp4Url, hlsUrl, posterUrl, captionsUrl, expiresAt, ttlSeconds, download}` (flat, as `11` §2 consumes it — the earlier `{playback:{…}}` envelope is dropped) — **signed URLs**, TTL per privacy (`12` §5: public 24 h, everything else 10 min; posters always 24 h); 401/403 exactly as `/watch/:id`; `?disposition=attachment` → the mp4 URL forces a download with a safe filename (`403 audience_disabled` for viewers when `audience.download=false`); a processing recording answers `status` with null URLs; `hlsUrl` points at the playlist proxy and carries a playlist-scoped token (`?a=`, grant `hls`, expires with the media TTL) whenever the recording is gated, because hls.js cannot send a Bearer *(T-801 ✅)* |
| GET `/watch/:id/hls/:file` | optional | the playlist rewrite proxy (`12` §5.2): `master.m3u8` → variant playlists as absolute proxy URLs (token propagated); `{name}_index.m3u8` → `#EXT-X-MAP` init + segments as presigned storage URLs (media TTL). Playlists only — a segment name is 404, a non-key-safe name 400. `application/vnd.apple.mpegurl`, `no-store` *(T-801 ✅)* |

`WatchPayload`: recording public fields + `author`, `branding`, `status` (viewers see 'processing' honestly), chapters, audience, cta, trim/segments, recommendedSpeed — media URLs only via `/media`. *(T-801: also `requiresEmail`, `views` (unique, non-owner), `viewer:{isOwner,isAdmin,via,signedIn}`; `failureCode` is owner/admin-only — viewers get `status:'failed'` and nothing else; no storage key, URL or hash ever appears.)*

## 8. Sharing

| Method & path | Auth | Request → Response |
|---|---|---|
| GET `/recordings/:id/share-links` | ⚿ owner | list |
| POST `/recordings/:id/share-links` | ⚿ owner | `{label?,password?,expiresAt?,maxViews?}` → `{id, url}` (token shown once) |
| DELETE `/share-links/:id` | ⚿ owner | revoke (sets revoked_at); idempotent |
| POST `/recordings/:id/share/slack` | ⚿ owner, Pro `slackEnabled` | → `{ok}`; 400 `needsWebhook`; 502 slack errors (as today) |

## 9. Analytics & notifications

| Method & path | Auth | Response |
|---|---|---|
| GET `/recordings/:id/analytics` | ⚿ owner, Pro `analyticsEnabled` | `{views, uniqueViewers, viewers:[{name,email,at,maxProgress}], engagement:{avgViewThrough,completionRate,samples}, reactions, comments, leads}` — SQL aggregates over view_sessions |
| GET `/analytics/overview` | ⚿, Pro | per-recording rollup for the analytics page |
| GET `/notifications` | ⚿ | `{items:[Event], unread, lastReadAt}` — query over comments/reactions/view_sessions newer-than, excluding actor==owner **by user_id** (not display-name matching) |
| POST `/notifications/read` | ⚿ | `{lastReadAt}` |

## 10. Folders

CRUD as today: GET/POST `/folders`, PATCH/DELETE `/folders/:id` (⚿ owner; name 1–60; delete sets recordings.folder_id NULL). POST returns 409 on duplicate name.

## 11. Editing (full spec `14`)

| Method & path | Auth | Request → Response |
|---|---|---|
| POST `/recordings/:id/edit-sessions` | ⚿ owner | `{timeline}` → `{editSessionId}` (draft) |
| PATCH `/edit-sessions/:id` | ⚿ owner | `{timeline}` / `{op}` append → updated |
| POST `/edit-sessions/:id/render` | ⚿ owner | `{mode:'overwrite'|'copy'}` → `{renderJobId}` (202) — multi-clip requires Pro `clipStitchEnabled`; enqueues render job |
| GET `/render-jobs/:id` | ⚿ owner | `{status,progress,outputRecordingId?}` — editor polls |
| POST `/recordings/:id/remove-silences` | ⚿ owner | → `202 {jobId}` then `{segments,keptSeconds,removedSeconds}` via job result (async — today it blocks on transcription) |
| POST `/recordings/stitch` | ⚿, Pro | `{ids[2..10], title?}` → `{editSessionId, renderJobId}` (sugar over edit-sessions) |

Virtual trim stays synchronous via PATCH `/recordings/:id/meta` (no render needed).

## 12. Transcription & AI (all async; full job specs `10`, `15`)

| Method & path | Auth/gate | Behavior |
|---|---|---|
| POST `/recordings/:id/transcribe` | ⚿ owner, `transcriptionEnabled` | `{language?}` → `202 {jobId}`; transcript.status → 'queued'. 501 `transcription_unconfigured` if no provider |
| DELETE `/recordings/:id/transcribe` | ⚿ owner | clears transcript; idempotent |
| POST `/recordings/:id/transcript/translate` | ⚿ owner, `aiDocsEnabled` | `{lang}` → cached translation or `202 {jobId}` |
| POST `/recordings/:id/title/auto` | ⚿ owner, `transcriptionEnabled` | `202 {jobId}` → job writes title |
| POST `/recordings/:id/summary` | ⚿ owner, `aiDocsEnabled` | `202 {jobId}` → writes description |
| POST `/recordings/:id/chapters` | ⚿ owner, `aiDocsEnabled` | `202 {jobId}` → writes chapters |

Clients poll `GET /recordings/:id/status` (or the transcript endpoint) — replacing today's long-held HTTP requests that die on restart. *(T-603 delivered this section on `/api/v1` — `api/src/ai.router.js`: every trigger answers `202 {jobId, status, reused}` and writes rows only; `translate` answers `200 {cached:true}` from the cache; `title/auto` needs `transcriptionEnabled`, `summary`/`chapters`/`translate` need `aiDocsEnabled` (403 `feature_locked` + `upgradeRequired`); 501 `transcription_unconfigured` without a provider; 409 `not_transcribable` before the media landed, 409 `transcript_required` for AI triggers without a done transcript; `GET /recordings/:id/transcript` → `{status, configured, language, text, segments:[{idx,start,end,text,language}], source, spokenLang, error, note}`; `GET /recordings/:id/status` → `{status, failureCode, aiStatus, jobs:[{id,queue,status,attempts,progress,error}], assets:[{kind,variant,status}], transcript:{status}}`. `POST /recordings/:id/reprocess` is Phase 7.)*

## 13. Plans, billing, usage

| Method & path | Auth | Notes |
|---|---|---|
| GET `/plans` | – | public catalog (`plans.listPublicPlans`) |
| GET `/me/entitlements` | ⚿ | entitlement summary (extension recorder reads this) |
| GET `/me/usage` | ⚿ | **dual quota meters** — `{storage:{usedBytes,reservedBytes,limitBytes,pendingDeletionBytes,display}, videos:{count,reserved,max,display}, recordingLimitSeconds, maxResolution, maxUploadBytes, minStartBytes, model}` (`16` §4.5; **implemented T-306** at `/api/v1/me/usage`, `Cache-Control: no-store`). The UI renders storage and video count as two separate meters, never one blended percentage. `model` is `legacy` or `v2` per `QUOTA_ENFORCEMENT_V2` |
| GET `/billing/config` | – | Paddle bootstrap (as today) |
| POST `/billing/checkout` | ⚿ | `{billingCycle}` → checkout config w/ customData {userId,planSlug,billingCycle} |
| GET `/billing/subscription` | ⚿ | local + remote view |
| POST `/billing/sync` / `/cancel` / `/resume` / `/change-plan` | ⚿ | as today via billing.service |
| GET `/billing/portal` | ⚿ | portal session URL |
| POST `/webhooks/paddle` | signature | **New behavior:** verify signature → insert `billing_events` (dup event id ⇒ 200 skip) → process in tx → 200; processing error ⇒ mark failed + **500** (Paddle retries). Never blind-200 (fixes `webhooks.paddle.js:173-178`) |
| POST `/events/upgrade-intent` | ⚿ | writes `analytics_events(event:'paywall_hit')` |

## 14. Contact & misc

POST `/contact` (public, rate-limited 5/h·IP, honeypot field) → `{ok,id}`; admin email best-effort as today.

## 14a. Client configuration (cutover control — T-304)

`GET /client-config` (⚿, mounted on the legacy server as `/api/client-config`) — the
**server-authoritative** answer to "which upload path should this client use?". The
client obeys it and never computes eligibility for itself, so a modified or replayed
client cannot opt into the rollout.

```json
{ "upload":    { "path": "legacy" | "v1", "v1Enabled": false },
  "webUpload": { "path": "legacy" | "v1", "v1Enabled": false },
  "refreshAfterSeconds": 300 }
```

- `upload` — the **extension's** decision (T-304 percentage rollout, per-user bucket).
- `webUpload` — the **web editor's** decision (T-305). A separate, plain on/off gate,
  `V1_WEB_UPLOAD`, enabled only by the exact string `true` **and** only while the v1 API
  is mounted. It has no percentage and no bucket; enabling it moves no extension user,
  and the extension percentage cannot enable it. The same mirror rule applies: an
  account with no PostgreSQL row is answered `legacy` and recorded as
  `account_not_migrated` on its own `web_upload_decision` line. Rollback is unsetting the
  variable and restarting — clients re-fetch this on every upload.

- `path` — the only field the client acts on. `v1Enabled` is the same fact restated
  for readability; they can never disagree.
- `refreshAfterSeconds` is **advisory**. The extension ignores it upward: it re-fetches
  at the start of **every recording** and caches nothing between takes, so a rollback
  reaches a running client on its next recording rather than waiting out a TTL.
- The body carries **no user id, no bucket and no rollout percentage**. It is a
  decision, not the reasoning behind one — the reasoning is in the server logs
  (`19` §8), where it is useful to an operator and not to an attacker.
- Unauthenticated ⇒ `401`. Any server-side failure while deciding (database down,
  configuration unreadable) resolves to `legacy`, never to `v1`: the endpoint fails
  toward the path production already runs.

### 14b. Public client configuration (T-802)

| Method & path | Auth | Response |
|---|---|---|
| GET `/api/client-config/public` | – | `{ watch: { path: 'v1'|'legacy', v1Enabled }, refreshAfterSeconds }` — the WATCH PAGE gate for anonymous viewers. `path:'v1'` only when `V1_WATCH_PAGE` is exactly `'true'` **and** `V1_UPLOAD_API` is on; every other value, and any failure, is legacy. No identifiers, no per-user decision, `no-store`. The authed `/api/client-config` carries the same `watch` block beside `upload` and `webUpload`. One `watch_decision` KPI line per lookup (`19` §8.3). |

## 15. Admin (⚿A; every mutation writes `audit_logs`)

| Method & path | Notes |
|---|---|
| GET `/admin/metrics` | totals, MRR, churn, conversion summary — SQL aggregates replacing `buildAdminMetrics` |
| GET `/admin/business` | cost/P&L dashboard (infra model retained; storage usage from `usage` sum) |
| GET `/admin/users?q=` | list w/ plan/usage/subscription |
| POST `/admin/users` | create/invite (invite = reset-token email flow, as today) |
| PATCH `/admin/users/:id/plan` | comp grant/revoke (`manualPlan`, optional days) |
| DELETE `/admin/users/:id/subscription` | clear local record (does NOT cancel in Paddle — keep the current doc comment) |
| DELETE `/admin/users/:id` | soft delete; cannot delete self/admins |
| GET `/admin/plans`, PATCH `/admin/plans/:slug`, DELETE `/admin/plans/:slug/override` | plan overrides (whitelisted fields as `plans.js` OVERRIDABLE) |
| GET `/admin/contacts`, PATCH `/admin/contacts/:id` | contact inbox |
| GET `/admin/pipeline`, POST `/admin/pipeline/backfill` | **new** (T-706): pipeline progress numbers `{totalActive, withSource, complete, pending, failed, rejected, probeInFlight, completePercent}`; the throttled backfill trigger `{limit?, apply?, includeFailed?}` → dry-run report (200) or queued rows (202) |
| GET `/admin/jobs?status=failed` , POST `/admin/jobs/:id/retry` | **new**: processing-job triage — **delivered by T-601** on `/api/v1` behind `V1_UPLOAD_API` + the `ADMIN_EMAILS` allowlist (`403 admin_only` otherwise): `GET` takes `status` (default `failed`), `queue`, `limit` (≤ 500) → `{jobs:[{id,queue,recordingId,dedupeKey,status,attempts,maxAttempts,lastError,result,enqueuedAt,startedAt,finishedAt,createdAt,updatedAt}],status,count}` — never the payload; `POST /:id/retry` → `404 job_not_found` / `409 invalid_state` unless `failed` / `{ok,job}` with the row reset to `queued`, `attempts 0`, unstamped (the worker's outbox relay re-enqueues it; the API never touches Redis) |

## 16. Deprecated / removed vs current API

- `POST /api/upload` (multipart video through server) → removed after migration; legacy alias kept until extension fleet updates (`23` Phase 3).
- `POST /recordings/:id/replace` (memory-multer) → removed; renders + web-upload protocol replace it.
- `POST /recordings/:id/trim` & `/compose` synchronous Cloudinary paths → replaced by edit-sessions + render jobs (legacy aliases respond 202 by internally creating an edit session during migration).
- Embed: `GET /watch/:id` + `/media` power `/embed/:id` unchanged.
