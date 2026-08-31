# 04 — Extension Architecture

> Target architecture for the Chrome extension (Manifest V3). The current extension's UX and file layout are largely preserved (`01` §3); this doc defines the responsibilities, message contracts, and lifecycle rules that make it reliable.

---

## 1. Manifest (target)

```jsonc
{
  "manifest_version": 3,
  "minimum_chrome_version": "116",
  "permissions": ["storage", "activeTab", "scripting", "tabs", "tabCapture"],
  "host_permissions": ["https://veorec.com/*", "https://api.veorec.com/*", "https://*.r2.cloudflarestorage.com/*"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [
    { "matches": ["https://veorec.com/*", "https://www.veorec.com/*"], "js": ["bridge.js"], "run_at": "document_idle" },
    { "matches": ["https://mail.google.com/*"], "js": ["gmail.js"], "run_at": "document_idle" }
  ],
  "web_accessible_resources": [{ "resources": ["bubble.html", "bubble.js"], "matches": ["http://*/*", "https://*/*"] }],
  "action": { "default_popup": "popup.html" }
}
```

Changes vs. current (`extension/manifest.json`):
- **Narrow `host_permissions`** from `http(s)://*/*` to the API origin + the storage upload origin (+ keep broad only if overlay injection on arbitrary pages requires it — it does: `scripting.executeScript` into arbitrary tabs needs host access, so keep `https://*/*` for that purpose but document it; `http://*/*` can be dropped except for overlay parity).
- API base URL comes from a single `config.js` module (currently hardcoded in three files: `recorder.js:1`, `popup.js:1`, `background.js:83`).
- Build step: esbuild + TypeScript; output stays plain files (no bundler magic needed for MV3 review).

## 2. Components and responsibilities

| Component | Context | Responsibilities | Must NOT |
|---|---|---|---|
| `background.js` (SW) | ephemeral | message routing; overlay (re)injection while a session is active; auth sync handling; CORS-free fetch proxy for Gmail content script | own recording state; hold anything only in memory that matters |
| `popup.html/js` | action popup | options UI; capture the user gesture (tabCapture stream id); write `recOptions`; open recorder window | talk to MediaRecorder; keep timers as truth (render from `recSession`) |
| `recorder.html/js` | popup window | **RecorderMachine** (`03`), CaptureManager, IndexedDB durability (`05`), multipart uploader (`06`), recovery UI | — (it is the owner) |
| `overlay.js` | injected per tab | toolbar (stop/pause/restart/delete), timer render from `recSession`, draw/click-highlight annotations, camera-bubble host | own state; assume it is the only instance (idempotent injection guard stays) |
| `bubble.html/js` | iframe (ext. origin) | camera preview `getUserMedia`, visibility-based acquire/release | anything else |
| `bridge.js` | veorec.com | token sync website↔extension; presence marker (`data-veorec-ext`); relay `START_RECORDING` from the web app | read page data beyond its own localStorage key |
| `gmail.js` | mail.google.com | compose-toolbar button; recordings picker via SW proxy | direct API fetches (CORS) |
| `screenshot.html/js` | popup window | unchanged screenshot capture | — |

## 3. Lifecycle rules

1. **The SW is disposable.** It re-derives everything from `chrome.storage.local` on wake (`syncFromStorage` pattern, `background.js:15-25`, stays). It must never be the only holder of a fact.
2. **The recorder window is the recording's process.** If it dies, the recording stops by definition — recovery is data-recovery (IndexedDB), not process-recovery.
3. **Overlay re-injection** on `tabs.onActivated` + `tabs.onUpdated(status==='complete')` while `recSession.state ∈ {countdown,recording,paused}` (as today). Injection into non-`http(s)` pages is skipped silently.
4. **Extension update while recording:** Chrome kills all extension contexts. Accepted risk; IndexedDB survives; next recorder launch runs recovery. Do not attempt `chrome.runtime.requestUpdateCheck` deferral games.
5. **Uninstall:** IndexedDB is wiped by Chrome — unavoidable; documented.

## 4. Auth model

- Website is the auth source. `bridge.js` mirrors `localStorage.sr_token` → `SR_AUTH_SYNC` → SW writes `chrome.storage.local.sr_token` (and clears `sr_user` so the popup refetches). Sign-out mirrors as `SR_AUTH_CLEAR`. Keep polling fallback (2s) because SPA logins don't fire the `storage` event in the same tab (`bridge.js:20-23`).
- All extension API calls send `Authorization: Bearer <sr_token>`.
- When sessions become revocable server-side (`17` §2), a 401 in any extension surface triggers `SR_AUTH_CLEAR` locally and the popup shows the sign-in panel.

## 5. Recorder window UX states

Direct render of the machine (`03` §2): options recap → permission picker → countdown (also mirrored by overlay) → recording (window stays open, un-minimized — Chrome freezes minimized windows and that stalls uploads; keep this deliberate behavior and its comment from `recorder.js:324-327`) → upload progress (% from uploader) → done (auto-open watch page) / failed (Retry / Save locally / Discard) / **recovery card** on launch when an orphaned session exists.

## 6. Typed message protocol

All runtime messages are `{ type: SrMessageType, ...payload }`. One TypeScript union is shared by all contexts (`extension/src/messages.ts`):

