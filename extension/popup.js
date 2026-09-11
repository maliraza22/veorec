const SERVER = 'https://screenrec-api-production.up.railway.app';
const WEB = 'https://veorec.com';

// ── Elements ──────────────────────────────────────────────────────────────────
const topActions   = document.getElementById('topActions');
const userChip     = document.getElementById('userChip');
const authPanel    = document.getElementById('authPanel');
const authError    = document.getElementById('authError');
const webSigninBtn = document.getElementById('webSigninBtn');
const webSignupBtn = document.getElementById('webSignupBtn');
const recorderPanel= document.getElementById('recorderPanel');

const surfaceWrap  = document.getElementById('surface');
const surfHint     = document.getElementById('surfHint');
const cameraRow    = document.getElementById('cameraRow');
const cameraVal    = document.getElementById('cameraVal');
const micRow       = document.getElementById('micRow');
const micVal       = document.getElementById('micVal');
const qualityRow   = document.getElementById('qualityRow');
const qualityVal   = document.getElementById('qualityVal');
const countdownRow = document.getElementById('countdownRow');
const countdownVal = document.getElementById('countdownVal');

const mainBtn      = document.getElementById('mainBtn');
const statusEl     = document.getElementById('status');
const timerEl      = document.getElementById('timer');
const freeNote     = document.getElementById('freeNote');
const linkBox      = document.getElementById('linkBox');
const latestTitle  = document.getElementById('latestTitle');
const linkUrl      = document.getElementById('linkUrl');
const copyBtn      = document.getElementById('copyBtn');
const copyBtnDefault = copyBtn.innerHTML;

// ── State ─────────────────────────────────────────────────────────────────────
let isRecording = false;
let timerInterval = null;
let elapsed = 0;
let currentLink = null;

const opts = { surface: 'monitor', camera: 'off', bubbleSize: 'md', audio: true, quality: 'high', countdown: 3 };

// Choice panels (camera mode + quality). Mic & countdown are simple toggles.
const cameraPanel    = document.getElementById('cameraPanel');
const qualityPanel   = document.getElementById('qualityPanel');

// Only options that present a real list get a dropdown. Camera = mode list
// (size is changed live on the bubble while recording). Quality = resolution
// list. Microphone & Countdown are simple on/off toggles (no dropdown).
const CHOICES = {
  camera: [
    { label: 'Off', set: { camera: 'off' } },
    { label: 'Camera bubble', set: { camera: 'bubble' } },
    { label: 'Camera only', set: { camera: 'only' } },
  ],
  quality: [
    { label: '1080p (HD)', set: { quality: 'high' } },
    { label: '720p', set: { quality: 'medium' } },
    { label: '480p', set: { quality: 'low' } },
  ],
};

function cameraLabel() {
  if (opts.camera === 'off') return 'Off';
  if (opts.camera === 'only') return 'Camera only';
  return 'Bubble';
}
const QUALITY_LABELS = { high: '1080p', medium: '720p', low: '480p' };
const SURF_HINTS = {
  tab: '<b>No pop-up.</b> Records this tab + everyone’s audio in it + your mic. Best for meetings.',
  monitor: 'Picks your whole screen in the share dialog — tick <b>“Share system audio”</b> to capture others.',
  window: 'Picks one app window in the share dialog. <b>Window mode can’t capture audio.</b>',
};

function render() {
  cameraVal.textContent = cameraLabel();
  qualityVal.textContent = QUALITY_LABELS[opts.quality];
  micVal.textContent = opts.audio ? 'On' : 'Off';
  micVal.className = 'pill ' + (opts.audio ? 'on' : 'off');
  countdownVal.textContent = opts.countdown ? (opts.countdown + ' sec') : 'Off';
  countdownVal.className = 'pill ' + (opts.countdown ? 'on' : 'off');
  surfaceWrap.querySelectorAll('.surf').forEach(b => {
    b.classList.toggle('active', b.dataset.surface === opts.surface);
  });
  if (surfHint) surfHint.innerHTML = SURF_HINTS[opts.surface] || '';
}

// A choice is active if every key in its `set` matches current opts.
function isChoiceActive(choice) {
  return Object.keys(choice.set).every(k => opts[k] === choice.set[k]);
}

function buildPanel(panelEl, key) {
  panelEl.innerHTML = '';
  CHOICES[key].forEach(choice => {
    const b = document.createElement('button');
    b.className = 'choice' + (isChoiceActive(choice) ? ' active' : '');
    b.innerHTML = `<span>${choice.label}</span><span class="tick">✓</span>`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      Object.assign(opts, choice.set);
      render();
      closeAllPanels();
    });
    panelEl.appendChild(b);
  });
}

function closeAllPanels() {
  [cameraPanel, qualityPanel].forEach(p => p && p.classList.remove('open'));
  [cameraRow, qualityRow].forEach(r => r && r.classList.remove('expanded'));
}

