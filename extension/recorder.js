const SERVER = 'https://screenrec-api-production.up.railway.app';

const mainBtn   = document.getElementById('mainBtn');
const controls  = document.getElementById('controls');
const pauseBtn  = document.getElementById('pauseBtn');
const cancelBtn = document.getElementById('cancelBtn');
const stopBtn   = document.getElementById('stopBtn');
const statusEl  = document.getElementById('status');
const timerEl   = document.getElementById('timer');
const linkBox   = document.getElementById('linkBox');
const linkUrl   = document.getElementById('linkUrl');
const copyBtn   = document.getElementById('copyBtn');
const openBtn   = document.getElementById('openBtn');
const previewWrap = document.getElementById('previewWrap');
const canvas    = document.getElementById('previewCanvas');
const countdownEl  = document.getElementById('countdown');
const countdownNum = document.getElementById('countdownNum');

let mediaRecorder = null;
let chunks = [];
// T-303 streaming uploader. Runs ALONGSIDE the legacy path, enabled per user
// by the T-304 server rollout decision: chunks are still accumulated in `chunks`, so the
// save-to-device fallback and the legacy POST stay available even if the
// streaming upload fails. A take is never lost to the new path.
let streamUploader = null;
let streamUploadReady = false;
let lastBlob = null;       // last recorded blob — kept so a failed upload can be saved locally
// T-402 local persistence (docs/05). Every dataavailable chunk is written to
// IndexedDB BEFORE the uploader sees it, so a crash loses at most ~1 s. The
// session row is deleted only after the server confirmed completion.
let recStore = null;        // opened once per window
let localSession = null;    // the IndexedDB session for the current take
let localSeq = 0;           // next chunk seq (the store assigns in arrival order)
let fedChunks = [];         // { seq, size } of chunks fed to the uploader, not yet sealed
let persistFailed = false;  // PERSIST_FAILED shown once; recording continues
let heartbeatTimer = null;
let startTime = null;
let pausedAccum = 0;       // total paused ms
let pauseStartedAt = null;
let timerInterval = null;
let rafId = null;
let audioCtx = null;
let activeStreams = [];    // all source streams to stop at the end
let hardStopTimer = null;  // wall-clock cap that survives background timer throttling

// Options carried over from the popup
let opts = { quality: 'medium', audio: true, camera: 'off', countdown: true };

// Recording-length limit (seconds). Driven by the user's plan — fetched on load.
// Defaults to the Free limit (10 min) as a safe fallback until entitlements load.
let recordingLimitSec = 10 * 60;
let limitWarned = false;          // 30s-remaining warning shown once
let limitReached = false;         // auto-stopped at the cap

