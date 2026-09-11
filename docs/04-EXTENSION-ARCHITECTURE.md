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

Direct render of the machine (`03` §2): options recap → permission picker → countdown (also mirrored by overlay) → recording (window stays open, un-minimized — Chrome freezes minimized windows and that stalls uploads; keep this deliberate behavior and its comment from `recorder.js:324-327`) → upload progress (% from uploader) → done (auto-open watch page) / failed (Retry / Save locally / Discard) / **recovery card** on launch when an orphaned session exists. Delivered by T-503 (§5.6).

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
| `recSession` | recorder machine only (T-503 `publish` effect) | overlay, popup, SW | projection, `03` §11; overlays still read the mirrored legacy keys until Phase 14 |
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

---

### 5.1 Streaming uploader (delivered by T-303)

`extension/uploader.js` uploads a recording to object storage **in parts, while
it is still being recorded**. By the time the user hits Stop, usually only the
final part and the completion call remain.

That is the reliability win. Today the whole file is POSTed through the server
*after* recording ends, so a 40-minute take is one 500 MB request that a flaky
connection can lose completely — and the user only finds out at the end.

**File name.** The plan names this `uploader.ts`. The extension is plain MV3
JavaScript with no TypeScript toolchain and no build step; introducing one would
change how every other extension file ships. Same module, JSDoc types.

**Wiring — alongside, never instead of.** Gated by the **server's** rollout
decision (`GET /api/client-config`, `08` §14a), fetched fresh at the start of
every recording and cached nothing between takes, so a rollback reaches a client
on its next take. Any failure — offline, 5xx, malformed body, anything but an
explicit `path:"v1"` — leaves the legacy path in charge. T-303 originally gated
this on a `newUpload` flag in `chrome.storage.local`; **T-304 removed it**, because
a client-side flag would let a client opt itself into the rollout, and keeping
both gates would have made a staged rollout either impossible (AND) or
unenforceable (OR):

- `ondataavailable` still pushes every chunk into the legacy `chunks` array, so
  the save-to-device fallback and the legacy POST remain fully available;
- the same chunk is additionally fed to the uploader, wrapped so an uploader
  fault can never interrupt the recording;
- at Stop, if the streaming upload finished, the legacy POST is skipped; if it
  did not, the recorder falls through to the legacy POST with the blob it still
  holds.

**A take is therefore never lost to the new path** — the worst case is the
behaviour users have today.

**Part buffering.** Chunks accumulate until `partSize` (8 MiB), then seal —
including the chunk that crosses the boundary, because `06` §5 seals at
**≥** partSize. Stopping short would make a non-final part smaller than
partSize and risk S3's 5 MiB floor. The final part may be any size.

**Concurrency** is 2 parallel PUTs while recording — leaving bandwidth for the
meeting being recorded — and 4 after Stop.

**Retry classifier.** The distinctions decide whether a recording survives a bad
network:

| Signal | Outcome |
|---|---|
| network error, timeout, 5xx, 429 | **retry** with exponential full jitter, 8 attempts |
| 403 with an *expired signature* | **re-mint the URL** — not a data attempt |
| any other 4xx | **fatal** — a verdict retrying cannot change |
| 8 attempts exhausted | **stalled**, not failed: session and bytes survive, whole drain retried every 60s |

A fatal verdict is never downgraded to `stalled`; `stalled` means "we will
retry", and masking one as the other would make the UI retry a plan rejection
forever.

**Byte ceiling.** The recorder is warned at 90% and told to stop at
`ceiling − 16 MiB`, so the final part still fits. A presign refused for
exceeding the ceiling is fatal, not retried.

**Resume diff** (`06` §10). `GET /uploads/:id` is the source of truth and the
**server wins**: a part it already has is *adopted* rather than re-sent, so no
completed byte is uploaded twice; a part it lacks is re-queued.

**Checksums.** CRC32C (Castagnoli) per part, sent with the part record.
Storage-side verification additionally needs the presign to carry
`x-amz-checksum-crc32c`, which is a T-301 addition and is **not** done here.

