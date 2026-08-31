# 21 — Browser Compatibility

> Supported environments for recording and playback, and the browser-API constraints the design must respect.

---

## 1. Support matrix

### Recording (extension)
| Browser | OS | Status |
|---|---|---|
| Chrome ≥ 116 (manifest `minimum_chrome_version`) | Windows 10/11 | **Tier 1** — full matrix (`20` §9) every release |
| Chrome ≥ 116 | macOS 13+ | **Tier 1** — full matrix every release |
| Chrome | Linux | Tier 2 — smoke tests; system audio known-limited |
| Edge (Chromium) | Win/mac | Tier 2 — extension installable; smoke only; not advertised |
| Firefox / Safari | — | **Unsupported** (no MV3 parity / no extension) — web app shows "Chrome required to record" |

### Playback (web app)
| Browser | Status |
|---|---|
| Chrome/Edge (last 2), Firefox (last 2) | Tier 1 — MP4 + hls.js |
| Safari 16+ (macOS/iOS) | Tier 1 — MP4 + **native HLS**; this is *why* WebM sources are never served post-migration (`02` §10.5) |
| Mobile Chrome/Safari | Tier 1 watch page responsive; recording unsupported |

## 2. Capture capability matrix (Chrome, current as of 2026)

| Capability | Windows | macOS | Notes the code must encode |
|---|---|---|---|
| Screen (monitor) capture | ✓ | ✓ | via `getDisplayMedia` picker |
| Window capture | ✓ | ✓ | **no audio ever** with window surface — warn (existing copy) |
| Tab capture (pickerless) | ✓ | ✓ | `chrome.tabCapture.getMediaStreamId` — must be called in a user gesture on the active tab; legacy `mandatory` constraint shape required (`recorder.js:154-162`); stream id single-use |
| Tab audio | ✓ | ✓ | always present in tab mode; capturing **mutes the tab locally** → must route back through AudioContext (`recorder.js:221-224`) |
| System audio (whole screen) | ✓ ("share system audio" checkbox) | **✗ (Chrome cannot capture macOS system audio)** | UI must not promise system audio on macOS; suggest tab mode for meeting audio |
| System audio (window) | ✗ | ✗ | |
| Microphone | ✓ | ✓ | permission per extension origin (recorder window) |
| Camera | ✓ | ✓ | bubble iframe holds permission at extension origin (`bubble.js`) — one-time grant design, keep |
| `displaySurface` preference hint | ✓ | ✓ | hint only; user can pick anything — code must read the actual track settings, not assume |

## 3. Known Chrome behaviors the architecture already accounts for

| Behavior | Consequence | Where handled |
|---|---|---|
| Background timer throttling of occluded windows | `setInterval` timers freeze in the recorder window while a meeting is focused | limit enforcement driven by `dataavailable` + re-arming timeout (`03` §8) |
| Minimized windows get frozen | upload stalls if recorder minimized | recorder window intentionally stays un-minimized (`04` §5) |
| MediaRecorder WebM lacks Duration/Cues | unseekable file | server transcode with faststart is authoritative; `fixWebmDuration` only for local saves |
| MediaRecorder is VFR | A/V drift risk on transcode | `09` §3 normalization rules |
| Suspended AudioContext records silence | silent recordings | resume-before-start + statechange re-resume (`03` §5) |
| `tabCapture` stream id gesture requirement | restart in tab mode can't re-acquire | downgrade-to-screen rule (`03` §4) |
| Screen-share ends via browser bar / window closed / display unplugged | video track `ended` | treated as normal stop (`03` §9) |
| MV3 service worker arbitrary termination | SW state loss | thin SW, storage-derived state (`04` §3) |
| Extension update kills all contexts | recording dies | IndexedDB recovery (`05` §8) |
| Autoplay policy | watch page can't autoplay with sound | muted-autoplay attempt + big-play fallback (`11` §5) |
| `download` attribute ignored cross-origin | broken downloads | signed URL with content-disposition (`12` §5.3) |
| IndexedDB eviction under storage pressure | recovery data loss | `navigator.storage.persist()` request + quota checks (`05` §2,4) |

## 4. Device-change handling (spec'd in `03` §9)

Mic/camera unplug (`track.ended`, `devicechange`), display disconnect (share `ended`), sleep/resume (tracks usually end → salvage-stop; test R21), Bluetooth mic handoff (treated as `mic_lost`; no auto-switch mid-recording).

## 5. Codec support summary

- Record: VP9/Opus preferred, VP8/Opus fallback (`isTypeSupported` probe at runtime — never assume).
- Serve: H.264 High@4.1 + AAC-LC in MP4/HLS — plays everywhere in the support matrix including Safari/iOS.
- AV1 sources (future Chrome default) already accepted by probe allowlist (`09` §2).

## 6. Compatibility testing cadence

Tier-1 matrix on every release; a canary job records against Chrome Beta weekly (catch MediaRecorder/tabCapture regressions before stable); playback smoke on BrowserStack for Safari/iOS monthly and at any player change.