function togglePanel(row, panel, key) {
  const isOpen = panel.classList.contains('open');
  closeAllPanels();
  if (!isOpen) { buildPanel(panel, key); panel.classList.add('open'); row.classList.add('expanded'); }
}

// Camera & Quality open a choice list; Microphone & Countdown just toggle.
cameraRow.addEventListener('click', () => togglePanel(cameraRow, cameraPanel, 'camera'));
qualityRow.addEventListener('click', () => togglePanel(qualityRow, qualityPanel, 'quality'));
micRow.addEventListener('click', () => { opts.audio = !opts.audio; render(); });
countdownRow.addEventListener('click', () => { opts.countdown = opts.countdown ? false : 3; render(); });
surfaceWrap.querySelectorAll('.surf').forEach(b => {
  b.addEventListener('click', () => { opts.surface = b.dataset.surface; render(); });
});

// ── Auth ────────────────────────────────────────────────────────────────────
// Sign-in/up happens on veorec.com. The bridge.js content script on the site
// copies the session token back into the extension, so we never run an auth form
// in the popup (which sidesteps MV3's inline-handler limits entirely).
function openWebAuth(path) {
  chrome.tabs.create({ url: `${WEB}${path}` });
  window.close();
}
webSigninBtn.addEventListener('click', () => openWebAuth('/login'));
webSignupBtn.addEventListener('click', () => openWebAuth('/signup'));
document.getElementById('signOutBtn').addEventListener('click', signOut);

function signOut() {
  chrome.storage.local.remove(
    ['sr_token', 'sr_user', 'recording', 'startTime', 'shareLink', 'lastRecording'],
    () => showAuth()
  );
}

