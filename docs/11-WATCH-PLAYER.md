# 11 — Watch Page & Player

> Target architecture for `/watch/:id` and the player. Keeps the current feature set (`Watch.jsx`, `VideoPlayer.jsx` — audited in `01` §6) but replaces guess-based readiness with explicit states and splits the 1,353-line god component.

---

## 1. Page states (driven by API, never by timeouts)

```mermaid
stateDiagram-v2
    [*] --> loading
    loading --> not_found : 404
    loading --> login_required : 401 login_required
    loading --> password_gate : requiresPassword
    loading --> link_expired : 403 link_expired/revoked
    loading --> email_gate : audience.requireEmail && !leadGiven && !owner
    loading --> processing : status in (uploading, uploaded, processing)
    loading --> failed : status = failed / rejected_limit
    loading --> ready : status = ready
    password_gate --> ready : unlock ok
    email_gate --> ready : lead submitted
    processing --> ready : poll status → ready
    processing --> failed : poll → failed
    failed --> processing : owner clicks Retry (reprocess)
```

- `processing` shows the real pipeline: "Uploading… / Processing your video… (transcoding 64%)" from `GET /recordings/:id/status` polled at 2s→5s backoff. **This replaces**: the 6×1.5s 404 retry loop (`Watch.jsx:494-509`) and the blind 12s `videoReady` timeout (`Watch.jsx:528-541`) — those exist only because Cloudinary's index lags; with Postgres the id resolves instantly and readiness is a fact.
- `failed` (owner view): failure explanation from `failure_code` (`18` taxonomy) + Retry button (`POST /recordings/:id/reprocess`). Viewer view: "This video isn't available yet."
- Viewers on `processing`: friendly waiting state with poster if available; auto-transitions when ready.

*(T-802 ✅: implemented in `client/src/pages/Watch.jsx` + `client/src/pages/watch/` — `stateFor(payload)` in `client/src/lib/watchApi.mjs` maps the API answer to exactly these states (`loading | ready | processing | failed | login_gate | password_gate | email_gate | link_expired | not_found | error`); `useStatusPolling` re-fetches the payload at 2 s → 5 s while processing (owners additionally read the job progress from `GET /api/v1/recordings/:id/status`); the 404 retry loop and the 12 s timeout are deleted — the legacy readiness overlay survives only for `rec.source === 'legacy'` recordings served by the untouched legacy API. The page asks `GET /api/client-config/public` which API to use (`V1_WATCH_PAGE`, default OFF); on the v1 path an id the v1 API does not know (a legacy recording not yet backfilled) falls back to the legacy API once — two requests, never a loop.)*

## 2. Media resolution

`GET /watch/:id/media` → `{status, mp4Url, hlsUrl, posterUrl, captionsUrl, expiresAt, ttlSeconds, download}` (signed URLs, `12` §5; null for what does not exist yet). *(T-801: delivered; gated recordings receive an `hlsUrl` that already carries its playlist token, so the player passes it to hls.js unchanged; the unlock/lead **access token** from `/unlock` or `/lead` must be sent as `X-Watch-Access` on every later call and kept in `sessionStorage` per recording.)* The player:

- Prefers **HLS** when `hlsUrl` present (hls.js; Safari native). Falls back to MP4 on HLS fatal errors (see §5).
- MP4 has `+faststart` → native seeking works; **delete** the Infinity-duration workaround (`VideoPlayer.jsx:44-47`) once all legacy WebM assets are re-transcoded (keep it guarded behind `src.endsWith('.webm')` during migration).
- URL refresh: re-request `/media` when `expiresAt - now < 60s` (timer) and on player `error` with a 403-shaped failure; seamless `src` swap preserving `currentTime`.
- Download button (if `audience.download`): `/media?disposition=attachment` variant → signed URL with `response-content-disposition` (replaces Cloudinary `fl_attachment`, `Watch.jsx:652-654`). *(T-802: `useWatchMedia` requests `/media` once the page is ready and re-requests it 60 s before `expiresAt`; the player swaps `src` seamlessly (currentTime + play state restored). A 403-shaped playback failure asks for one refresh; the second failure shows the error UI. `fl_attachment` lives only in the legacy media resolver.)*

## 3. Player component (kept + hardened)

Keep `VideoPlayer.jsx`'s custom controls, and:

