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
// T-303 streaming uploader. Runs ALONGSIDE the legacy path behind the
// `newUpload` flag: chunks are still accumulated in `chunks`, so the
// save-to-device fallback and the legacy POST stay available even if the
// streaming upload fails. A take is never lost to the new path.
let streamUploader = null;
let streamUploadReady = false;
let lastBlob = null;       // last recorded blob — kept so a failed upload can be saved locally
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
  mediaRecorder.ondataavailable = e => {
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

  // T-303: open an upload session so parts can stream while recording. Behind
  // the `newUpload` flag and deliberately NOT awaited — the recording must
  // start immediately, and a failure here simply leaves the legacy path in
  // charge.
  startStreamingUpload().catch(() => { streamUploadReady = false; });
  mediaRecorder.start(1000);

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
  try { chrome.storage.local.set({ recording: false, recState: { recording: false } }); } catch (e) {}
  try { chrome.runtime.sendMessage({ type: 'RECORDING_RESET' }); } catch (e) {}
}

// ── T-303 streaming upload (flag: newUpload) ─────────────────────────────────

/** Open a v1 upload session. Any failure leaves the legacy path untouched. */
async function startStreamingUpload() {
  streamUploader = null; streamUploadReady = false;
  const { newUpload, sr_token } = await chrome.storage.local.get(["newUpload", "sr_token"]);
  if (newUpload !== true || !sr_token) return;            // OFF unless explicitly true
  if (typeof VeoRecUploader === "undefined") return;

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
    },
  });
  const session = await up.begin({ recordingId: rec.id, mimeType: "video/webm" });
  if (!session) return;
  streamUploader = up;
  streamUploadReady = true;
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
    const streamedUrl = await finishStreamingUpload(duration);
    if (streamedUrl) {
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
        showDownloadFallback();   // don't lose their recording
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
  cleanupStreams();
  // Bring the window forward so the screen-share picker is usable, then re-record.
  try { chrome.windows.getCurrent((w) => { if (w && w.id != null) chrome.windows.update(w.id, { state: 'normal', focused: true }); }); } catch (e) {}
  setStatus('Restarting…');
  beginRecording().catch(onStartError);
}

// On load: read options carried from popup, then try to auto-start.
(async () => {
  try {
    const { recOptions } = await chrome.storage.local.get('recOptions');
    if (recOptions) opts = { ...opts, ...recOptions };
  } catch {}
  setStatus('Preparing your recording…');
  await loadPlanLimit();           // match the countdown to the user's plan
  beginRecording().catch(onStartError);
})();