// Fetch the signed-in user's plan recording limit so the countdown matches it.
async function loadPlanLimit() {
  try {
    const { sr_token } = await chrome.storage.local.get('sr_token');
    if (!sr_token) return;
    const res = await fetch(`${SERVER}/api/me/entitlements`, {
      headers: { Authorization: `Bearer ${sr_token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    const mins = data?.plan?.recordingLimitMinutes;
    if (Number.isFinite(mins) && mins > 0) recordingLimitSec = mins * 60;
  } catch { /* keep the safe default */ }
}

function setStatus(msg, cls = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + cls;
}

function elapsedSeconds() {
  const paused = pausedAccum + (pauseStartedAt ? Date.now() - pauseStartedAt : 0);
  return Math.floor((Date.now() - startTime - paused) / 1000);
}

// Send a message to the on-screen overlay (toolbar + camera bubble) on the tab.
function overlayMsg(msg) {
  const tabId = opts.bubbleTabId;
  if (tabId != null && chrome.tabs && chrome.tabs.sendMessage) {
    try { chrome.tabs.sendMessage(tabId, msg); } catch (e) {}
  }
}

function updateTimer() {
  const s = elapsedSeconds();
  const m = String(Math.floor(s / 60)).padStart(2, '0');
  const text = `${m}:${String(s % 60).padStart(2, '0')}`;
  timerEl.textContent = text;
  overlayMsg({ type: 'SR_OVERLAY_TICK', text });

  // ── Plan recording-length limit (live countdown) ─────────────────────────
  const remaining = recordingLimitSec - s;
  if (!limitReached && remaining <= 0) {
    // Hard cap reached — auto-stop so the upload always passes server validation.
    limitReached = true;
    setStatus(`⏱ Recording limit reached (${Math.round(recordingLimitSec / 60)} min) — saving…`, 'uploading');
    stopRecording();
    return;
  }
  if (!limitWarned && remaining <= 30 && remaining > 0) {
    limitWarned = true;
    timerEl.classList.add('limitWarn');
    setStatus(`⚠ 30 seconds remaining on your plan limit`, 'recording');
  }
}

function videoSize(quality) {
  return quality === 'high' ? { w: 1920, h: 1080 }
       : quality === 'medium' ? { w: 1280, h: 720 }
       : { w: 854, h: 480 };
}

async function playStreamInVideo(stream) {
  const v = document.createElement('video');
  v.srcObject = stream;
  v.muted = true;
  v.playsInline = true;
  await v.play();
  // wait for dimensions
  if (!v.videoWidth) await new Promise(r => v.addEventListener('loadedmetadata', r, { once: true }));
  return v;
}

function countdown() {
  if (!opts.countdown) return Promise.resolve();
  // opts.countdown may be a number of seconds (3/5) or `true` (legacy = 3).
  return new Promise(resolve => {
    let n = typeof opts.countdown === 'number' ? opts.countdown : 3;
    countdownNum.textContent = n;
    countdownEl.classList.add('show');
    const iv = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearInterval(iv);
        countdownEl.classList.remove('show');
        resolve();
      } else {
        countdownNum.textContent = n;
        // restart pop animation
        countdownNum.style.animation = 'none';
        void countdownNum.offsetWidth;
        countdownNum.style.animation = '';
      }
    }, 1000);
  });
}

async function beginRecording() {
  mainBtn.style.display = 'none';
  linkBox.classList.remove('show');
  controls.style.display = 'none';
  setStatus(opts.camera === 'only' ? 'Starting camera…' : 'Select a screen or window to share…');

  const { w: maxW, h: maxH } = videoSize(opts.quality);
  const wantMic = opts.audio !== false;
  const cam = opts.camera || 'off';

  let screenStream = null, camStream = null, micStream = null;

  // ── Acquire sources ──────────────────────────────────────────────────────
  // For 'off' and 'bubble' we capture the SCREEN. (In 'bubble' the camera is a
  // floating DOM overlay already injected onto the page, so it's captured as
  // part of the screen — no canvas, which means recording survives minimize.)
  if (cam !== 'only') {
    if (opts.mode === 'tab' && opts.tabStreamId) {
      // No-picker capture of the CURRENT tab via chrome.tabCapture. The tab's
      // audio (everyone in a web meeting) ALWAYS comes through — no "share audio"
      // checkbox to forget. The legacy `mandatory` constraint shape is REQUIRED
      // for chromeMediaSource:'tab' (the modern { video:true } form is ignored).
      screenStream = await navigator.mediaDevices.getUserMedia({
        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: opts.tabStreamId, maxWidth: maxW, maxHeight: maxH, maxFrameRate: 30 } },
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: opts.tabStreamId } },
      });
    } else {
      const videoConstraints = { width: { ideal: maxW }, height: { ideal: maxH }, frameRate: { ideal: 30 } };
      // Hint the picker toward the surface the user chose (monitor/browser/window)
      if (['monitor', 'browser', 'window'].includes(opts.surface)) videoConstraints.displaySurface = opts.surface;
      // `systemAudio: 'include'` asks Chrome to offer the "share audio" option so we
      // can capture other meeting participants (only works for a TAB or whole SCREEN).
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: videoConstraints, audio: true, systemAudio: 'include' });
    }
    activeStreams.push(screenStream);
  }
  if (cam === 'only') {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
    activeStreams.push(camStream);
  }
  if (wantMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      activeStreams.push(micStream);
    } catch (e) { console.warn('VeoRec: microphone unavailable —', e && e.name, e && e.message); }
  }

  // If the user ends screen share via the browser bar, stop.
  if (screenStream) {
    screenStream.getVideoTracks()[0].addEventListener('ended', () => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') stopRecording();
    });
  }

  // ── Build the video track — always a DIRECT track (no canvas) ─────────────
  let videoTrack;
  if (cam === 'only') {
    videoTrack = camStream.getVideoTracks()[0];
    // optional live preview (not recorded — throttling here is harmless)
    const camVideo = await playStreamInVideo(camStream);
    canvas.width = camVideo.videoWidth || 1280;
    canvas.height = camVideo.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    previewWrap.classList.add('show');
    const draw = () => { ctx.drawImage(camVideo, 0, 0, canvas.width, canvas.height); rafId = requestAnimationFrame(draw); };
    draw();
  } else {
    videoTrack = screenStream.getVideoTracks()[0];
    previewWrap.classList.remove('show');
  }

  // ── Mix audio (tab/screen audio + mic) into ONE track ─────────────────────
  // Everyone else (tab/screen audio) AND the user (mic) feed a single mixed
  // track, so the recording always carries both sides of a meeting.
  const audioTracks = [];
  const screenAudio = screenStream ? screenStream.getAudioTracks() : [];
  if (screenAudio.length > 0 || micStream) {
    audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    if (screenAudio.length > 0) {
      const screenSrc = audioCtx.createMediaStreamSource(screenStream);
      screenSrc.connect(dest);
      // chrome.tabCapture MUTES the captured tab for the user — route the tab
      // audio back to the speakers so the host still hears the call live.
      if (opts.mode === 'tab') screenSrc.connect(audioCtx.destination);
    }
    if (micStream) audioCtx.createMediaStreamSource(micStream).connect(dest);
    audioTracks.push(...dest.stream.getAudioTracks());
  }
  // Wanted audio but got none (mic denied + no system/tab audio) — we'll warn
  // loudly below instead of silently recording a muted video.
  const noAudioAtAll = wantMic && audioTracks.length === 0;

  const finalStream = new MediaStream([videoTrack, ...audioTracks]);

  // ── Countdown, then record ───────────────────────────────────────────────
  setStatus('Get ready…');
  await countdown();

  chunks = [];
  startTime = Date.now();
  pausedAccum = 0;
  pauseStartedAt = null;
  limitWarned = false;
  limitReached = false;
  timerEl.classList.remove('limitWarn');

  // T-402: local recovery protection. docs/05 §4 — refuse to start with under
  // 500 MB of free storage (better than dying mid-recording); warn under 2 GB.
  // A store that cannot be opened at all leaves the take unprotected but never
  // prevents recording: better un-protected than not recorded (03 §7).
  const store = await openLocalStore();
  if (store) {
    const space = await store.checkSpace().catch(() => ({ level: 'unknown', ok: true }));
    if (!space.ok) {
      cleanupStreams();
      showStartButton('Not enough free disk space to protect this recording (under 500 MB). Free up space and try again.');
      return;
    }
    if (space.level === 'warn') overlayMsg({ type: 'SR_OVERLAY_WARN', text: 'Low disk space — recovery protection may run out during a long recording.' });
  }

  // A suspended AudioContext records pure SILENCE (no error) — this auto-opened
  // window often has no user gesture, so force it running BEFORE recording starts,
  // and re-resume if the OS interrupts audio mid-recording.
  if (audioCtx) {
    try { if (audioCtx.state !== 'running') await audioCtx.resume(); } catch (e) {}
    if (audioCtx.state !== 'running') {
      await new Promise((res) => {
        const t = setTimeout(res, 1500);
        audioCtx.addEventListener('statechange', function h() {
          if (audioCtx.state === 'running') { clearTimeout(t); audioCtx.removeEventListener('statechange', h); res(); }
        });
      });
    }
    audioCtx.onstatechange = () => { if (audioCtx && audioCtx.state !== 'running') audioCtx.resume().catch(() => {}); };
  }

  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9' : 'video/webm';
  const bitsPerSecond = opts.quality === 'high' ? 4_000_000 : opts.quality === 'medium' ? 2_500_000 : 1_000_000;

  mediaRecorder = new MediaRecorder(finalStream, { mimeType, videoBitsPerSecond: bitsPerSecond });
  // T-402: the local session row exists before the first chunk (docs/05 §3).
  await startLocalSession(mediaRecorder.mimeType || mimeType, opts);
  mediaRecorder.ondataavailable = e => {
    // T-402: IndexedDB FIRST (docs/03 §7) — fire-and-ordered, never awaited,
    // never allowed to interrupt the recording.
    if (e.data.size > 0) persistChunk(e.data);
    if (e.data.size > 0) chunks.push(e.data);
    // T-303: stream the same chunk to storage while recording continues.
    // Wrapped so an uploader fault can never interrupt the recording itself —
    // the legacy path still holds every chunk.
    if (streamUploadReady && e.data.size > 0) {
      try { streamUploader.addChunk(e.data); } catch (err) { streamUploadReady = false; }
    }
    // PRIMARY limit enforcement — driven by the ENCODER clock (fires ~1/s via the
    // timeslice), so the cap trips even when the window's timers are throttled
    // because the recorder window sits behind a focused meeting.
    if (!limitReached && recordingLimitSec > 0 && elapsedSeconds() >= recordingLimitSec) {
      limitReached = true;
      setStatus(`⏱ Recording limit reached (${Math.round(recordingLimitSec / 60)} min) — saving…`, 'uploading');
      stopRecording();
    }
  };
  mediaRecorder.onstop = handleStop;

  // T-303: open an upload session so parts can stream while recording. Gated by
  // the server rollout decision (T-304) and deliberately NOT awaited — the recording must
  // start immediately, and a failure here simply leaves the legacy path in
  // charge.
  startStreamingUpload().catch(() => { streamUploadReady = false; });
  mediaRecorder.start(1000);
  startHeartbeat();   // T-402: docs/05 §3 — bumped every 5 s while recording

  // Wall-clock backstop. A single setTimeout still fires when an occluded window
  // freezes setInterval; it re-arms if the recording was paused so it never stops
  // a take early.
  clearTimeout(hardStopTimer);
  if (recordingLimitSec > 0) {
    hardStopTimer = setTimeout(function hardStop() {
      if (!mediaRecorder || mediaRecorder.state === 'inactive' || limitReached) return;
      if (elapsedSeconds() >= recordingLimitSec) {
        limitReached = true;
        setStatus(`⏱ Recording limit reached (${Math.round(recordingLimitSec / 60)} min) — saving…`, 'uploading');
        stopRecording();
      } else {
        hardStopTimer = setTimeout(hardStop, (recordingLimitSec - elapsedSeconds()) * 1000 + 500);
      }
    }, recordingLimitSec * 1000 + 500);
  }

  // UI: recording
  controls.style.display = 'flex';
  pauseBtn.textContent = '⏸ Pause';
  timerEl.classList.add('show');
  updateTimer();
  timerInterval = setInterval(updateTimer, 500);
  // Audio warnings, most-severe first.
  const tabAudioMissing = opts.mode === 'tab' && screenStream && screenStream.getAudioTracks().length === 0;
  const noSystemAudio = cam !== 'only' && opts.mode !== 'tab' && screenStream && screenStream.getAudioTracks().length === 0;
  const recMsg = cam === 'bubble' ? '● Recording… (camera bubble is on your tab)' : '● Recording…';
  let warnText = '';
  if (noAudioAtAll) {
    warnText = 'No audio is being captured. Allow microphone access (or share a tab/screen WITH audio), then re-record.';
  } else if (tabAudioMissing) {
    warnText = 'This tab’s audio didn’t come through — Stop and try again, or use “Entire Screen” with system audio.';
  } else if (noSystemAudio && wantMic) {
    warnText = 'Only YOUR mic is captured — others’ audio isn’t. To record everyone, Stop and use “This Tab” mode, or re-share a TAB/whole SCREEN with audio.';
  }
  setStatus(warnText ? '● Recording… ⚠ ' + warnText : recMsg, 'recording');
  if (warnText) overlayMsg({ type: 'SR_OVERLAY_WARN', text: warnText });

  chrome.storage.local.set({ recording: true, startTime });
  // Shared state the on-screen overlay (on any tab) reads to render the timer.
  chrome.storage.local.set({ recState: { recording: true, startTime, paused: false, pausedAccum: 0, pauseStartedAt: null } });
  chrome.runtime.sendMessage({ type: 'RECORDER_STARTED', startTime });

  // Let the on-screen overlay take over as the visible UI. We intentionally do
  // NOT minimize this recorder window: a minimized (hidden) window gets frozen
  // by Chrome, which can stall the upload after you stop. It just sits behind.
  overlayMsg({ type: 'SR_OVERLAY_STATE', state: 'recording' });
}

function togglePause() {
  if (!mediaRecorder) return;
  if (mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    pauseStartedAt = Date.now();
    pauseBtn.textContent = '▶ Resume';
    setStatus('⏸ Paused', 'uploading');
    chrome.storage.local.set({ recState: { recording: true, startTime, paused: true, pausedAccum, pauseStartedAt } });
  } else if (mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
    if (pauseStartedAt) { pausedAccum += Date.now() - pauseStartedAt; pauseStartedAt = null; }
    pauseBtn.textContent = '⏸ Pause';
    setStatus('● Recording…', 'recording');
    chrome.storage.local.set({ recState: { recording: true, startTime, paused: false, pausedAccum, pauseStartedAt: null } });
  }
}

function showStartButton(message) {
  if (message) setStatus(message);
  controls.style.display = 'none';
  previewWrap.classList.remove('show');
  mainBtn.style.display = '';
  mainBtn.className = 'btn btn-start';
  mainBtn.textContent = '▶ Start Recording';
}

// Server rejected the upload because of a plan limit. Show the upsell and open
// the pricing page so the user can upgrade without hunting for it.
function showUpgradePrompt(reason) {
  // Reuse the start button (its existing listener restarts a recording) and open
  // the pricing page in a new tab so the user can upgrade right away.
  showStartButton((reason || 'This recording exceeds your plan limit.') + ' Upgrade to Pro for longer recordings & more storage.');
  try { chrome.tabs.create({ url: 'https://veorec.com/pricing' }); }
  catch { try { window.open('https://veorec.com/pricing'); } catch {} }
}

function onStartError(e) {
  cleanupStreams();
  closeBubble();
  if (e && (e.name === 'NotAllowedError' || (e.message && e.message.includes('cancel')))) {
    showStartButton('Click “Start Recording”, then choose what to share.');
  } else {
    showStartButton('Error: ' + (e?.message || 'could not start recording'));
  }
}

function cleanupStreams() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  clearTimeout(hardStopTimer); hardStopTimer = null;
  activeStreams.forEach(s => s.getTracks().forEach(t => t.stop()));
  activeStreams = [];
  if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }
}

// Remove the floating camera bubble from the recorded tab.
function closeBubble() {
  const tabId = opts.bubbleTabId;
  if (tabId != null && chrome.tabs && chrome.tabs.sendMessage) {
    try { chrome.tabs.sendMessage(tabId, { type: 'SR_STOP_BUBBLE' }); } catch (e) {}
  }
}

// Close this recorder popup window (used after upload, or on cancel).
function closeWindow() {
  try { window.close(); } catch (e) {}
  try { chrome.windows.getCurrent(w => { if (w && w.id != null) chrome.windows.remove(w.id); }); } catch (e) {}
}

mainBtn.addEventListener('click', () => beginRecording().catch(onStartError));
pauseBtn.addEventListener('click', togglePause);
stopBtn.addEventListener('click', stopRecording);
cancelBtn.addEventListener('click', cancelRecording);

function stopRecording() {
  clearInterval(timerInterval);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  cleanupStreams();
  closeBubble();
  chrome.storage.local.set({ recState: { recording: false } }); // overlays on all tabs self-remove
  controls.style.display = 'none';
  previewWrap.classList.remove('show');
  setStatus('Uploading…', 'uploading');
  timerEl.classList.remove('show');
  // Bring the recorder window back so upload progress is visible (it was
  // minimized while the on-screen overlay drove the recording).
  try { chrome.windows.getCurrent((w) => { if (w && w.id != null) chrome.windows.update(w.id, { state: 'normal', focused: true }); }); } catch (e) {}
}

// Discard the recording entirely — nothing is saved or uploaded — and close.
function cancelRecording() {
  if (mediaRecorder) {
    mediaRecorder.onstop = null;                 // prevent upload
    if (mediaRecorder.state !== 'inactive') { try { mediaRecorder.stop(); } catch (e) {} }
  }
  clearInterval(timerInterval);
  chunks = [];
  discardLocalSession();                         // T-402: docs/03 §3.11 — an explicit discard
  cleanupStreams();
  closeBubble();
  chrome.storage.local.set({ recording: false, recState: { recording: false } });
  closeWindow();
}

// Safety net: if an upload ever fails, the recording is NOT lost — offer a
// one-click local save of the exact webm we captured.
function showDownloadFallback() {
  if (!lastBlob || !lastBlob.size) return;
  let btn = document.getElementById('dlFallback');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'dlFallback';
    btn.className = 'btn';
    btn.style.marginTop = '10px';
    btn.textContent = '⤓ Save recording to your device';
    btn.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(lastBlob);
      a.download = `veorec-recording-${Date.now()}.webm`;
      document.body.appendChild(a); a.click();
      setTimeout(() => { try { URL.revokeObjectURL(a.href); a.remove(); } catch {} }, 4000);
    });
    (mainBtn.parentNode || document.body).insertBefore(btn, mainBtn.nextSibling);
  }
  btn.style.display = '';
}

// Clear the "recording" flags so the popup never stays stuck on a failed upload.
function resetRecordingState() {
  // T-402: an upload that did not complete leaves the local session marked
  // failed and KEPT (docs/05 §3) — T-403's recovery flow offers resume /
  // download / discard. Deleted only on server-confirmed completion or an
  // explicit discard.
  stopHeartbeat();
  if (recStore && localSession) {
    if (localSeq === 0) { const id = localSession.id; recStore.deleteSession(id).catch(() => {}); }   // nothing captured: no phantom recovery
    else markLocalSession({ status: 'failed' });
    localSession = null;
  }
  try { chrome.storage.local.set({ recording: false, recState: { recording: false } }); } catch (e) {}
  try { chrome.runtime.sendMessage({ type: 'RECORDING_RESET' }); } catch (e) {}
}

// ── T-303 streaming upload (gated by the T-304 server rollout decision) ─────────────────────────────────

// ── T-402 local persistence (docs/05) ───────────────────────────────────────
// Nothing here may throw into the recorder: every call is best-effort and the
// worst outcome is a take that is not protected — never a take that is lost.

async function openLocalStore() {
  if (recStore) return recStore;
  if (typeof VeoRecRecorderStore === 'undefined') return null;
  try {
    recStore = await VeoRecRecorderStore.openStore({
      log: (level, msg, meta) => { try { (level === 'warn' ? console.warn : console.log)('[recorder-store]', msg, meta || ''); } catch (e) {} },
    });
  } catch (e) { recStore = null; }
  return recStore;
}

async function startLocalSession(mimeType, config) {
  localSession = null; localSeq = 0; fedChunks = []; persistFailed = false;
  const store = await openLocalStore();
  if (!store) return null;
  try {
    let userId = null;
    try { const { sr_user } = await chrome.storage.local.get('sr_user'); userId = (sr_user && sr_user.id) || null; } catch (e) {}
    localSession = await store.createSession({ mimeType, config: config || {}, title: 'Screen recording', userId });
  } catch (e) { localSession = null; }
  return localSession;
}

/** IndexedDB first, fire-and-ordered. PERSIST_FAILED once; recording continues. */
function persistChunk(blob) {
  if (!recStore || !localSession) return;
  const seq = localSeq;
  localSeq += 1;
  fedChunks.push({ seq, size: blob.size });
  recStore.appendChunk(localSession.id, blob).catch((err) => {
    if (!persistFailed) {
      persistFailed = true;
      overlayMsg({ type: 'SR_OVERLAY_WARN', text: 'Recovery protection unavailable — recording continues.' });
      try { console.warn('[recorder-store] PERSIST_FAILED', err && err.code); } catch (e) {}
    }
    // docs/05 §4: under quota pressure, reclaim space covered by verified parts.
    if (err && err.code === 'quota_exceeded' && streamUploadReady) {
      recStore.pruneChunks(localSession.id, { force: true }).catch(() => {});
    }
  });
}

function startHeartbeat() {
  stopHeartbeat();
  if (!recStore || !localSession) return;
  heartbeatTimer = setInterval(() => { recStore.heartbeat(localSession.id).catch(() => {}); }, 5000);
}
function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }

function linkLocalSession(fields) {
  if (!recStore || !localSession) return;
  recStore.updateSession(localSession.id, fields).then((s) => { localSession = s; }).catch(() => {});
}
function markLocalSession(fields) {
  if (!recStore || !localSession) return Promise.resolve();
  return recStore.updateSession(localSession.id, fields).then((s) => { localSession = s; }).catch(() => {});
}

/** docs/05 §5: the sealed part's chunk range, recorded pending BEFORE its PUT. */
function recordSealedPart(partNumber, size) {
  if (!recStore || !localSession) return;
  let taken = 0; const seqs = [];
  while (fedChunks.length && taken < size) { const c = fedChunks.shift(); taken += c.size; seqs.push(c.seq); }
  if (!seqs.length) return;
  recStore.upsertPart(localSession.id, { partNumber, size, firstSeq: seqs[0], lastSeq: seqs[seqs.length - 1], status: 'pending' }).catch(() => {});
}
function recordUploadedPart(uploader, partNumber) {
  if (!recStore || !localSession) return;
  const p = uploader && uploader.state && uploader.state.parts.get(partNumber);
  if (!p || p.status !== 'uploaded' || !p.etag) return;
  recStore.upsertPart(localSession.id, { partNumber, status: 'uploaded', etag: p.etag, size: p.size }).catch(() => {});
}

/** Only after the server confirmed completion (docs/03 §3.10). */
async function deleteLocalSession() {
  stopHeartbeat();
  if (!recStore || !localSession) return;
  const id = localSession.id; localSession = null;
  try { await recStore.deleteSession(id); } catch (e) {}
}
/** An explicit discard: local data gone, server session aborted best-effort (docs/03 §3.11). */
function discardLocalSession() {
  stopHeartbeat();
  if (streamUploader && streamUploadReady) { try { streamUploader.abort().catch(() => {}); } catch (e) {} }
  if (!recStore || !localSession) return;
  const id = localSession.id; localSession = null;
  recStore.deleteSession(id).catch(() => {});
}

// ── T-307 quota pre-flight (docs/03 §3.0, docs/16 §4.6) ─────────────────────
// UX only: the authoritative gate is the server's atomic reservation at
// upload-session creation (T-306). A fetch failure never blocks recording.

const DASHBOARD_URL = 'https://veorec.com/';
const PRICING_URL = 'https://veorec.com/pricing';
const openTab = (url) => { try { chrome.tabs.create({ url }); } catch (e) { try { window.open(url, '_blank'); } catch (e2) {} } };

async function loadQuotaPreflight() {
  if (typeof VeoRecQuotaPreflight === 'undefined') return { state: 'unknown' };
  try {
    const { sr_token } = await chrome.storage.local.get('sr_token');
    if (!sr_token) return { state: 'unknown' };
    const res = await fetch(`${SERVER}/api/v1/me/usage`, { headers: { Authorization: `Bearer ${sr_token}` } });
    if (!res.ok) return { state: 'unknown' };          // 404 (v1 off) / 503 (not migrated) / anything: proceed
    const usage = await res.json();
    return VeoRecQuotaPreflight.assess({ usage, quality: opts.quality });
  } catch (e) { return { state: 'unknown' }; }
}

/** Blocked: Start is replaced by the exact block message + Manage videos / Upgrade. */
function showQuotaBlocked(verdict) {
  controls.style.display = 'none';
  previewWrap.classList.remove('show');
  mainBtn.style.display = 'none';
  setStatus(verdict.message, 'uploading');
  let box = document.getElementById('quotaBlocked');
  if (!box) {
    box = document.createElement('div');
    box.id = 'quotaBlocked';
    box.className = 'recovery-actions';
    box.style.justifyContent = 'center';
    box.style.marginTop = '10px';
    const mk = (label, cls, fn) => { const b = document.createElement('button'); b.className = `btn ${cls}`; b.textContent = label; b.addEventListener('click', fn); box.appendChild(b); };
    mk('🗂 Manage videos', 'btn-pause', () => openTab(DASHBOARD_URL));
    mk('⭐ Upgrade', 'btn-start', () => openTab(PRICING_URL));
    mk('↻ Check again', 'btn-cancel', async () => {
      const again = await loadQuotaPreflight();
      if (again.state !== 'blocked') { box.remove(); showStartButton('Ready.'); if (again.state === 'warn') overlayMsg({ type: 'SR_OVERLAY_WARN', text: again.message }); }
      else setStatus(again.message, 'uploading');
    });
    (mainBtn.parentNode || document.body).insertBefore(box, mainBtn.nextSibling);
  }
}

/** After a quota refusal at finalize: Save to device / Delete a video & retry / Upgrade. */
function showQuotaOptions() {
  showDownloadFallback();
  let btn = document.getElementById('quotaRetry');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'quotaRetry';
    btn.className = 'btn';
    btn.style.marginTop = '10px';
    btn.textContent = '🗂 Delete a video & retry';
    btn.addEventListener('click', () => openTab(DASHBOARD_URL));
    (mainBtn.parentNode || document.body).insertBefore(btn, mainBtn.nextSibling);
  }
  btn.style.display = '';
}

// ── T-403 recovery (docs/05 §6) ─────────────────────────────────────────────
// Runs at launch before idle. A take interrupted by a crash is offered as
// Resume upload / Download / Discard; a recording that is LIVE in another
// window refuses this one; nothing is deleted except on server-confirmed
// completion or an explicit Discard.

const recoveryCard = document.getElementById('recoveryCard');

async function currentUserId() {
  try { const { sr_user } = await chrome.storage.local.get('sr_user'); return (sr_user && sr_user.id) || null; } catch (e) { return null; }
}

/** Publish the count for the popup badge (docs/05 §6.2). */
function publishRecoverable(count) {
  try { chrome.storage.local.set({ recoverable: { count, at: Date.now() } }); } catch (e) {}
}

/** @returns {{proceed:boolean}} whether auto-start may go ahead */
async function runRecoveryScan() {
  if (typeof VeoRecRecovery === 'undefined') return { proceed: true };
  const store = await openLocalStore();
  if (!store) return { proceed: true };
  const me = await currentUserId();
  const result = await VeoRecRecovery.scan({ store, currentUserId: me });
  publishRecoverable(result.recoverable.length);

  if (result.live) {
    // docs/05 §3: a live heartbeat means another recorder window is recording.
    showStartButton('A recording is already running in another VeoRec window. Finish it there, or wait 15 seconds if that window was closed.');
    mainBtn.textContent = '↻ Check again';
    mainBtn.onclick = null;
    mainBtn.addEventListener('click', function again() {
      mainBtn.removeEventListener('click', again);
      mainBtn.textContent = '▶ Start Recording';
      runRecoveryScan().then((v) => { if (v.proceed) beginRecording().catch(onStartError); });
    }, { once: true });
    return { proceed: false };
  }
  if (!result.recoverable.length) { hideRecoveryCard(); return { proceed: true }; }

  await renderRecoveryCard(store, result.recoverable, me);
  return { proceed: false };
}

function hideRecoveryCard() { if (recoveryCard) { recoveryCard.style.display = 'none'; recoveryCard.innerHTML = ''; } }

const fmtBytes = (b) => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
const fmtWhen = (t) => { try { return new Date(t).toLocaleString(); } catch (e) { return ''; } };
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

async function renderRecoveryCard(store, sessions, me) {
  if (!recoveryCard) return;
  recoveryCard.innerHTML = '';
  const h = document.createElement('h4');
  h.textContent = sessions.length === 1 ? 'An unfinished recording was found' : `${sessions.length} unfinished recordings were found`;
  recoveryCard.appendChild(h);
  for (const s of sessions) {
    const d = await VeoRecRecovery.describe(store, s);
    const row = document.createElement('div');
    row.className = 'recovery-row';
    row.dataset.sessionId = s.id;
    const meta = document.createElement('div');
    meta.className = 'recovery-meta';
    meta.textContent = `${d.title} · ${fmtWhen(d.recordedAt)} · ~${fmtDur(d.durationSec)} · ${fmtBytes(d.sizeBytes)}`
      + (d.totalParts ? ` · uploaded ${d.uploadedParts}/${d.totalParts} parts` : '')
      + (d.ownedByCurrentUser ? '' : ' · recorded by another account');
    row.appendChild(meta);
    const msg = document.createElement('div'); msg.className = 'recovery-msg'; row.appendChild(msg);
    const actions = document.createElement('div'); actions.className = 'recovery-actions';
    const mk = (label, cls, fn) => { const b = document.createElement('button'); b.className = `btn ${cls}`; b.textContent = label; b.addEventListener('click', fn); actions.appendChild(b); return b; };
    if (d.ownedByCurrentUser) mk('⬆ Resume upload', 'btn-start', () => recoveryResume(store, s, row, msg));
    mk('⬇ Download', 'btn-pause', () => recoveryDownload(store, s, msg));
    mk('🗑 Discard', 'btn-cancel', () => recoveryDiscard(store, s, row));
    row.appendChild(actions);
    recoveryCard.appendChild(row);
  }
  recoveryCard.style.display = '';
  showStartButton('Recover your unfinished recording, or start a new one.');
  mainBtn.textContent = '▶ Start a new recording';
  mainBtn.addEventListener('click', () => { hideRecoveryCard(); mainBtn.textContent = '▶ Start Recording'; }, { once: true });
}

async function recoveryResume(store, s, row, msg) {
  const { sr_token } = await chrome.storage.local.get('sr_token');
  if (!sr_token) { msg.textContent = 'Sign in via the extension popup, then reopen this window to resume.'; return; }
  row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  msg.textContent = 'Resuming upload…';
  const me = await currentUserId();
  const out = await VeoRecRecovery.resumeSession({
    store, session: s, server: SERVER, token: sr_token, currentUserId: me,
    createUploader: VeoRecUploader.createUploader, fetchImpl: fetch.bind(null),
    onEvent: (e) => {
      if (e.type === 'phase') msg.textContent = e.phase === 'reconciling' ? 'Checking what was already uploaded…' : e.phase === 'starting' ? 'Starting a fresh upload…' : 'Uploading…';
      if (e.type === 'progress' && e.recordedBytes) msg.textContent = `Uploading… ${Math.round((e.uploadedBytes / e.recordedBytes) * 100)}%`;
    },
    log: (level, m, meta) => { try { console.log('[recovery]', m, meta || ''); } catch (e) {} },
  }).catch((e) => ({ kind: 'failed', reason: (e && e.message) || 'error' }));

  if (out.kind === 'saved' || out.kind === 'already_saved') {
    msg.textContent = out.kind === 'saved' ? 'Saved ✓' : 'This recording was already saved ✓';
    try { await chrome.storage.local.set({ lastRecording: { url: out.watchUrl, title: s.title || 'Screen recording', at: Date.now() } }); } catch (e) {}
    try { chrome.runtime.sendMessage({ type: 'UPLOAD_DONE', url: out.watchUrl, title: s.title || 'Screen recording' }); } catch (e) {}
    try { chrome.tabs.create({ url: out.watchUrl }); } catch (e) { try { window.open(out.watchUrl, '_blank'); } catch (e2) {} }
    row.remove();
    publishRecoverable(recoveryCard.querySelectorAll('.recovery-row').length);
    if (!recoveryCard.querySelectorAll('.recovery-row').length) hideRecoveryCard();
    return;
  }
  row.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  if (out.kind === 'auth_required') msg.textContent = 'Your sign-in has expired. Sign in via the extension popup, then resume — nothing was lost.';
  else if (out.kind === 'quota') {
    // T-307 (docs/05 §6.1.3): the card keeps offering Download / Delete a video & retry / Upgrade.
    msg.textContent = (out.message || 'You have reached your plan limit.') + ' You can still download this recording.';
    const actions = row.querySelector('.recovery-actions');
    if (actions && !row.querySelector('[data-quota-action]')) {
      const mk = (label, cls, fn) => { const b = document.createElement('button'); b.className = `btn ${cls}`; b.dataset.quotaAction = '1'; b.textContent = label; b.addEventListener('click', fn); actions.appendChild(b); };
      mk('🗂 Delete a video & retry', 'btn-pause', () => openTab(DASHBOARD_URL));
      mk('⭐ Upgrade', 'btn-start', () => openTab(PRICING_URL));
    }
  }
  else if (out.kind === 'cross_account') msg.textContent = 'This recording belongs to another account. You can download or discard it.';
  else msg.textContent = 'Could not upload right now — your recording is kept. Try again later, or download it.';
}

async function recoveryDownload(store, s, msg) {
  msg.textContent = 'Preparing download…';
  try {
    const out = await VeoRecRecovery.downloadSession({
      store, session: s, fixWebmDuration: (typeof fixWebmDuration === 'function' ? fixWebmDuration : null),
      saveAs: async (blob, name) => {
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch (e) {} }, 60000);
      },
    });
    msg.textContent = `Downloaded ${out.name} (${fmtBytes(out.size)}). The recording is still kept here until you discard it.`;
  } catch (e) { msg.textContent = 'Download failed — please try again.'; }
}

async function recoveryDiscard(store, s, row) {
  if (!window.confirm('Discard this unfinished recording? This cannot be undone.')) return;
  const { sr_token } = await chrome.storage.local.get('sr_token');
  await VeoRecRecovery.discardSession({ store, session: s, server: SERVER, token: sr_token || null, fetchImpl: fetch.bind(null) }).catch(() => {});
  row.remove();
  const left = recoveryCard.querySelectorAll('.recovery-row').length;
  publishRecoverable(left);
  if (!left) hideRecoveryCard();
}

/** Open a v1 upload session. Any failure leaves the legacy path untouched. */
async function startStreamingUpload() {
  streamUploader = null; streamUploadReady = false;
  const { sr_token } = await chrome.storage.local.get(["sr_token"]);
  if (!sr_token) return;
  if (typeof VeoRecUploader === "undefined") return;

  // T-304: the SERVER decides the path. Fetched fresh at the start of every
  // recording and never cached across takes, so a rollback reaches this client
  // on the next recording rather than waiting out a cached value. Any failure
  // — offline, 5xx, malformed — leaves the legacy path in charge.
  let cfg = null;
  try {
    const r = await fetch(`${SERVER}/api/client-config`, {
      headers: { Authorization: `Bearer ${sr_token}` },
    });
    if (!r.ok) return;
    cfg = await r.json();
  } catch (e) { return; }
  if (!cfg || !cfg.upload || cfg.upload.path !== "v1") return;

  // The recording row must exist before a session can bind to it.
  const res = await fetch(`${SERVER}/api/v1/recordings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sr_token}` },
    body: JSON.stringify({ title: "Screen recording", source: "extension" }),
  });
  if (!res.ok) return;
  const rec = await res.json();

  const up = VeoRecUploader.createUploader({
    server: SERVER, token: sr_token,
    onEvent: (e) => {
      if (e.type === "ceiling-warning") setStatus("Approaching your size limit — wrapping up soon…", "uploading");
      if (e.type === "ceiling-reached") { try { stopRecording(); } catch (err) {} }
      // T-402: upload bookkeeping in IndexedDB (docs/05 §5) — a sealed part is
      // recorded `pending` BEFORE its PUT; an uploaded part gets its etag.
      if (e.type === "part-sealed") recordSealedPart(e.partNumber, e.size);
      if (e.type === "progress" && e.partNumber) recordUploadedPart(up, e.partNumber);
    },
  });
  const session = await up.begin({ recordingId: rec.id, mimeType: "video/webm" });
  if (!session) return;
  streamUploader = up;
  streamUploadReady = true;
  // T-402: server linkage on the local session as soon as it is known
  // (docs/05 §3), so recovery can resume this exact upload session.
  linkLocalSession({ recordingId: rec.id, uploadSessionId: session.uploadSessionId, partSize: session.partSize });
}

/**
 * Finish the streaming upload. Returns a share URL on success, or null so the
 * caller falls back to the legacy POST — which still has every chunk.
 */
async function finishStreamingUpload(duration) {
  if (!streamUploader || !streamUploadReady) return null;
  try {
    const out = await streamUploader.finalize({ clientDuration: duration });
    if (!out || !out.ok) return null;
    return `https://veorec.com/watch/${out.body.recordingId}`;
  } catch (err) {
    return null;
  } finally {
    streamUploadReady = false;
  }
}

async function handleStop() {
  let duration = elapsedSeconds();
  // The plan cap is enforced by auto-stop; clamp the reported duration to the
  // limit so a sub-second timing overrun can't get the upload rejected (which
  // used to lose the whole recording on free accounts at the 5-min mark).
  if (limitReached && recordingLimitSec > 0) duration = Math.min(duration, recordingLimitSec);
  const rawBlob = new Blob(chunks, { type: 'video/webm' });
  chunks = [];
  // T-402: the take is captured; the heartbeat stops and the local session
  // records that it is stopped (docs/05 §3) with the client duration hint.
  stopHeartbeat();
  markLocalSession({ status: 'stopped', clientDuration: duration });
  // MediaRecorder omits the Duration header (live stream), so the file shows no
  // length and can't be scrubbed. Inject the real duration before BOTH the upload
  // and the local-save fallback. Fail-safe: returns the original blob on any error.
  let blob = rawBlob;
  if (typeof fixWebmDuration === 'function' && duration > 0) {
    try { blob = await fixWebmDuration(rawBlob, duration * 1000); } catch (e) { blob = rawBlob; }
  }
  lastBlob = blob;          // preserve so the user can always recover it

  // Make sure this window is visible+focused (never frozen) during the upload.
  try { chrome.windows.getCurrent((w) => { if (w && w.id != null) chrome.windows.update(w.id, { state: 'normal', focused: true }); }); } catch (e) {}

  if (!blob.size) {
    resetRecordingState();
    showStartButton('Nothing was recorded — please try again.');
    return;
  }

  try {
    const { sr_token } = await chrome.storage.local.get('sr_token');
    if (!sr_token) { resetRecordingState(); showStartButton('Not logged in — please sign in via the extension popup.'); return; }

    const sizeMB = (blob.size / 1048576).toFixed(1);
    setStatus(`Uploading… (${sizeMB} MB)`, 'uploading');

    const title = 'Screen recording';

    // T-303: if the streaming upload finished, the bytes are already in
    // storage — skip the legacy POST entirely. Otherwise fall through to it
    // with the blob we still hold, so a failed streaming upload costs the user
    // nothing.
    markLocalSession({ status: 'uploading' });
    const streamedUrl = await finishStreamingUpload(duration);
    if (streamedUrl) {
      // T-402: the server confirmed completion — ONLY now is the local copy
      // deleted (docs/03 §3.10: local data outlives every failure mode).
      await deleteLocalSession();
      await chrome.storage.local.set({
        shareLink: streamedUrl, recording: false, recState: { recording: false },
        lastRecording: { url: streamedUrl, title, at: Date.now() },
      });
      chrome.runtime.sendMessage({ type: 'UPLOAD_DONE', url: streamedUrl, title });
      setStatus('Saved ✓  Opening your video…', 'done');
      try { chrome.tabs.create({ url: streamedUrl }); } catch (e) { try { window.open(streamedUrl, '_blank'); } catch (e2) {} }
      return;
    }

    const form = new FormData();
    form.append('video', blob, 'recording.webm');
    form.append('title', title);
    form.append('duration', String(duration));
    // T-304: tell the server this take began on v1 and fell back, so the v1
    // success rate counts the failure the user never saw.
    if (streamUploader) form.append('uploadFallbackFrom', 'v1');

    // Hard timeout so a stalled connection never hangs the UI forever.
    const ctrl = new AbortController();
    const timeoutMs = Math.max(120000, blob.size / 1024); // ≥2 min, scales with size
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    let res;
    try {
      res = await fetch(`${SERVER}/api/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sr_token}` },
        body: form,
        signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      resetRecordingState();
      if (res.status === 403 && data.upgradeRequired) {
        setStatus((data.error || 'Upgrade required to save this recording.') + ' ', 'uploading');
        showUpgradePrompt(data.error);
        // T-307 (docs/03 §3.0): a take in progress is never discarded by a quota
        // verdict — Save to device / Delete a video & retry / Upgrade.
        showQuotaOptions();
        return;
      }
      showStartButton(res.status === 401
        ? 'Session expired — please sign in again via the extension popup.'
        : 'Upload failed: ' + (data.error || res.status));
      showDownloadFallback();
      return;
    }
    const shareUrl = `https://veorec.com/watch/${data.id}`;

    await chrome.storage.local.set({
      shareLink: shareUrl, recording: false, recState: { recording: false },
      lastRecording: { url: shareUrl, title, at: Date.now() },
    });
    // T-402: the legacy server has the recording — the local copy may go.
    await deleteLocalSession();
    chrome.runtime.sendMessage({ type: 'UPLOAD_DONE', url: shareUrl, title });

    // Open the saved video's preview page in a new tab, then close this window.
    setStatus('Saved ✓  Opening your video…', 'done');
    try { chrome.tabs.create({ url: shareUrl }); } catch (e) { try { window.open(shareUrl, '_blank'); } catch (e2) {} }
    setTimeout(closeWindow, 1200);
  } catch (e) {
    resetRecordingState();
    showStartButton(e.name === 'AbortError'
      ? 'Upload timed out — check your connection and try again.'
      : 'Upload failed: ' + e.message);
    showDownloadFallback();
  }
}

copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(linkUrl.textContent).then(() => {
    copyBtn.textContent = '✓ Copied!';
    setTimeout(() => { copyBtn.textContent = '🔗 Copy Link'; }, 2000);
  });
});

