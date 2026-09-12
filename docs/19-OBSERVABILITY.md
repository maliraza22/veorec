# 19 — Observability

> Logging, metrics, tracing, dashboards, alerts. Current state: `console.log`/`console.error` only, no request ids, no metrics (`01` §9). Target: every user-visible incident is diagnosable from logs+metrics without reproducing it.

---

## 1. Correlation IDs

| ID | Minted by | Propagated to |
|---|---|---|
| `request_id` (`req_`) | API middleware (or inbound `X-Request-Id`) | every log line in the request, error responses, audit logs |
| `recording_id` | recording create | client logs, API logs, job payloads, worker logs, storage keys |
| `upload_id` | upload session create | recorder logs, part PUT logs (client-side breadcrumb), API |
| `job_id` (`job_`) | processing_jobs | worker logs, BullMQ jobId, admin UI |
| `session_id` (local) | recorder IndexedDB session | extension logs, recovery reports |
Rule: any log line about a recording/upload/job includes its id as a structured field, never interpolated into the message.

## 2. Structured logging (pino)

> Implemented for the legacy server in **T-002** (`server/log.js`): request-id middleware + per-request completion lines + optional Sentry. Config env: `LOG_LEVEL` (default info in prod, debug in dev), `LOG_PRETTY=false` to force JSON in dev, `SENTRY_DSN` / `SENTRY_ENVIRONMENT` / `SENTRY_RELEASE` (all optional — absent DSN disables Sentry cleanly). Legacy `console.*` calls inside route handlers remain until their subsystems migrate. **T-003** added log-derived baseline KPI events on top (`server/kpi.js`: `upload_started/finished`, `watch_404_retry`, `watch_recovered_after_404`, `kpi_snapshot`) — schema and analysis rules in `docs/BASELINE.md`.

- JSON lines; fields: `ts, level, msg, service (api|worker|web|ext), env, request_id?, user_id?, recording_id?, upload_id?, job_id?, code?, duration_ms?`.
- Redaction paths enforced (`17` §10): authorization headers, tokens, presigned query strings, emails outside owner scope, raw IPs.
- Levels: `error` = actionable defect; `warn` = degraded/fallback taken (e.g. whisper.cpp fallback, poster placeholder); `info` = domain events (recording ready, upload completed, job finished w/ duration); `debug` = dev only.
- API access log: one line per request (method, path template, status, duration, user_id) — path templates, not raw paths (no ids in metric labels).
- Worker: job start/finish/fail lines with attempt number, duration, and for ffmpeg failures the stderr tail (≤2KB). *(T-601: `service=worker`; `job started` / `job completed` / `job failed (terminal)` (error) / `job failed — will retry with backoff` (warn) carry `job_id`, `queue`, `recording_id`, `attempt`, `max_attempts`, `duration_ms`, `code`; the relay logs `job relayed to transport` and the reconciler warns `queued job missing from transport — re-enqueued` / `active job lost by transport — returned to queued`; the stderr tail lands in `processing_jobs.last_error`. Same redaction paths as the API logger.)*
- Extension: ring buffer (last 500 events) in the recorder window; attached to error reports and exportable from a debug panel ("Copy diagnostics") — crucial for remote-debugging recorder issues.

## 3. Metrics (Prometheus-style; hosted equivalent fine)

