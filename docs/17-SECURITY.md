# 17 — Security

> Security architecture and hardening requirements. Current-state holes it closes are cited from `01`.

---

## 1. Authentication

- Password auth: bcrypt cost 12 (raise from 10), min length 8 (raise from 6), generic "invalid email or password" (kept), signup/login/forgot/reset rate limits (Redis-backed, same windows as today's `ratelimit.js` but multi-instance-safe).
- Google sign-in: server-side `tokeninfo` verification with `aud` check and `email_verified` guard — port `index.js:191-214` including the string-"false" gotcha.
- Password reset: single-use tokens, **stored hashed** (today plaintext in `users.json` — `index.js:239-240`), 1h expiry; successful reset revokes all sessions. Invite flow = same mechanism, 7-day expiry (as today).

## 2. Sessions

- Opaque 256-bit tokens; `sessions` table stores sha256(token); 30-day rolling expiry (`last_used_at` refresh); revocation: logout (self), password change (all others), admin (all for a user). Replaces irrevocable 30-day JWTs (`auth.js:14-16`).
- Storage: web keeps `localStorage` + bridge sync to the extension for now (product constraint: the extension needs the token and cookie flows don't cross into extension fetches cleanly). **Documented XSS exposure**: mitigated by strict CSP on the web app (§7), React's default escaping, and no third-party scripts beyond Paddle. Revisit `HttpOnly` cookie + extension-specific token exchange post-migration.
- JWT_SECRET-style boot validation extends to all secrets: env schema validation at startup; production refuses to boot with missing/placeholder secrets (pattern from `auth.js:6-12`).

## 3. Authorization

Central `authorize(actor, action, resource)` (`12` §2); admins from `users.is_admin` (env allowlist only seeds it); 404-for-unauthorized on owner resources; every admin mutation → `audit_logs`.

## 4. CORS & CSRF

- CORS: allowlist exactly `https://veorec.com`, `https://www.veorec.com`, and extension origin `chrome-extension://<prod-id>` (dev ids via env); credentials disabled (Bearer tokens). Replaces `origin:'*'` (`index.js:50`).
- CSRF: not applicable while auth is Bearer-header-only (no cookie auth). If cookie sessions are ever introduced: SameSite=Lax + double-submit token, and this section must be updated first.
- Webhooks (`/webhooks/paddle`) and presigned-URL PUTs are intentionally outside CORS concerns (server-to-server / storage-origin).

## 5. Rate limits (Redis sliding window; enumerated in `08` §1)

Auth endpoints, unlock, comments/reactions, views/progress, contact, upload-session creation, AI triggers. 429 + Retry-After. Open-fail policy: if Redis is down, auth limits **closed-fail** (deny over-threshold via local fallback limiter), engagement limits open-fail.

## 6. Upload security

- Presigned PUT URLs: 1h TTL, bound to exact key + part number + content checksum (`x-amz-checksum-crc32c`); sessions owned per user; part size/count caps (10k parts, plan-derived total size ceiling at complete).
- MIME allowlist at session creation; **authoritative validation is FFprobe** (`09` §2) — content sniffing beats extension/mime trust; probe failure quarantines the object (`failed`, never served).
- **Server-authoritative quotas:** storage usage and active-video counts are computed exclusively from server-side facts (ledger + asset rows, `16` §4); client-reported sizes/durations/counts are hints only. Quota check-and-reserve is a single atomic statement on the user's `usage` row, so concurrent sessions cannot double-spend quota; uploads are hard-capped at their reservation at complete (a hostile client cannot upload past its reserved bytes).
- The API's only multipart surface is the ≤5MB thumbnail upload (image type sniffed, re-encoded via sharp to strip metadata/polyglots).
- No SSRF surface: the API never fetches user-supplied URLs except the Slack webhook (strict `https://hooks.slack.com/services/` prefix check, kept from `index.js:156`) and Paddle/Groq/Brevo (fixed hosts).

## 7. Web app hardening

- CSP: `default-src 'self'; script-src 'self' https://cdn.paddle.com; media-src <r2/cdn origins>; img-src 'self' data: <cdn>; connect-src 'self' https://api.veorec.com <r2>; frame-src https://buy.paddle.com` (tuned during implementation; report-only first).
- Security headers: HSTS, X-Content-Type-Options, Referrer-Policy `strict-origin-when-cross-origin`, frame-ancestors `'self'` except `/embed/*` (embeddable by design).
- Embed pages: no auth state usage; only signed media of privacy-satisfying videos.

## 8. Signed URLs & share links

Per `12` §5–6: private bucket; TTL-bound signatures (10 min private / 24h public); share tokens 128-bit hashed at rest shown once; password gates bcrypt + rate-limited; revocation semantics (revoked/expired links never fall back to permissive).

## 9. Secrets & configuration

- All secrets via env (Railway/Vercel secret stores); never committed (`.gitignore` covers `.env`). T-001 verified `extension.pem`/`.crx` were **never** in git history (only stale release zips were tracked, now untracked) — no rotation forced; keep the signing key out of the repo and move signing to CI secrets when a build pipeline exists.
- Rotation runbook: JWT/session secret (sessions table makes rotation seamless), R2 keys, Paddle webhook secret (dual-secret window), Groq/Brevo keys.
- Separate R2 credentials for API (sign-only where possible) and workers (read/write).

## 10. Logging restrictions

Never log: tokens, password/hash material, full presigned URLs (log key + expiry only), webhook raw bodies at info level (debug-only, redacted), viewer emails outside owner-scoped contexts, raw IPs (store/log the daily-salted hash used for dedup, `13` §7). pino redaction paths enforced centrally (`19` §2).

## 11. Webhook verification

Paddle: HMAC `ts:rawBody`, timing-safe compare, ts freshness window (±5 min) to block replay of captured payloads (ledger dedup catches the rest — `16` §6). Slack outbound only. Any future inbound webhook must ship signature verification + event ledger from day one.

## 12. Data isolation & tenancy

Every query is scoped by `user_id`/`workspace_id` through repository methods that require the scope parameter (no "list all" without admin context). Tests enumerate cross-tenant access attempts on every owner endpoint (`20` §6). Admin endpoints double-gated (auth + is_admin) and audited.

## 13. Abuse prevention

- Signup throttling + disposable-email blocklist (config); contact form honeypot + rate limit.
- Storage abuse: plan ceilings enforced at complete; upload session count limits; orphan/incomplete-multipart cleanup (`06` §8).
- Content: DMCA/abuse report route on watch pages → `contacts` with category; admin can soft-delete + ban (revoke sessions, disable login).
- Comment spam: rate limits + owner moderation (`13` §1); links rendered non-clickable for anonymous authors.

## 14. Dependency & supply chain

Lockfiles committed; `npm audit` in CI (fail on high for server/worker); Renovate/dependabot monthly; extension bundles zero third-party runtime deps (as today — keep it that way).