// Remote controls — from the popup (STOP_RECORDING) and the on-screen overlay
// toolbar (SR_PAUSE / SR_STOP / SR_CANCEL).
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  const active = mediaRecorder && mediaRecorder.state !== 'inactive';
  if ((msg.type === 'STOP_RECORDING' || msg.type === 'SR_STOP') && active) stopRecording();
  if (msg.type === 'SR_PAUSE' && active) togglePause();
  if (msg.type === 'SR_CANCEL') cancelRecording();
  if (msg.type === 'SR_RESTART') restartRecording();
});

// Discard the current take (no upload) and immediately start a fresh recording,
// keeping the on-screen overlay in place. Triggered by the toolbar's Restart.
function restartRecording() {
  if (mediaRecorder) {
    mediaRecorder.onstop = null;
    if (mediaRecorder.state !== 'inactive') { try { mediaRecorder.stop(); } catch (e) {} }
  }
  clearInterval(timerInterval);
  chunks = [];
  discardLocalSession();                         // T-402: the discarded take is not kept
  cleanupStreams();
  // Bring the window forward so the screen-share picker is usable, then re-record.
  try { chrome.windows.getCurrent((w) => { if (w && w.id != null) chrome.windows.update(w.id, { state: 'normal', focused: true }); }); } catch (e) {}
  setStatus('Restarting…');
  beginRecording().catch(onStartError);
}

// On load: read options carried from popup, run the recovery scan (docs/05 §6,
// docs/03 §3.1 — BEFORE anything else), then auto-start only when nothing
// needs the user's attention.
(async () => {
  try {
    const { recOptions } = await chrome.storage.local.get('recOptions');
    if (recOptions) opts = { ...opts, ...recOptions };
  } catch {}
  setStatus('Preparing your recording…');
  await loadPlanLimit();           // match the countdown to the user's plan
  const verdict = await runRecoveryScan().catch(() => ({ proceed: true }));
  if (!verdict.proceed) return;
  // T-307: quota pre-flight (docs/03 §3.0). Blocked → the exact block message
  // with Manage videos / Upgrade instead of Start; near-limit → banner, proceed;
  // unknown → proceed (the server enforces at session creation regardless).
  const quota = await loadQuotaPreflight();
  if (quota.state === 'blocked') { showQuotaBlocked(quota); return; }
  if (quota.state === 'warn') overlayMsg({ type: 'SR_OVERLAY_WARN', text: quota.message });
  beginRecording().catch(onStartError);
})();