**Deliberately not T-303:** no IndexedDB durability (Phase 4 / `05`), no
recorder state-machine rewrite, no web upload path (T-305), no cutover flag
plumbing or telemetry (T-304), no legacy route change. The flag is off and no
client ships it enabled.


### 5.2 RecorderStore (delivered by T-401)

`extension/recorderStore.js` (UMD, global `VeoRecRecorderStore`) is the local
recovery database of `05` §2–§5, §7: sessions with the 15 s heartbeat, chunks
written in arrival order on a per-session queue, part bookkeeping with the
etag as the durable proof, prune-only-under-pressure, atomic session deletion
and 7-day GC. It stores what it is told and returns it in order — no network,
no `chrome.*`, nothing of the uploader. **Wired by T-402:** `recorder.html` loads it before `uploader.js`; the local
session is created with the actual `MediaRecorder.mimeType` before the first
chunk; every `dataavailable` chunk is persisted FIRST (fire-and-ordered, never
awaited), then pushed to the legacy array, then fed to the uploader; a 5 s
heartbeat runs while recording; server linkage (`recordingId`,
`uploadSessionId`, `partSize`) is written as soon as `begin()` returns; sealed
parts are recorded `pending` before their PUT and get their etag on upload;
`PERSIST_FAILED` is shown once as a banner and recording continues (quota
pressure prunes chunks covered by verified parts while the uploader is alive);
the session is marked `stopped` → `uploading` at finalize and **deleted only
after the server confirmed completion** (both the v1 and the legacy path); a
failed upload marks it `failed` and keeps it; cancel/restart discard it and
abort the server session best-effort; a take with no chunks is deleted rather
than kept as a phantom. Below 500 MB of free storage the recorder refuses to
start with a plain message; below 2 GB it warns. T-403 adds the launch scan
and recovery card.

### 5.3 Recovery (delivered by T-403)

`extension/recovery.js` (UMD, global `VeoRecRecovery`) is the launch scan and
the resume / download / discard flow of `05` §6, wired into the recorder
window before auto-start (`03` §3.1): a live session elsewhere refuses to
start; unfinished takes are listed newest-first in the `#recoveryCard` with
Resume upload (own sessions only) / Download / Discard; the popup shows an
"unsaved recordings" badge. Server view wins on resume; only chunks the server
does not hold are uploaded; every recovery call is tagged
`X-VeoRec-Recovery: 1` for the `19` §7 KPI. Details: `05` §6.3.

### 5.4 RecorderMachine (delivered by T-501)

`extension/machine.js` (UMD, global `VeoRecMachine`) is the pure state machine
of `03` §2 with injected effects, the disposer registry (`03` §10) and the
overlay projection (`03` §11, legacy keys mirrored). Not wired yet: T-502
provides the CaptureManager effects and T-503 makes `recorder.js` a renderer
of its projections. Details: `03` §2.1.

### 5.5 CaptureManager (delivered by T-502)

`extension/capture.js` (UMD, global `VeoRecCapture`) is the acquisition, mixer,
warnings and interruption-watcher module of `03` §4–§6, §9 — the effect side
of the machine. Every browser dependency is injectable. Not wired yet: T-503
supplies it as the machine's `acquire` effect and renders its warnings.
Details: `03` §4.1.

### 5.6 Recorder window as machine renderer (delivered by T-503)

`extension/recorder.js` is a renderer of `VeoRecMachine` projections: the
CaptureManager is the `acquire` effect, the streaming uploader / RecorderStore /
recovery / quota pre-flight blocks are unchanged effects behind it, every button
and `SR_*` message is a `machine.send`, and `publish` writes `recSession` with
the legacy keys of §7 mirrored in the same write. Mic-denied is a three-way
choice (record without mic / fix permission / cancel); upload failure is
Retry / Save locally / Discard with the local session kept for recovery.
Details: `03` §2.2 and §11. Script order in `recorder.html`:
`fix-webm-duration, machine, capture, recorderStore, uploader, recovery,
quotaPreflight, recorder`.