| Feature | Spec |
|---|---|
| Virtual trim/segments | unchanged skip logic (segments keep-ranges; trimStart/trimEnd) — runs on top of MP4/HLS identically |
| Timeline markers | comments/reactions at `t`; click → seek (unchanged) |
| Captions | prefer native `<track src=captionsUrl kind=captions>`; fall back to the JS overlay for segment data without a VTT asset |
| Chapters | chapter list + progress-bar tick marks (data: `recordings.chapters`) |
| Speed | 0.5–2×, `recommendedSpeed` applied on load (unchanged) |
| Keyboard | Space/K play-pause, ←/→ ±5s, J/L ±10s, ↑/↓ volume, M mute, F fullscreen, C captions, 0–9 percent-seek, Shift+</> speed. Bound on the player container, ignored when typing in inputs *(T-802 ✅ all of these, verified in the browser)* |
| Buffering | `waiting`/`stalled` events → spinner ≥ 500ms debounce; `progress` drives a buffered-ranges bar |
| Errors | `error` event → map `MediaError.code` (see §5) |
| Watermark | `branding` flag as today |
| Responsive | player column collapses above sidebar < 1024px; controls touch-targets ≥ 40px; fullscreen uses native API |

## 4. Watch page decomposition

```
WatchPage (data orchestration: watch payload, status polling, media urls)
├── ProcessingPanel | FailedPanel | Gates (login/password/email/link-expired)
├── PlayerSection (VideoPlayer + reactions bar + CTA)
└── Sidebar
    ├── ActivityTab (comments list/form, reactions feed)   — viewers' default
    ├── TranscriptTab (search, follow-along highlight, translate dropdown)
    ├── EditTab (owner: rename, AI title/summary/chapters, remove silences, combine, open editor)
    └── SettingsTab (owner: privacy, audience toggles, speed, thumbnail, archive, folder, share links)
```
Each tab loads its own data lazily (transcript already lazy today — keep). Owner detection: `GET /recordings/:id` 200 (as today) but returned as an explicit `isOwner` field on the watch payload when authed, saving a request. *(T-802: `WatchPage` = `Watch.jsx` (orchestration + the tabs), `watch/Panels.jsx` (Processing/Failed/NotFound/Loading panels, Login/Password/Email/LinkExpired gates, PlaybackError), `watch/useWatchMedia.js`, `watch/useStatusPolling.js`, `components/Toast.jsx` (the `alert()` replacement). Owner detection is `viewer.isOwner` on the v1 payload; the legacy probe remains for legacy rows. Owner writes follow the source (`/api/v1/recordings/:id` and `/meta`, async 202 AI actions polled to completion); the tab split into separate files is left for Phase 13 — the panels are already isolated render blocks.)*

## 5. Playback error handling

| Condition | Detection | Response |
|---|---|---|
| Expired signed URL | 403 on segment/mp4 fetch → hls.js network fatal / MediaError network | refresh `/media`, resume at `currentTime`; 1 automatic retry, then error UI |
| Network loss | repeated network errors | "Connection lost — retrying…" banner; auto-retry with backoff; resume position |
| Decode error | MediaError.MEDIA_ERR_DECODE / hls.js media fatal | HLS→MP4 fallback once; else error UI + report to error tracking with recordingId/assetId |
| 404 asset (deleted mid-watch) | fetch 404 | "This video was removed" state |
| Autoplay blocked | `play()` rejection | show big-play button (muted-autoplay attempt first) |

## 6. Engagement & analytics behavior (server contracts in `08` §7,9)

- View counted once per viewer-key via `view_sessions` upsert; owner never counted (`is_owner`) — semantics preserved from `index.js:691-714` but by user id, not display name.
- Progress: `timeupdate` tracks `maxFrac`; report via `sendBeacon` on `visibilitychange:hidden` + `pagehide` + unmount (keep `Watch.jsx:550-565` logic), now upserting `view_sessions.max_progress` (idempotent, monotonic max on server).
- Reactions/comments optimistic-update with rollback on error; forms disabled when `audience.*` is false.

*(T-802 scope note: the engagement routes have no v1 implementation until Phase 10, so views/comments/reactions/progress keep using the legacy API for legacy recordings and are hidden (with a note) on v1 recordings rather than pointed at routes that do not exist. Views on a v1 recording come from the payload.)*

## 7. Embed (`/embed/:id`)

Same media/state machinery, chrome-less player, no sidebar; `postMessage` resize events optional. Embed respects privacy exactly like watch (an unlisted/public video embeds; login/password-protected shows the gate message with a link out). *(T-802 ✅: `client/src/pages/Embed.jsx` shares `watchApi.mjs`, the hooks and `VideoPlayer`.)*

## 8. SEO/meta

Watch pages render `og:title`, `og:video`, `og:image` (poster URL — public/unlisted only). Private videos emit no media meta tags. *(T-802: `document.title` + `og:title`/`og:type` always, `og:image` only for public/unlisted — set client-side; server-side rendering of the tags for crawlers is Phase 13.)*
