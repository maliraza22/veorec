# 13 — Comments, Reactions & Analytics

> Engagement subsystem. Data model in `07` §5, endpoints in `08` §7/§9. This doc fixes semantics that are currently name-string-based and lossy (`01` §4).

---

## 1. Timestamped comments

- Comment: `{id, recordingId, parentId?, userId?, authorName, body ≤2000, t?}`; `t` = seconds into the video (nullable = general comment).
- **Replies**: one level (`parentId` must reference a root comment; deeper nesting rejected 400 `comment_depth`). UI renders root + indented replies.
- Anonymous commenting allowed when `audience.comments=true` (product decision preserved); `authorName` from the form; signed-in users always use their account name and get `userId` set. Analytics/notifications distinguish **verified** (userId) from unverified names.
- Moderation: recording owner can delete any comment on their recording (soft `deleted_at`, renders as "removed"); authors can delete their own (signed-in only).
- Timeline markers: comments with `t` render on the progress bar (unchanged UX).
- Rate limits: 30/min·IP + 200/day·IP per recording; body sanitized (plain text, links auto-linked client-side only). *(T-1001 ✅: everything above except the 200/day·IP window — the per-process fixed-window limiter (`api/src/rate-limit.js`) has one window per route class; the daily cap lands with the Redis limiter, T-1304. Comments and reactions write to PostgreSQL only — no JSON store, no dual-write — through the shared watch authorisation (`api/src/watch-context.js`), so privacy and share links gate engagement exactly like playback.)*

## 2. Reactions

- `{emoji ∈ curated set + any grapheme ≤8 chars, t?, userId?, authorName?}` — appended events, never a tally (legacy tally objects migrate to rows, `07` §5).
- Same audience gating (`audience.reactions`) and rate limits as comments.
- Aggregations (counts per emoji, markers at `t`) are computed in queries/views, not stored.

## 3. Viewer sessions & watch progress

`view_sessions` (one row per unique viewer per recording — `07` §5):
- `viewer_key` precedence: signed-in user id → client `visitorId` (localStorage uuid, as today `Watch.jsx:18-24`) → salted hash of IP. Key precedence preserved from `index.js:691-695`.
- `is_owner=true` rows are recorded (so owners see their own testing) but excluded from every count — **owner-view exclusion is by user id**, replacing display-name comparison (`index.js:889` bug class: two viewers named "Alex", owner renamed, etc.).
- Progress beacons upsert `max_progress = greatest(existing, incoming)`; `completed = max_progress ≥ 0.9` (same threshold as `index.js:736`).
- View definition: a `view_sessions` row exists ⇒ 1 unique view. `views` displayed = `count(*) where not is_owner`.

## 4. Analytics events

Append-only `analytics_events` for funnel/behavior facts: `view, play, progress_25/50/75/complete, reaction, comment, share_copy, share_slack, lead, paywall_hit, checkout_open`. Paywall triggers keep the canonical names from `conversion.js` (`storage_limit_reached`, `recording_over_limit`, `analytics_attempted`, …) so historical comparisons survive migration. *(T-1003 ✅ `api/src/paywall.js`: every v1 `403 feature_locked` and every plan-limit refusal (`storage_limit`, `video_limit`, `recording_limit` — recorded after the reservation transaction rolled back, so the fact survives it) writes one `paywall_hit` with `props.trigger` = the legacy name (`analytics_attempted`, `password_protection_attempted`, `remove_branding_attempted`, `advanced_sharing_attempted`, `transcription_attempted`, `ai_docs_attempted`, `storage_limit_reached`, `recording_over_limit`, `video_limit_reached`) plus `feature`, attributed to the user and recording. `view`, `comment`, `reaction` land with T-1001.)*

## 5. Owner analytics (Pro-gated, `analyticsEnabled`)

Per recording (`GET /recordings/:id/analytics`):
- `views` (unique, non-owner), `viewers[]` (name/email for signed-in, "Anonymous (Chrome, DE)" style for others; last seen; max progress per viewer),
- `engagement`: avgViewThrough = avg(max_progress), completionRate = share(completed), samples = count — same numbers the current UI shows, now per-viewer-accurate instead of `{sum,n}` blobs,
- **retention curve** (new, cheap now): histogram of max_progress deciles, *(T-1002 ✅ — `viewSessions.retentionForOwner`: one `generate_series(0,9)` query counting viewers with `max_progress ≥ d/10`)*
- reactions/comments/leads lists.
Workspace-level rollups on `/analytics/overview` (totals per recording, 30-day trend from `analytics_events`).

## 6. Notifications feed

Query-derived (no feed table): union of comments, reactions, view_sessions newer than `notification_reads.last_read_at`, on the owner's recordings, excluding events where `actor user_id = owner` (unverified anonymous events are included — they are genuine viewer activity). Ordered desc, limit 50. The current O(all-meta) scan (`index.js:875-918`) becomes three indexed queries. *(T-803 ✅ `db/src/repositories/notifications.repo.js` — `feedForOwner` returns the newest 50 across the three sources (each query capped, merged in memory) so the bell can show recent read items too; `unread` is computed against the read marker in the router. An anonymous commenter who happens to share the owner's display name is correctly kept — exclusion is by user id only.)*

## 7. Privacy considerations

- IPs are never stored raw: `ip_hash = sha256(ip + daily_salt)` for view dedup; salt rotates daily so hashes aren't long-term identifiers.
- Viewer emails appear in owner analytics only from **signed-in** viewers or explicit lead capture (as today) — never inferred.
- Lead data (emails) export/delete honored with recording deletion (cascade).
- `visitorId` is first-party localStorage only; no cross-site tracking; documented in the privacy policy page.
- Owner-view exclusion means owners can't inflate their own counts; admin metrics count distinct viewers, not raw hits.
- Anonymous comment `authorName` is rendered escaped everywhere (XSS — already escaped by React; server also strips control chars).
