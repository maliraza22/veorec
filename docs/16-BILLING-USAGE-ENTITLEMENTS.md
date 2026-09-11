# 16 — Billing, Usage & Entitlements

> The monetization layer. The existing capability-based design (`plans.js`, `entitlements.js`, `permissions.service.js`, `billing.*`, `webhooks.paddle.js`) is the best-engineered part of the current codebase and is **ported, not redesigned** — with storage moved to Postgres and webhook processing made idempotent.

---

## 1. Plans

Code-defined catalog (`plans.js` ports to `apps/api/src/billing/plans.ts`). **The Free plan enforces BOTH an active-video cap AND a storage cap — whichever limit is reached first blocks the next recording/upload.** Positioning: a generous free recording allowance with predictable storage consumption — the Free plan is NOT unlimited storage.

| | Free | Pro ($7.99/mo, $79/yr) | Business (defined, not sold) | Enterprise (defined, not sold) |
|---|---|---|---|---|
| max active videos | **50** | unlimited | – | – |
| retained storage | **5 GB** (both limits enforced; first one reached blocks) | 1 TB | 1 TB | 10 TB |
| recording length | 10 min | 600 min | 240 min | 600 min |
| max resolution | **1080p** | 1080p | 1080p | 4k |
| branding watermark | on | off | off | off |
| features | basicSharing, transcription | + analytics, customThumbnail, removeBranding, priorityProcessing, passwordProtection, advancedSharing, aiDocs, clipStitch, leadCapture, slack | superset | superset |

> Legacy note: the current code (`server/plans.js`) still says free = 30 videos / 20 GB / 720p. This section is the **target**; the cutover and grandfathering policy are in `23` Phase 3.

### 1.1 Canonical entitlement fields (exact values — implementation uses these integers, never strings)

```
free.max_active_videos              = 50
free.max_storage_bytes              = 5_368_709_120      // 5 GiB (marketed "5 GB")
free.max_recording_duration_seconds = 600                // +30s server grace, §3
free.max_resolution                 = { width: 1920, height: 1080 }   // long edge ≤ 1920
free.max_upload_bytes               = 536_870_912        // 512 MiB per-recording hard byte ceiling (§4.3a)
free.min_start_bytes                = 67_108_864         // 64 MiB — refuse to start below this much free quota

pro.max_active_videos               = null               // unlimited
pro.max_storage_bytes               = 1_099_511_627_776  // 1 TiB
pro.max_recording_duration_seconds  = 36_000             // 600 min
pro.max_resolution                  = { width: 1920, height: 1080 }
pro.max_upload_bytes                = 21_474_836_480     // 20 GiB (600 min practical max ≈ 18.5 GiB + headroom)
pro.min_start_bytes                 = 67_108_864
```

**How `max_upload_bytes` was derived (verified against the recorder, not assumed):** the recorder's encoder settings are *targets*, not guarantees — current code sets `videoBitsPerSecond` 4/2.5/1 Mbps by quality and leaves audio at the browser default (`extension/recorder.js:262-266`); the target spec pins audio at 128 kbps (`03` §6). MediaRecorder's VBR output averages near its target but can overshoot transiently, so no bitrate arithmetic is a *guarantee*. Practical worst case at 1080p/high: 4.0 Mbps video + 128 kbps audio + ~2% container ≈ 526,000 B/s → 630 s (limit + grace) ≈ **331 MB**. `free.max_upload_bytes = 512 MiB` gives ~62% headroom above that — a legitimate 10-minute 1080p recording can never plausibly hit the ceiling, while a runaway encoder or hostile client is still hard-capped. The ceiling is made **deterministic by enforcement, not by trusting the encoder** — three independent layers, §4.3a.

"Active video" = a `recordings` row whose `status ∈ {recording, uploading, uploaded, processing, ready}` and `deleted_at IS NULL`. Soft-deleted, `failed`, and `rejected_limit` recordings do **not** count. `max_resolution` is enforced at capture (recorder constraints) and at transcode (`09` §3 scale cap) — an over-resolution web upload is downscaled, never rejected for resolution alone.

