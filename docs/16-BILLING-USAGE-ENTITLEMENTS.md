# 16 — Billing, Usage & Entitlements

> The monetization layer. The existing capability-based design (`plans.js`, `entitlements.js`, `permissions.service.js`, `billing.*`, `webhooks.paddle.js`) is the best-engineered part of the current codebase and is **ported, not redesigned** — with storage moved to Postgres and webhook processing made idempotent.

---

## 1. Plans (unchanged catalog)

Code-defined catalog (`plans.js` ports to `apps/api/src/billing/plans.ts`):

| | Free | Pro ($7.99/mo, $79/yr) | Business (defined, not sold) | Enterprise (defined, not sold) |
|---|---|---|---|---|
| maxVideos | 30 | unlimited | – | – |
| storage | 20 GB (count is the binding limit) | 1 TB | 1 TB | 10 TB |
| recording length | 10 min | 600 min | 240 min | 600 min |
| export quality | 720p | 1080p | 1080p | 4k |
| branding watermark | on | off | off | off |
| features | basicSharing, transcription | + analytics, customThumbnail, removeBranding, priorityProcessing, passwordProtection, advancedSharing, aiDocs, clipStitch, leadCapture, slack | superset | superset |

**Core rule preserved:** business logic asks `plan.features.analyticsEnabled`, never `plan === 'pro'`. Billing cycle lives on the subscription, not the plan. Admin runtime overrides move from `plan_overrides.json` to the `plan_overrides` table (same whitelist of overridable fields).

## 2. Entitlement resolution (unchanged priority)

`resolveSlug(user)`: admin comp (`manual_plan`, optional expiry) → entitled subscription (`active|trialing|past_due`; canceled keeps access only until period end — note: current `subscriptions.isEntitled` returns false immediately on `canceled` ignoring `cancelAtPeriodEnd` period-end grace; **fix in port**: `canceled` with `current_period_end > now` remains entitled, matching the documented intent) → legacy stored plan field (only when no contradicting subscription) → free.

`summary(user)` (plan, planSlug, isPaid, source: comped|subscription|free, subscription snapshot) is embedded in `user.entitlements` on auth responses and served at `GET /me/entitlements` — the extension recorder consumes it for the countdown limit (`03` §8).

## 3. Server-side enforcement (unchanged shape, new authority points)

All gates return `{allowed, reason?, upgradeRequired?, meta?}` and are called server-side before privileged actions (`permissions.service` port):

| Gate | Enforced at |
|---|---|
| `canCreateVideo` (count) | upload **complete** (authoritative), upload init + recording create (advisory) |
| `canUploadVideo` (storage projection) | upload complete with real size; init with estimate |
| `canRecord` (duration, +30s grace) | **post-probe** with FFprobed duration (authoritative — client hints no longer decide, fixing the trust hole at `index.js:393`), recorder UI countdown (advisory) |
| feature gates (analytics, password, branding, aiDocs, clipStitch, leadCapture, slack, thumbnail, prioritized processing) | their endpoints, exactly as today |
Every denial writes `analytics_events(event:'paywall_hit', props:{trigger})` with the canonical trigger names (`conversion.js` TRIGGERS preserved).

**Grace on rejection (new):** an over-limit upload is kept 7 days as `rejected_limit` before purge, so upgrading rescues the recording (`06` §7.5). Billing state changes never mutate recordings (invariant #15): downgrades stop new privileges; existing videos remain.

## 4. Usage accounting

`usage` table (`07` §9): incremented/decremented **in the same transaction** as the causing event (upload complete, delete, render-copy, duplicate). Nightly `maintenance.usage_sync` re-derives from Postgres aggregates and logs drift (the heal-drift pattern from `usage.service.js`/`cron.js`, now a single SQL aggregate instead of Cloudinary listing). Monthly window rolls on read/write as today. `GET /me/usage` returns the summary shape the StorageMeter/UsageMeter components already consume.

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
