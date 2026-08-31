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
free.upload_reservation_bytes       = 330_000_000        // worst case: 600 s × 550,000 B/s (§4.3)

pro.max_active_videos               = null               // unlimited
pro.max_storage_bytes               = 1_099_511_627_776  // 1 TiB
pro.max_recording_duration_seconds  = 36_000             // 600 min
pro.max_resolution                  = { width: 1920, height: 1080 }
pro.upload_reservation_bytes        = 5_368_709_120      // 5 GiB flat reservation
```

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
available_bytes = plan.max_storage_bytes − retained − reserved
available_slots = plan.max_active_videos − active_video_count − reserved_video_slots   (null plan cap ⇒ ∞)
```
A new recording/upload is allowed iff `available_bytes ≥ plan.upload_reservation_bytes` **and** `available_slots ≥ 1`. The two limits are independent; either alone blocks.

### 4.3 Atomic check-and-reserve (race-condition prevention)

Reservation happens at **upload-session creation** (`06` §3), inside the same transaction that inserts the session, as a single guarded UPDATE on the user's `usage` row (the row acts as the per-user lock):

```sql
UPDATE usage SET
  storage_reserved_bytes = storage_reserved_bytes + :reserve,
  reserved_video_slots   = reserved_video_slots + 1
WHERE user_id = :uid
  AND storage_retained_bytes + storage_reserved_bytes + :reserve <= :max_storage_bytes
  AND (:max_active_videos IS NULL
       OR active_video_count + reserved_video_slots + 1 <= :max_active_videos)
RETURNING *;
```
Zero rows updated ⇒ 403 `storage_limit` or `video_limit` (whichever guard failed — checked in that order and reported precisely). A `storage_reservations` row records `{user_id, upload_session_id, reserved_bytes, status:'held', expires_at}`.

`:reserve = plan.upload_reservation_bytes` — the server-computed worst case for a maximum-length recording at the recorder's bitrate ceiling (never a client estimate). This makes the two-tabs race impossible by construction: with 4.7 GB retained of 5 GB, the first tab's reservation either fits or is rejected; the second tab's guarded UPDATE sees `retained + reserved` including the first reservation and is rejected with the storage-limit message. Two concurrent requests can never both conclude the same 300 MB is available, because the check and the reservation are one atomic statement on one row.

Uploads are also hard-capped server-side: `complete` rejects a manifest whose total exceeds `reserved_bytes` × 1.05 (tolerance for container overhead) with `upload_manifest_invalid` — a client cannot upload past its reservation. Because reservation covers the worst case, the "final size exceeds quota" condition is **prevented up front rather than punished after the fact**; the only residual path (a plan downgrade racing an in-flight upload) resolves via the existing `rejected_limit` 7-day grace (`06` §7.5) — user content is never silently deleted.

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
- **Pre-recording warning**: the recorder's quota pre-flight (`03` §3.0) warns before capture starts when storage is near the limit (`available_bytes < 2 × upload_reservation_bytes`, i.e. < 660 MB free) or when ≥ 45 of 50 videos are used: “You're close to your free limit — this may be one of your last recordings. Free up space or upgrade.”
- Every quota denial carries `meta` (`usedBytes/limitBytes/videoCount/maxVideos`) so paywall UIs render real numbers (existing UpgradeModal contract).

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