**Core rule preserved:** business logic asks `plan.features.analyticsEnabled`, never `plan === 'pro'`. Billing cycle lives on the subscription, not the plan. Admin runtime overrides move from `plan_overrides.json` to the `plan_overrides` table (same whitelist of overridable fields; `maxVideos`/`storageLimitGB` overrides map onto these fields).

## 2. Entitlement resolution (unchanged priority)

`resolveSlug(user)`: admin comp (`manual_plan`, optional expiry) → entitled subscription (`active|trialing|past_due`; canceled keeps access only until period end — note: current `subscriptions.isEntitled` returns false immediately on `canceled` ignoring `cancelAtPeriodEnd` period-end grace; **fix in port**: `canceled` with `current_period_end > now` remains entitled, matching the documented intent) → legacy stored plan field (only when no contradicting subscription) → free.

`summary(user)` (plan, planSlug, isPaid, source: comped|subscription|free, subscription snapshot) is embedded in `user.entitlements` on auth responses and served at `GET /me/entitlements` — the extension recorder consumes it for the countdown limit (`03` §8).

## 3. Server-side enforcement (unchanged shape, new authority points)

All gates return `{allowed, reason?, upgradeRequired?, meta?}` and are called server-side before privileged actions (`permissions.service` port):

| Gate | Enforced at |
|---|---|
| `canCreateVideo` (active-video count) | **upload-session creation — atomic slot reservation** (§4.3, authoritative); recording create (advisory); re-verified at complete |
| `canUploadVideo` (storage) | **upload-session creation — atomic byte reservation** (§4.3, authoritative); reconciled with the real size at complete |
| `canRecord` (duration, +30s grace) | **post-probe** with FFprobed duration (authoritative — client hints no longer decide, fixing the trust hole at `index.js:393`), recorder UI countdown (advisory) |
| max resolution | recorder capture constraints (advisory) + transcode scale cap (authoritative, `09` §3) |
| feature gates (analytics, password, branding, aiDocs, clipStitch, leadCapture, slack, thumbnail, prioritized processing) | their endpoints, exactly as today |
Every denial writes `analytics_events(event:'paywall_hit', props:{trigger})` with the canonical trigger names (`conversion.js` TRIGGERS preserved).

