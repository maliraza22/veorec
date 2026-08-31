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

- JSON lines; fields: `ts, level, msg, service (api|worker|web|ext), env, request_id?, user_id?, recording_id?, upload_id?, job_id?, code?, duration_ms?`.
- Redaction paths enforced (`17` §10): authorization headers, tokens, presigned query strings, emails outside owner scope, raw IPs.
- Levels: `error` = actionable defect; `warn` = degraded/fallback taken (e.g. whisper.cpp fallback, poster placeholder); `info` = domain events (recording ready, upload completed, job finished w/ duration); `debug` = dev only.
- API access log: one line per request (method, path template, status, duration, user_id) — path templates, not raw paths (no ids in metric labels).
- Worker: job start/finish/fail lines with attempt number, duration, and for ffmpeg failures the stderr tail (≤2KB).
- Extension: ring buffer (last 500 events) in the recorder window; attached to error reports and exportable from a debug panel ("Copy diagnostics") — crucial for remote-debugging recorder issues.

## 3. Metrics (Prometheus-style; hosted equivalent fine)

**API**: `http_requests_total{route,method,status}`, `http_request_duration_seconds` (histogram), `rate_limited_total{limiter}`.
**Upload**: `upload_sessions_created_total`, `upload_sessions_completed_total`, `upload_sessions_expired_total`, `upload_parts_recorded_total`, `upload_complete_duration_seconds`, `upload_bytes_total`.
**Pipeline**: `jobs_enqueued/completed/failed_total{queue}`, `job_duration_seconds{queue}` (histogram), `job_attempts` on completion, `queue_depth{queue}` (gauge), `recordings_ready_total`, `time_to_ready_seconds` (upload-complete → ready; the product's core latency).
**Playback**: `media_url_minted_total{privacy}`, watch API latency; client beacons for `player_error_total{code}` (sampled).
**STT/AI**: `groq_requests_total{kind,status}`, `stt_job_duration_seconds`, fallback counter.
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
- Recovery effectiveness: recovered sessions uploaded / crash-interrupted sessions (target ≥ 90%).
- Time-to-ready p50/p95 (target: p50 < 60s for a 5-min recording).
- Upload resume rate (resumes that succeed without re-uploading completed parts).
- Player error rate per watch session (< 0.5%).
- STT success rate & median latency; AI auto-title coverage.
- Webhook processing lag & failure count (0 tolerated).
- Storage growth vs usage-table sum drift (< 1%).