**API**: `http_requests_total{route,method,status}`, `http_request_duration_seconds` (histogram), `rate_limited_total{limiter}`.
**Upload**: `upload_sessions_created_total`, `upload_sessions_completed_total`, `upload_sessions_expired_total`, `upload_parts_recorded_total`, `upload_complete_duration_seconds`, `upload_bytes_total`.
**Quota**: `quota_reservations_total{result=granted|storage_limit|video_limit}`, `quota_reserved_bytes` (gauge), `quota_ledger_drift_bytes` (from usage_sync), `quota_blocked_users` (gauge — free users at either cap; also a paywall-conversion signal).
**Dual-write (T-105, migration window only)**: `dualWriteAttempt/Success/Failure/Retryable` counters in the KPI snapshot as `dualWrite{attempts, successRatePct, failures, retryableFailures, reconciliationPending}`. Alert if `successRatePct` drops below 95% or `reconciliationPending` grows steadily — the response to either is `PG_DUAL_WRITE=false` (legacy is unaffected) followed by a reconciling import.
**Pipeline**: `jobs_enqueued/completed/failed_total{queue}`, `job_duration_seconds{queue}` (histogram), `job_attempts` on completion, `queue_depth{queue}` (gauge), `recordings_ready_total`, `time_to_ready_seconds` (upload-complete → ready; the product's core latency).
**Playback**: `media_url_minted_total{privacy}`, watch API latency; client beacons for `player_error_total{code}` (sampled).
**STT/AI**: `groq_requests_total{kind,status}`, `stt_job_duration_seconds`, fallback counter. *(T-603: per-run counts live on the job row — `processing_jobs.result.stats = {groqCalls, groq429, groqErrors, chunkSkips, chunks, forced, fallback}` — and in the `transcript stored` log line; the queue's `job_duration_seconds` covers the job.)*
**Billing**: `billing_events_total{type,status}`, `billing_events_failed_total`.
**Infra**: DB pool saturation, Redis latency, worker scratch disk free, R2 error rate.

## 4. Dashboards

1. **Recording funnel** (the money dashboard): sessions started (client beacon) → uploads created → completed → ready; drop-off % per stage; time-to-ready p50/p95.
2. **Pipeline health**: queue depths, failure rates per queue, retry counts, oldest queued job age.
3. **API**: RPS, p95 latency per route group, error rate, 429s.
4. **Playback**: media mints, player error rate, watch loads.
5. **Business** (existing admin dashboard keeps its P&L view; ops version adds storage bytes, egress est., Groq spend proxy).

## 5. Alerts (page vs notify)

| Alert | Threshold | Severity |
|---|---|---|
| Upload completion success rate | < 95% over 15m | page |
| `time_to_ready` p95 | > 10 min over 30m | page |
| Failed jobs | any `media.*` failure streak > 5 in 15m; any `billing_events.failed` > 0 | page / page |
| Queue depth | media queue > 50 for 15m or oldest job > 30m | notify |
| API 5xx rate | > 2% over 10m | page |
| DB/Redis/R2 availability probes | fail 3× | page |
| Cert/domain, disk (worker scratch > 85%) | — | notify |
| Webhook signature failures | > 5/h (attack or misconfig) | notify |

## 6. Error reporting

Sentry (or GlitchTip): API + workers (release-tagged), web app (source maps, user_id tag, requestId breadcrumb), extension (manual capture → API relay endpoint `/client-errors`, since CSP/store rules complicate direct SDKs; payload = ring buffer + machine state + code). All error-tracking payloads follow the redaction rules.

## 7. Production KPIs (reviewed weekly)

- Recording success rate: recordings reaching `ready` / recordings started (target ≥ 99%).
- Recovery effectiveness: recovered sessions uploaded / crash-interrupted sessions (target ≥ 90%). **As implemented (T-403):** the extension tags every resumed upload with `X-VeoRec-Recovery: 1`; the server counts `recoveryAttempt` / `recoverySuccess` / `recoveryFailure` from those upload lines (`recovery:true`) and reports `kpi_snapshot.recovery.effectivenessPct` = successes / attempts. The denominator in the definition above (crash-interrupted sessions found at launch) is client-side and not visible to the server; the recovery card publishes its count to the popup badge.
- Time-to-ready p50/p95 (target: p50 < 60s for a 5-min recording).
- Upload resume rate (resumes that succeed without re-uploading completed parts).
- Player error rate per watch session (< 0.5%).
- STT success rate & median latency; AI auto-title coverage.
- Webhook processing lag & failure count (0 tolerated).
- Storage growth vs usage-table sum drift (< 1%).
## 8. Cutover telemetry (T-304) — how the upload rollout is measured

Every upload event carries the path it actually took, and every routing decision is
logged. Without the path tag, a v1 failure and a legacy failure are the same line, and
the acceptance criterion cannot be computed at all.

**Log fields** (added to the existing `upload_started` / `upload_finished` lines):

| Field | Values | Meaning |
|---|---|---|
| `upload_path` | `legacy` \| `v1` | the path this take used. Recorded on the attempt **and re-stated on the result**, because a take can change path mid-flight |
| `fallback_from` | `v1` \| `null` | the take started toward v1 and finished on legacy |

**`rollout_decision`** — one line per `/client-config` lookup:
`{ kpi:"rollout_decision", upload_path, decision, bucket, percent }` where `decision` is
exactly one of:

| `decision` | Meaning |
|---|---|
| `legacy_disabled` | v1 is off, or the rollout is at 0% — includes every rollback |
| `legacy_rollout` | rollout is live; this user's bucket is outside the percentage |
| `v1_rollout` | selected for the new path |
| `account_not_migrated` | selected by bucket, but the account has **no PostgreSQL mirror**, so v1 could not have served it |

The decision line deliberately carries **no user identifier**. The bucket and the reason
are what an operator needs; the identity is neither needed nor safe to retain here.

### 8.1 The acceptance number and its denominator

`kpi_snapshot.cutover.v1SuccessRatePct` **is** the number the ≥99% criterion is measured
against:

```
v1SuccessRatePct = uploadV1Success / uploadV1Attempt × 100
```

The denominator is **attempts, not completions**, and a take that started on v1 and was
rescued onto legacy counts in `uploadV1Failure` as well as `uploadV1Fallback`. This is
the whole point: the fallback exists so users never see a failure, which means a naive
rate would read 100% *precisely because* the failures were being hidden. A rising
`v1Fallbacks` with a flat success rate is the signal that the new path is degrading.

`accountNotMigrated` is reported as its own number and never folded into the ordinary
legacy count — it is a known, fixable population (run the importer), and pooling it with
users the rollout simply did not select would make it invisible.

### 8.2 What "verified" means for this criterion

The ≥99%-over-two-weeks criterion can only be satisfied by **production traffic**
observed over two consecutive weeks at a non-zero rollout percentage. Local, staging and
synthetic runs verify that the mechanism works; they do **not** and cannot satisfy it,
however many assertions pass. Until that production window exists and has been read off
real snapshots, the correct status is *production observation pending*.
### 8.3 Web upload gate and deprecation signals (T-305)

**`web_upload_decision`** — one line per `/client-config` lookup, for the web editor's
gate. Its own line and its own counters (`webUploadV1Selected`, `webUploadLegacySelected`,
`webUploadAccountNotMigrated`) — never mixed into the extension's `rollout_decision`
numbers, which have their own acceptance criterion. `decision` is one of
`web_legacy_disabled` (gate off — includes every rollback), `web_v1_enabled`, or
`account_not_migrated`. No user identifier; there is no bucket to report.

**`upload_mode`** — added to `upload_started` / `upload_finished`: `single` (web, T-305),
`multipart` (extension, T-303) or `null` (legacy). Web single-PUT uploads are counted in
the pooled v1 counters **and** in their own slice (`uploadV1SingleAttempt/Success/Failure`),
surfaced as `kpi_snapshot.cutover.web` with `singleSuccessRatePct`, so the extension
gate is never judged on web traffic and the overall v1 rate stays a true total. A web
upload rescued onto legacy carries `fallback_from:"v1"` and counts as a v1 failure, as in
§8.1 — the client permits that rescue **only before** a v1 session exists.

**`deprecated_replace_used`** — a `warn`-level line each time the memory-multer
`POST /api/recordings/:id/replace` is used, with `deprecated:true`, the replacement
(`v1 single-PUT upload`) and the removal phase (`Phase 14`). Counter `legacyReplaceUsed`,
surfaced as `kpi_snapshot.deprecations.legacyReplaceUsed`. **This number is the Phase 14
gate**: the route may be deleted only once it has stayed at zero over a full observation
window. Sizes and the mode are recorded; never bytes, never identity.