**Grace on rejection (new):** an over-limit upload is kept 7 days as `rejected_limit` before purge, so upgrading rescues the recording (`06` §7.5). Billing state changes never mutate recordings (invariant #15): downgrades stop new privileges; existing videos remain.

## 4. Usage accounting — the server-authoritative storage ledger

**The server is authoritative for storage accounting and video counts. The client is never trusted to report storage usage, file size, or video count** — client numbers are hints; the ledger is written only from server-observed facts (storage HEAD at complete, FFprobe, asset rows).

### 4.1 Ledger categories

The system distinguishes four categories of bytes per user (tables in `07` §9):

| Category | Definition | Counted against user quota? |
|---|---|---|
| **Retained** | `usage.storage_retained_bytes` — sum of `video_assets.size_bytes` where `counts_toward_quota = true` and `status='ready'` on non-deleted recordings (the recording's primary media: `source`, or `render_output` for rendered recordings) | **Yes** |
| **Reserved** | `usage.storage_reserved_bytes` — sum of open `storage_reservations` (uploads in flight) | **Yes** (temporarily) |
| **Temporary processing** | worker scratch files, un-promoted derived outputs, incomplete multiparts | **Never** — exists only on worker disks / as un-completed storage objects, cleaned by `10` §3 jobs |
| **Pending deletion** | assets of soft-deleted recordings awaiting the 30-day hard purge (`usage.storage_pending_deletion_bytes`, informational) | **No** — quota is released at deletion confirmation (§4.4) |

Derived assets the platform creates (MP4 transcode, HLS, posters, captions) have `counts_toward_quota = false`: users are charged for what they recorded/uploaded, not for platform-generated renditions.

### 4.2 Quota formula

```
available_bytes   = plan.max_storage_bytes − retained − reserved
available_slots   = plan.max_active_videos − active_video_count − reserved_video_slots   (null plan cap ⇒ ∞)
reservation_bytes = min(plan.max_upload_bytes, available_bytes)      // = this recording's hard byte ceiling
```
A new recording/upload is allowed iff `available_bytes ≥ plan.min_start_bytes` **and** `available_slots ≥ 1`. The two limits are independent; either alone blocks. Reserving `min(ceiling, available)` — instead of a fixed worst case — means a user with 300 MiB free can still record (their take is byte-capped at 300 MiB, disclosed up front, §4.3a) rather than being rejected outright, while concurrent uploads still can't overspend.

### 4.3 Atomic check-and-reserve (race-condition prevention)

Reservation happens at **upload-session creation** (`06` §3), inside the same transaction that inserts the session, as a single guarded UPDATE on the user's `usage` row (the row acts as the per-user lock):

```sql
UPDATE usage SET
  storage_reserved_bytes = storage_reserved_bytes + :reserve,
  reserved_video_slots   = reserved_video_slots + 1
WHERE user_id = :uid
  AND :reserve >= :min_start_bytes            -- refuse doomed sub-64MiB recordings
  AND storage_retained_bytes + storage_reserved_bytes + :reserve <= :max_storage_bytes
  AND (:max_active_videos IS NULL
       OR active_video_count + reserved_video_slots + 1 <= :max_active_videos)
RETURNING *;
```
Zero rows updated ⇒ 403 `storage_limit` or `video_limit` (whichever guard failed — checked in that order and reported precisely). A `storage_reservations` row records `{user_id, upload_session_id, reserved_bytes, status:'held', expires_at}`.

`:reserve = min(plan.max_upload_bytes, available_bytes)` — always server-computed, never a client estimate; the reserved amount **is** that recording's hard byte ceiling (§4.3a). This makes the two-tabs race impossible by construction: with 4.7 GiB retained of 5 GiB, the first tab atomically reserves the remaining ~300 MiB (its take is byte-capped there, disclosed up front); the second tab's guarded UPDATE sees `retained + reserved` including the first reservation, finds less than `min_start_bytes` left, and is rejected with the storage-limit message. Two concurrent requests can never both conclude the same 300 MB is available, because the check and the reservation are one atomic statement on one row.

### 4.3a The byte ceiling is enforced, not estimated

The recorder's encoder settings are **targets, not guarantees** — verified against the current source: `videoBitsPerSecond` 4/2.5/1 Mbps by quality, audio at browser default (`extension/recorder.js:262-266`; target spec pins audio to 128 kbps, `03` §6). MediaRecorder VBR can transiently overshoot its target, so no bitrate arithmetic is a hard bound. The ceiling is therefore made deterministic by three independent enforcement layers:

1. **Recorder auto-stop** (`03` §8): the upload session returns `byteCeiling = reserved_bytes`; the recorder tracks cumulative recorded bytes on every chunk (same encoder-clock pattern as the duration cap), warns at 90%, and hard-stops at `ceiling − 16 MiB` safety margin — the take is finalized and uploaded, never lost. If the ceiling is below a full-length worst case (low remaining quota), the recorder says so **before** capture: "you have storage for about N minutes".
2. **Presign refusal** (`06` §4): part URLs are signed with an exact `Content-Length` (storage rejects a mismatched PUT), and the server refuses to presign parts whose cumulative declared bytes would exceed the ceiling — a hostile client cannot push bytes past its reservation even holding valid URLs.
3. **Completion check** (`06` §7): the manifest total, verified against storage `HEAD`, must be ≤ `reserved_bytes` exactly (no tolerance factor — the ceiling is enforced, not guessed). Violation ⇒ `422 upload_manifest_invalid`, no ledger change, multipart aborted.

The "final size exceeds quota" condition is **prevented up front rather than punished after the fact**, and a legitimate 10-minute 1080p recording can never be rejected by a mis-guessed maximum (512 MiB ceiling vs ≈331 MB practical worst case, §1.1). The only residual path (a plan downgrade racing an in-flight upload) resolves via the existing `rejected_limit` 7-day grace (`06` §7.5) — user content is never silently deleted.

### 4.4 Reservation lifecycle & reconciliation

| Event | Ledger effect (all in the same transaction as the event) |
|---|---|
| Upload session created | `reserved += reservation`; `reserved_slots += 1`; reservation `held` |
| Upload completed (`06` §7) | `retained += actual_size` (from storage HEAD); `reserved −= reservation`; `reserved_slots −= 1`; `active_video_count += 1`; reservation `reconciled` |
| Upload aborted / session expired | `reserved −= reservation`; `reserved_slots −= 1`; reservation `released`/`expired` (expiry via `maintenance.upload_expiry`, `10` §3 — heals abandoned tabs and server restarts mid-upload) |
| Recording soft-deleted (confirmed) | `active_video_count −= 1`; `retained −= quota_bytes(recording)`; `pending_deletion += same` — **the user's quota is freed immediately at deletion confirmation** |
| Hard purge (30 d) | `pending_deletion −= bytes` as objects are actually removed from storage |
| Render copy / duplicate completed | `retained += new primary asset size`; `active_video_count += 1` (reservation taken at render enqueue, same mechanism) |

Nightly `maintenance.usage_sync` re-derives `retained`, `active_video_count`, and `pending_deletion` from `recordings`/`video_assets` aggregates, expires stale reservations, and logs drift > 1% (heal-drift pattern kept from `usage.service.js`, now a SQL aggregate). Crash-safety: reservations live in Postgres, tied to upload sessions — a server restart loses nothing; abandoned reservations die by `expires_at`.

### 4.5 `GET /me/usage` — dual meters (never a single blended percentage)

```json
{ "storage": { "usedBytes": 4509715660, "reservedBytes": 0, "limitBytes": 5368709120,
               "display": "4.2 GB / 5 GB" },
  "videos":  { "count": 38, "max": 50, "display": "38 / 50" },
  "recordingLimitSeconds": 600, "maxResolution": "1080p" }
```

### 4.6 UX requirements (StorageMeter/UsageMeter + recorder)

- The dashboard/billing UI shows **two separate meters** — `Storage 4.2 GB / 5 GB` and `Videos 38 / 50` — never merged into one percentage, because either can independently block recording.
- Storage-limit block message (exact copy): **“You've reached your 5 GB free storage limit. Delete a video or upgrade to continue recording.”**
- Video-limit block message (exact copy): **“You've reached your 50-video free limit. Delete a video or upgrade to continue recording.”**
- **Pre-recording warning**: the recorder's quota pre-flight (`03` §3.0) warns before capture starts when storage is near the limit (`available_bytes < plan.max_upload_bytes`, i.e. a full-length maximum-quality take may not fit — the warning includes the estimated minutes that DO fit) or when ≥ 45 of 50 videos are used: “You're close to your free limit — this may be one of your last recordings. Free up space or upgrade.”
- Every quota denial carries `meta` (`usedBytes/limitBytes/videoCount/maxVideos`) so paywall UIs render real numbers (existing UpgradeModal contract).

### 4.7 As implemented (T-306)

**Where the guard reads its inputs — and why not the counters.** During the dual-write window the legacy mirror (`dualwrite.usage` → `mirrors.upsertUsage`) and the T-106 reconciler both overwrite `storage_retained_bytes` and `active_video_count` from the legacy JSON totals, so those two columns are a legacy snapshot that erases any v1 contribution. The guarded UPDATE of §4.3 is therefore implemented **exactly as one atomic statement on the `usage` row** (which remains the per-user lock, taken with `SELECT … FOR UPDATE` first), but its retained-bytes and active-count terms are **sub-selects over the rows** rather than the counters: retained = Σ over non-deleted `recordings` of (ready quota-counting `video_assets` bytes, else `recordings.size_bytes`, else 0) — complete for imported, mirrored and v1 recordings alike, where `video_assets` alone would undercount legacy media not yet backfilled; active = non-deleted recordings whose upload has landed (`uploaded`/`processing`/`ready`) — in-flight recordings are the `reserved_video_slots`, so nothing is counted twice. `storage_reserved_bytes` / `reserved_video_slots` are touched by neither the mirror nor the reconciler and are authoritative on the row. The counters stay maintained as caches (v1 events + `usage_sync`) and are never a gate input; `/me/usage` reads the same aggregates, so the meters and the gate cannot disagree. Residual error: a legacy delete reaches PostgreSQL only on a reconciler run, which **over**-counts until then — the safe direction.

**Every parameter of the guard is cast explicitly.** Two untyped parameters compared to each other resolve as `text` in PostgreSQL; `'536870912' >= '67108864'` is false lexicographically and silently refused every real-sized reservation until the casts were added.

**The start floor for a declared size.** `min_start_bytes` refuses a *recording* of unknown size that cannot plausibly fit. A single-PUT file's size is declared, so its floor is that size: a 3 MiB clip needs 3 MiB of headroom, not 64.

**Reservation lifecycle (§4.4) — where each step lives.** Reserve: inside the transaction that inserts the session (`api/src/quota.js reserve` + `attach`). Reconcile: inside the completion transaction, after the row lock, with the HEAD size. Release: abort, an over-ceiling manifest, expiry (`maintenance.upload_expiry`), and a completion the plan re-check refuses (`rejected_limit`, source kept). A session that predates the ledger has no reservation: its bytes and count are still recorded, nothing is released below zero.

**The enforcement switch.** The §1.1 integers live in `server/plans.js` (`QUOTA_V2`) beside the legacy fields; `plans.limitsFor(plan)` returns the active set — the legacy fields unless `QUOTA_ENFORCEMENT_V2` is exactly `true`. OFF is byte-identical to today's entitlements for the v1 gate **and** the legacy `canUploadVideo`/`canCreateVideo`; ON is the notice-period flip for both paths, with the §4.6 messages. The per-recording ceiling (`max_upload_bytes`) and the floor (`min_start_bytes`) never existed before, so they apply in both modes — they cap one take, never a user's entitlement. **Grandfathering is not a stored flag**: a user already over the new cap is blocked from *new* recordings by the same guard as everyone else, and nothing they own is trimmed or deleted.

**Jobs.** `maintenance.usage_sync` (daily) and `maintenance.upload_expiry` (hourly) are plain functions in `@veorec/db` (`db/src/maintenance/*`), runnable by CLI (`db/src/cli/maintenance.js`) and, until the Phase 6 queue owns them, scheduled by the legacy in-process `server/cron.js` when the v1 stack is mounted.

### 4.8 As implemented (T-307)

**Dual meters (web).** `client/src/lib/quotaMeters.js` normalizes the v1 `GET /api/v1/me/usage` body (the same live aggregates the guard evaluates) — or, when the v1 stack does not serve the account (404 / 503 `account_not_migrated`), the legacy `/api/me/usage` summary plus the plan — into one shape: `storage.display` ("4.2 GB / 5 GB") and `videos.display` ("38 / 50", or the bare count with no cap). `useBilling().usage` is that shape. `StorageMeter` and `VideosMeter` (`components/StorageMeter.jsx`) each render their own bar and reading; `DualMeters` stacks both. The dashboard sidebar and the billing page render **both, always** — the earlier either/or sidebar and the "Videos recorded" line with no limit are gone. **No blended percentage exists anywhere** (asserted on the shape and on every component). Near-limit hint (§4.6 copy, exact) at ≥ 80% storage or ≥ max−5 videos.

**Recorder pre-flight (`03` §3.0).** `extension/quotaPreflight.js` (UMD) assesses the `/api/v1/me/usage` body before Start is accepted: **blocked** (available < `minStartBytes`, or videos + reserved slots ≥ cap) replaces Start with the exact §4.6 block message and *Manage videos* / *Upgrade* / *Check again*; **warn** (available < `maxUploadBytes`, or ≥ max−5 videos) shows the near-limit copy plus "You have storage for about N more minutes at this quality" (bytes/s per quality from §1.1's derivation) and records anyway — the take is byte-capped by its reservation; **unknown** (fetch failed, v1 off, account not migrated) proceeds — the server enforces at session creation regardless. Runs after the T-403 recovery scan and before auto-start.

**Finalize and recovery.** A quota refusal at finalize keeps the take (Save to device / *Delete a video & retry* / Upgrade — `03` §3.0); a quota verdict on the recovery card keeps Download / *Delete a video & retry* / Upgrade (`05` §6.1.3). The messages shown are the server's own (§4.6 copy under `QUOTA_ENFORCEMENT_V2`).

## 5. Paddle integration

- **Checkout**: Paddle.js overlay (MoR requirement); server provides `{priceId, clientToken, environment, customData:{userId, planSlug, billingCycle}}` (`billing.service.createCheckout` port). Environment-split credentials (`*_SANDBOX` vs production) and the `PAYMENTS_LIVE` master switch are preserved verbatim (`billing.config.js` — good design: sandbox default, cannot take money until the flag flips, webhook secret required for checkout to be considered configured).
- **Server-to-server**: cancel (at period end), resume (clear scheduled change), change-plan (proration), portal sessions, sync — ported unchanged.

## 6. Webhooks — idempotent event ledger (the fix)

`POST /api/v1/webhooks/paddle`:
1. Verify `paddle-signature` HMAC over `ts:rawBody` (timing-safe; ported from `webhooks.paddle.js:21-31`; raw-body capture stays).
2. `INSERT INTO billing_events (paddle_event_id, event_type, payload, status='received') ON CONFLICT (paddle_event_id) DO NOTHING`; conflict ⇒ `200 {ok, duplicate:true}` — **replay-proof**.
3. Process in one transaction: resolve user (custom_data.userId → known subscription/customer id, as today), apply the event to `subscriptions` + user mirror fields, mark event `processed`.
4. **Out-of-order guard (new)**: events apply only if `payload.occurred_at` ≥ the subscription row's last applied event time (stored as `subscriptions.last_event_at`); older events mark `skipped`. Fixes the late-`updated`-after-`canceled` resurrection class.
5. Processing exception ⇒ event `failed` + **HTTP 500** so Paddle retries (replacing the blind 200 at `webhooks.paddle.js:173-178`). Signature failure stays 401.

Event handling semantics preserved: created/updated/activated/resumed upsert full state; paused → status paused + drop to free; canceled → status canceled with period end; `transaction.completed` as the ordering safety net; `payment_failed` → past_due (grace via entitled statuses); customer.created/updated attaches `paddle_customer_id` by email.

## 7. Admin & comp

Admin plan grants (`manual_plan` ± expiry), subscription-record cleanup (local only, never cancels in Paddle — keep the explicit comment), plan overrides — all as today (`08` §15), now audited via `audit_logs`.

## 8. Failure modes

| Failure | Behavior |
|---|---|
| Webhook down/erroring | Paddle retries (5xx); events ledger shows failed rows; alert on failed billing_events > 0 (`19` §5) |
| Paddle API unreachable for cancel/sync | `{ok:false,error}` surfaced to UI (defensive pattern preserved); daily sync heals |
| Double checkout for same user | second `subscription.created` upserts same user row (one sub per user — unchanged product constraint) |
| Charge succeeded but webhook lost | daily `subscription_sync` + user-triggered `POST /billing/sync` reconcile from Paddle (both exist today; kept) |
| Entitlement fetch fails in recorder | cached last-known entitlement fallback (`03` §8) |
| Server restart with reservations held | reservations are Postgres rows tied to upload sessions — nothing lost; abandoned ones released by `upload_expiry` (§4.4) |
| Delete raced against an in-flight upload | both are transactions on the `usage` row — serialized by the row lock; each sees a consistent ledger |