```ts
// Commands into the recorder machine (from overlay, popup, web via SW)
type RecorderCommand =
  | { type: 'SR_STOP' } | { type: 'SR_PAUSE' } | { type: 'SR_CANCEL' }
  | { type: 'SR_RESTART' } | { type: 'SR_RETRY_UPLOAD' };

// Recorder → world (SW relays to popup; overlay reads storage projection instead)
type RecorderNotice =
  | { type: 'SR_STATE'; session: RecSessionProjection }        // on every transition
  | { type: 'SR_UPLOAD_DONE'; url: string; recordingId: string; title: string }
  | { type: 'SR_RECORDING_RESET' };                            // failure → unstick popup UI

// Auth (bridge → SW)
type AuthMsg = { type: 'SR_AUTH_SYNC'; token: string } | { type: 'SR_AUTH_CLEAR' };

// Web app → extension (window.postMessage relayed by bridge)
type WebStart = { type: 'SR_START_RECORDING'; options?: Partial<RecOptions> };

// Gmail proxy (content script → SW → API)
type GmailList = { type: 'VEOREC_LIST_RECORDINGS' };           // response: {recordings}|{error:'not_signed_in'|string}

// Overlay control (recorder → specific tab via tabs.sendMessage)
type OverlayMsg =
  | { type: 'SR_OVERLAY_TICK'; text: string }                  // legacy; projection makes it optional
  | { type: 'SR_OVERLAY_STATE'; state: string }
  | { type: 'SR_OVERLAY_WARN'; text: string }
  | { type: 'SR_STOP_BUBBLE' };
```

Rules: senders never assume a receiver exists (all `sendMessage` wrapped, errors swallowed + logged); receivers validate `type` against the union and ignore unknown; `sendResponse` async paths return `true` (as `background.js:93`).

```ts
interface RecOptions {
  surface: 'monitor'|'window'|'browser'|'tab';
  mode: 'screen'|'tab';                 // tab = pickerless tabCapture
  tabStreamId: string|null;             // single-use, gesture-bound
  camera: 'off'|'bubble'|'only';
  bubbleSize: 'sm'|'md'|'lg';
  audio: boolean;                       // mic
  quality: 'high'|'medium'|'low';
  countdown: 0|3|5;
  bubbleTabId: number|null;
}
```

## 7. `chrome.storage.local` keys (canonical)

| Key | Writer | Readers | Notes |
|---|---|---|---|
| `sr_token`, `sr_user` | SW (auth sync), popup | all | cleared together on sign-out |
| `recOptions` | popup / SW (web start) | recorder, overlay (camera mode) | per-recording input |
| `recSession` | recorder machine only | overlay, popup, SW | projection, `03` §11 |
| `lastRecording` | recorder | popup | latest-share card |
| *(legacy)* `recording`, `recState`, `startTime`, `shareLink` | recorder (dual-write) | old code | delete in migration Phase 14 |

## 8. Camera iframe (bubble)

Keep the current design verbatim — it is clever and correct: camera runs in an extension-origin iframe so permission is granted once for the extension, not per-site (`extension/bubble.js` header comment); the iframe self-manages the device by visibility so exactly one visible tab holds the camera; hide = remove iframe = release device. The bubble is DOM, so it is recorded only when it's on the captured surface — the recorder UI must state this when the user picks `camera:'bubble'` with `surface:'window'`/different-monitor share (new warning `bubble_not_captured`, shown when the picked display surface can't contain the tab).

## 9. Annotation overlay

Draw canvas + click-ripples stay as-is (`overlay.js:139-254`) with two hardening rules: all listeners registered by the overlay are removed in `cleanupAll()` (already true — verify in review), and the overlay must remain functional after SPA navigations (it is re-injected by the SW on `status:'complete'` only for full loads; add a `history.pushState` no-op note: overlay persists across SPA routes since the document survives).

## 10. Permissions & privacy posture

- `tabCapture` used only from the popup gesture path. `activeTab`+`scripting` for overlay injection. No `webRequest`, no cookies access.
- The extension reads only its own localStorage key on veorec.com (`sr_token`) — never page content on other sites; gmail.js touches only compose DOM. This is Chrome-Web-Store review posture; keep `CHROME_STORE_SUBMISSION.md` updated with any permission change.

## 11. Failure handling (extension-specific)

| Failure | Behavior |
|---|---|
| SW killed mid-recording | Nothing lost (thin SW); overlay re-injection resumes on next SW wake event |
| `tabCapture.getMediaStreamId` throws | Popup shows "try Entire Screen" error (as today, `popup.js:229-232`) |
| Overlay injection fails (chrome:// page, store page) | Silent skip; recorder window remains the control surface |
| Recorder window closed while `uploading` | `beforeunload` warning; if forced, IndexedDB has all parts + upload session id → recovery resumes upload next launch |
| Token expired mid-upload | Uploader pauses, `SR_AUTH_CLEAR`; popup prompts sign-in; retry resumes (upload session is server-side, presigned URLs are re-mintable) |
| Two recorder windows opened | Second window detects an active session row (IndexedDB `status:'recording'` with a live heartbeat, `05` §3) and refuses with "a recording is already running" |

## 12. Build & release

- `npm run build:extension` → `dist/extension/` (esbuild, ts, copies static assets). Version stamped from one place.
- Store zips are build artifacts, **not committed** (today 16 zips/crx/pem live in the repo root — `.gitignore` already covers them; delete the tracked ones).
- Compatibility rule: the shipped extension must work against both current and next API for one release window (Chrome review delays) — hence `/api/v1` versioning and additive-only changes within a window.