async function fetchMe(token) {
  try {
    const r = await fetch(`${SERVER}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// Show the right panel based on the stored token (validated once via /auth/me).
async function refreshAuthUI() {
  const { sr_token, sr_user } = await chrome.storage.local.get(['sr_token', 'sr_user']);
  if (!sr_token) { showAuth(); return false; }
  let user = sr_user;
  if (!user) {
    user = await fetchMe(sr_token);
    if (user) chrome.storage.local.set({ sr_user: user });
  }
  if (!user) { chrome.storage.local.remove(['sr_token', 'sr_user']); showAuth(); return false; }
  showRecorder(user);
  return true;
}

function showAuth() {
  authPanel.style.display = 'block';
  recorderPanel.style.display = 'none';
  topActions.style.display = 'none';
  if (authError) authError.textContent = '';
}
function showRecorder(user) {
  authPanel.style.display = 'none';
  recorderPanel.style.display = 'block';
  topActions.style.display = 'flex';
  userChip.textContent = (user?.name || user?.email || '?').charAt(0).toUpperCase();
  userChip.title = user?.name || '';
  render();
}

// If the user signs in (or out) on the website while the popup is open, the
// bridge updates chrome.storage — react to it and switch panels instantly.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.sr_token) refreshAuthUI();
});

// ── Recording lifecycle ───────────────────────────────────────────────────────
function setStatus(msg, cls = '') { statusEl.textContent = msg; statusEl.className = 'status ' + cls; }

function updateTimer() {
  elapsed++;
  const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
  timerEl.textContent = `${m}:${String(elapsed % 60).padStart(2, '0')}`;
}

function showRecordingUI() {
  mainBtn.className = 'btn-record stop';
  mainBtn.innerHTML = '⏹ Stop Recording';
  timerEl.style.display = 'block';
  document.querySelector('.opts').style.display = 'none';
  surfaceWrap.style.display = 'none';
  freeNote.style.display = 'none';
  if (!timerInterval) timerInterval = setInterval(updateTimer, 1000);
  setStatus('● Recording…', 'recording');
}

mainBtn.addEventListener('click', async () => {
  if (isRecording) {
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
    mainBtn.className = 'btn-record disabled';
    mainBtn.innerHTML = 'Stopping…';
    clearInterval(timerInterval); timerInterval = null;
    setStatus('Processing…', 'uploading');
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onWebTab = !!(tab && tab.id && /^https?:/.test(tab.url || ''));

  // "This Tab" mode → grab a no-picker tabCapture stream id IN this click gesture
  // (required: tabCapture only works on the active tab, from a user gesture).
  let mode = 'screen', tabStreamId = null;
  if (opts.surface === 'tab') {
    if (!onWebTab) { setStatus('Open the page you want to record (a normal web tab), then try again.', 'uploading'); return; }
    try {
      tabStreamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      mode = 'tab';
    } catch (e) {
      setStatus('Could not capture this tab — try “Entire Screen” instead. (' + (e?.message || 'tabCapture failed') + ')', 'uploading');
      return;
    }
  }

  const recOptions = {
    audio: opts.audio, quality: opts.quality, camera: opts.camera, bubbleSize: opts.bubbleSize,
    countdown: opts.countdown, surface: opts.surface, mode, tabStreamId, bubbleTabId: null,
  };

  // Inject the on-screen overlay (draggable control toolbar + camera bubble) onto
  // the active tab so controls/camera are visible IN the recording. The recorder
  // window drives MediaRecorder and talks to this overlay by tab id.
  let bubbleTabId = null;
  if (onWebTab) {
    try {
      recOptions.bubbleTabId = tab.id;
      await chrome.storage.local.set({ recOptions });   // overlay reads camera mode on inject
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['overlay.js'] });
      bubbleTabId = tab.id;
    } catch (e) { recOptions.bubbleTabId = null; }
  }
  recOptions.bubbleTabId = bubbleTabId;
  await chrome.storage.local.set({ recOptions });
  chrome.windows.create({ url: chrome.runtime.getURL('recorder.html'), type: 'popup', width: 420, height: 560 });
  window.close();
});

// Screenshot — open a capture window (getDisplayMedia frame-grab → copy/download).
const screenshotBtn = document.getElementById('screenshotBtn');
if (screenshotBtn) screenshotBtn.addEventListener('click', () => {
  chrome.windows.create({ url: chrome.runtime.getURL('screenshot.html'), type: 'popup', width: 960, height: 680 });
  window.close();
});

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString();
}

function showLatest(rec) {
  if (!rec || !rec.url) return;
  currentLink = rec.url;
  latestTitle.textContent = rec.title || 'Screen recording';
  latestTitle.href = rec.url;
  linkUrl.textContent = timeAgo(rec.at || Date.now());
  linkBox.classList.add('show');
}

// Dismiss the Latest Recording card — hides it without deleting the video.
const latestClose = document.getElementById('latestClose');
if (latestClose) latestClose.addEventListener('click', () => {
  linkBox.classList.remove('show');
  currentLink = null;
  chrome.storage.local.remove('lastRecording');
});

copyBtn.addEventListener('click', () => {
  if (!currentLink) return;
  navigator.clipboard.writeText(currentLink).then(() => {
    copyBtn.textContent = '✓ Copied!';
    setTimeout(() => { copyBtn.innerHTML = copyBtnDefault; }, 2000);
  });
});

// ── Live messages from the recorder window ───────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'UPLOAD_DONE') {
    isRecording = false;
    clearInterval(timerInterval); timerInterval = null;
    showLatest({ url: msg.url, title: msg.title, at: Date.now() });
    // restore the idle UI
    mainBtn.className = 'btn-record';
    mainBtn.innerHTML = '<span class="rdot"></span> Start Recording';
    timerEl.style.display = 'none';
    document.querySelector('.opts').style.display = '';
    surfaceWrap.style.display = '';
    freeNote.style.display = '';
    setStatus('Saved! ✓', 'done');
  }
  if (msg.type === 'RECORDER_STARTED') {
    chrome.storage.local.set({ recording: true, startTime: msg.startTime });
    isRecording = true; elapsed = 0; showRecordingUI();
  }
  // Upload failed / was cancelled — unstick the popup back to the idle state.
  if (msg.type === 'RECORDING_RESET') {
    isRecording = false;
    clearInterval(timerInterval); timerInterval = null;
    mainBtn.className = 'btn-record';
    mainBtn.innerHTML = '<span class="rdot"></span> Start Recording';
    timerEl.style.display = 'none';
    const optsEl = document.querySelector('.opts'); if (optsEl) optsEl.style.display = '';
    surfaceWrap.style.display = '';
    freeNote.style.display = '';
    setStatus('');
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const loggedIn = await refreshAuthUI();
  if (!loggedIn) return;
  const data = await chrome.storage.local.get(['recording', 'startTime', 'lastRecording', 'recoverable']);
  if (data.recording) { isRecording = true; elapsed = Math.floor((Date.now() - data.startTime) / 1000); showRecordingUI(); }
  if (data.lastRecording) showLatest(data.lastRecording);
  // T-403: "recovered recordings" badge (docs/05 §6.2) — a take interrupted by a
  // crash is found here even if the user never reopens the recorder on their own.
  showRecoverableBadge(data.recoverable);
})();

function showRecoverableBadge(recoverable) {
  const count = recoverable && Number(recoverable.count) || 0;
  let el = document.getElementById('recoverBadge');
  if (!count) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('button');
    el.id = 'recoverBadge';
    el.style.cssText = 'display:block;width:100%;margin:0 0 10px;padding:9px 12px;border:1px solid #5b5bf6;border-radius:10px;background:#1a1a2e;color:#e6e6ff;font-size:13px;cursor:pointer;text-align:left';
    el.addEventListener('click', () => {
      chrome.windows.create({ url: chrome.runtime.getURL('recorder.html?recover=1'), type: 'popup', width: 420, height: 560 });
      window.close();
    });
    document.body.insertBefore(el, document.body.firstChild);
  }
  el.textContent = count === 1 ? '⚠ 1 unsaved recording — open to recover' : `⚠ ${count} unsaved recordings — open to recover`;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.recoverable) showRecoverableBadge(changes.recoverable.newValue);
});
