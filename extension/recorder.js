// ─────────────────────────────────────────────────────────────────────────────
// Recorder window — a RENDERER of RecorderMachine projections (T-503, docs/03)
//
// One machine, one owner (docs/03 §1): `machine` (T-501) is the only writer of
// recording lifecycle state. This file supplies its EFFECTS — CaptureManager
// (T-502) for acquisition, MediaRecorder, the IndexedDB store (T-401/T-402),
// the streaming uploader (T-303) and the legacy upload fallback — turns user
// clicks and overlay/popup messages into EVENTS, and renders the projection.
// No `isRecording` boolean lives here any more.
//
// Launch order (docs/03 §3.1, §3.0): options → plan limit → recovery scan
// (T-403) → quota pre-flight (T-307) → START.
// ─────────────────────────────────────────────────────────────────────────────
const SERVER = 'https://screenrec-api-production.up.railway.app';
const DASHBOARD_URL = 'https://veorec.com/';
const PRICING_URL = 'https://veorec.com/pricing';

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
const recoveryCard = document.getElementById('recoveryCard');

// ── Per-take resources (owned by machine states, disposed by their exits) ───
let capture = null;         // T-502 acquire() result: tracks, streams, mixer, dispose()
let captureWatchOff = null; // T-502 watch() disposer
let mediaRecorder = null;
let chunks = [];            // legacy in-memory chunks — the save-to-device fallback (memory rule is Phase 5 follow-up)
let streamUploader = null;  // T-303
let streamUploadReady = false;
let lastBlob = null;        // the captured blob, kept so a failed upload can be saved locally
let rafId = null;
let uiTick = null;
let lastWatchUrl = null;
let lastUploadMessage = null;   // the server's own text for an upload refusal (rendered in upload_failed)

// T-402 local persistence (docs/05).
let recStore = null;
let localSession = null;
let localSeq = 0;
let fedChunks = [];
let persistFailed = false;
let heartbeatTimer = null;

// Options carried over from the popup
let opts = { quality: 'medium', audio: true, camera: 'off', countdown: true };

// Recording-length limit (seconds) — driven by the plan; the Free limit is the safe fallback.
let recordingLimitSec = 10 * 60;

// ── Small helpers ────────────────────────────────────────────────────────────
const openTab = (url) => { try { chrome.tabs.create({ url }); } catch (e) { try { window.open(url, '_blank'); } catch (e2) {} } };
function setStatus(msg, cls = '') { statusEl.textContent = msg; statusEl.className = 'status ' + cls; }
function overlayMsg(msg) {
  const tabId = opts.bubbleTabId;
  if (tabId != null && chrome.tabs && chrome.tabs.sendMessage) { try { chrome.tabs.sendMessage(tabId, msg); } catch (e) {} }
}
function closeBubble() { overlayMsg({ type: 'SR_STOP_BUBBLE' }); }
function closeWindow() {
  try { window.close(); } catch (e) {}
  try { chrome.windows.getCurrent((w) => { if (w && w.id != null) chrome.windows.remove(w.id); }); } catch (e) {}
}
function focusWindow() {
  try { chrome.windows.getCurrent((w) => { if (w && w.id != null) chrome.windows.update(w.id, { state: 'normal', focused: true }); }); } catch (e) {}
}
const fmtClock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function loadPlanLimit() {
  try {
    const { sr_token } = await chrome.storage.local.get('sr_token');
    if (!sr_token) return;
    const res = await fetch(`${SERVER}/api/me/entitlements`, { headers: { Authorization: `Bearer ${sr_token}` } });
    if (!res.ok) return;
    const data = await res.json();
    const mins = data?.plan?.recordingLimitMinutes;
    if (Number.isFinite(mins) && mins > 0) recordingLimitSec = mins * 60;
  } catch { /* keep the safe default */ }
}

function showStartButton(message) {
  if (message) setStatus(message);
  controls.style.display = 'none';
  previewWrap.classList.remove('show');
  mainBtn.style.display = '';
  mainBtn.className = 'btn btn-start';
  mainBtn.textContent = '▶ Start Recording';
}

// Server rejected the upload because of a plan limit: show the upsell and open pricing.
function showUpgradePrompt(reason) {
  showStartButton((reason || 'This recording exceeds your plan limit.') + ' Upgrade to Pro for longer recordings & more storage.');
  openTab(PRICING_URL);
}

// Safety net: if an upload ever fails, the recording is NOT lost — one-click local save.
function showDownloadFallback() {
  if (!lastBlob || !lastBlob.size) return;
  let btn = document.getElementById('dlFallback');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'dlFallback';
    btn.className = 'btn';
    btn.style.marginTop = '10px';
    btn.textContent = '⤓ Save recording to your device';
    btn.addEventListener('click', () => machine.send({ type: 'DOWNLOAD_FALLBACK' }));
    (mainBtn.parentNode || document.body).insertBefore(btn, mainBtn.nextSibling);
  }
  btn.style.display = '';
}
function saveBlobLocally() {
  if (!lastBlob || !lastBlob.size) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(lastBlob);
  a.download = `veorec-recording-${Date.now()}.webm`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { try { URL.revokeObjectURL(a.href); a.remove(); } catch {} }, 4000);
}

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
/** A take that never uploaded: kept as failed for recovery; a zero-chunk take is deleted. */
function keepLocalSessionForRecovery() {
  stopHeartbeat();
  if (recStore && localSession) {
    if (localSeq === 0) { const id = localSession.id; recStore.deleteSession(id).catch(() => {}); }   // nothing captured: no phantom recovery
    else markLocalSession({ status: 'failed' });
    localSession = null;
  }
}

// ── T-307 quota pre-flight (docs/03 §3.0, docs/16 §4.6) ─────────────────────
// UX only: the authoritative gate is the server's atomic reservation at
// upload-session creation (T-306). A fetch failure never blocks recording.

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
    mainBtn.dataset.custom = '1';                 // the default Start handler stands down
    mainBtn.addEventListener('click', function again() {
      mainBtn.removeEventListener('click', again);
      delete mainBtn.dataset.custom;
      mainBtn.textContent = '▶ Start Recording';
      runRecoveryScan().then((v) => { if (v.proceed) startRecording(); });
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
    openTab(out.watchUrl);
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

// ── T-303 streaming upload (gated by the T-304 server rollout decision) ─────

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
    const r = await fetch(`${SERVER}/api/client-config`, { headers: { Authorization: `Bearer ${sr_token}` } });
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
      if (e.type === "ceiling-warning") machine.send({ type: 'WARNING', code: 'byte_limit_near' });
      // docs/03 §8 layer 1: the byte ceiling (the reservation) stops the take — preserved, never rejected.
      if (e.type === "ceiling-reached") machine.send({ type: 'STOP', source: 'byte_limit' });
      if (e.type === "progress" && e.recordedBytes) machine.send({ type: 'UPLOAD_PROGRESS', pct: Math.round((e.uploadedBytes / e.recordedBytes) * 100) });
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

// ── The upload drain (docs/03 §3.8) — v1 first, legacy POST as the fallback ──
async function runUpload(ctx) {
  const duration = ctx.clientDuration || 0;
  const blob = lastBlob;
  if (!blob || !blob.size) return machine.send({ type: 'UPLOAD_FAILED', code: 'empty', retryable: false });
  const { sr_token } = await chrome.storage.local.get('sr_token');
  if (!sr_token) return machine.send({ type: 'UPLOAD_FAILED', code: 'unauthorized', retryable: true });
  const title = 'Screen recording';

  // T-303: if the streaming upload finished, the bytes are already in storage —
  // skip the legacy POST entirely. Otherwise fall through to it with the blob we
  // still hold, so a failed streaming upload costs the user nothing.
  const streamedUrl = await finishStreamingUpload(duration);
  if (streamedUrl) return machine.send({ type: 'UPLOAD_COMPLETE', recordingId: ctx.recordingId, watchUrl: streamedUrl, title });

  const form = new FormData();
  form.append('video', blob, 'recording.webm');
  form.append('title', title);
  form.append('duration', String(duration));
  // T-304: tell the server this take began on v1 and fell back, so the v1
  // success rate counts the failure the user never saw.
  if (streamUploader) form.append('uploadFallbackFrom', 'v1');

  // Hard timeout so a stalled connection never hangs the UI forever.
  const ctrl = new AbortController();
  const timeoutMs = Math.max(120000, blob.size / 1024);
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${SERVER}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${sr_token}` }, body: form, signal: ctrl.signal });
  } catch (e) {
    return machine.send({ type: 'UPLOAD_FAILED', code: e && e.name === 'AbortError' ? 'timeout' : 'network', retryable: true, message: e && e.message });
  } finally { clearTimeout(timer); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    lastUploadMessage = data.error || null;
    if (res.status === 403 && data.upgradeRequired) return machine.send({ type: 'UPLOAD_FAILED', code: 'plan_limit', retryable: false });
    if (res.status === 401) return machine.send({ type: 'UPLOAD_FAILED', code: 'unauthorized', retryable: true });
    return machine.send({ type: 'UPLOAD_FAILED', code: `http_${res.status}`, retryable: res.status >= 500 });
  }
  return machine.send({ type: 'UPLOAD_COMPLETE', recordingId: data.id, watchUrl: `https://veorec.com/watch/${data.id}`, title });
}

// ── Effects: what each machine state asks this window to do ─────────────────
const captureManager = (typeof VeoRecCapture !== 'undefined') ? VeoRecCapture.createCaptureManager({}) : null;

const effects = {
  // docs/03 §3.2 — all getUserMedia/getDisplayMedia calls happen here and only here.
  acquire(config) {
    setStatus(config.camera === 'only' ? 'Starting camera…' : 'Select a screen or window to share…');
    mainBtn.style.display = 'none'; linkBox.classList.remove('show'); controls.style.display = 'none';
    if (!captureManager) return machine.send({ type: 'ACQUIRE_FAILED', code: 'capture_failed' });
    captureManager.acquire(config).then(async (result) => {
      capture = result;
      if (config.camera === 'only') await showCameraPreview(result.streams.camera);
      machine.send({ type: 'ACQUIRED', tracks: result.tracks, warnings: result.warnings });
    }).catch((err) => {
      machine.send({ type: 'ACQUIRE_FAILED', code: (err && err.code) || 'capture_failed', message: err && err.message });
    });
  },
  // docs/03 §3.3 — countdown; returns its disposer.
  startCountdown(seconds) {
    let n = seconds;
    countdownNum.textContent = n;
    countdownEl.classList.add('show');
    const iv = setInterval(() => {
      n -= 1;
      if (n <= 0) { clearInterval(iv); countdownEl.classList.remove('show'); machine.send({ type: 'COUNTDOWN_DONE' }); }
      else { countdownNum.textContent = n; countdownNum.style.animation = 'none'; void countdownNum.offsetWidth; countdownNum.style.animation = ''; }
    }, 1000);
    return () => { clearInterval(iv); countdownEl.classList.remove('show'); };
  },
  // docs/03 §3.4 step 1 — the IndexedDB session row exists BEFORE the recorder starts.
  createSession() {
    const mime = (captureManager ? captureManager.recorderOptions(opts).mimeType : 'video/webm');
    startLocalSession(mime, opts);
    return null;   // the id arrives asynchronously; linkLocalSession carries the server linkage later
  },
  // docs/03 §3.4 step 2 — the upload session (quota reservation); "record first, network later".
  createUploadSession() { startStreamingUpload().catch(() => { streamUploadReady = false; }); },
  // docs/03 §3.4 step 3 — MediaRecorder; every callback becomes an event.
  startRecorder(ctx) {
    const tracks = [ctx.tracks.video].concat(ctx.tracks.audio ? [ctx.tracks.audio] : []);
    const stream = new MediaStream(tracks);
    const options = captureManager ? captureManager.recorderOptions(opts) : { mimeType: 'video/webm' };
    chunks = [];
    mediaRecorder = new MediaRecorder(stream, options);
    // docs/05 §3: the session records the ACTUAL MediaRecorder mimeType.
    if (mediaRecorder.mimeType) linkLocalSession({ mimeType: mediaRecorder.mimeType });
    mediaRecorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      // docs/03 §7: IndexedDB FIRST, then the uploader, then the machine's limit clock.
      persistChunk(e.data);
      chunks.push(e.data);
      if (streamUploadReady) { try { streamUploader.addChunk(e.data); } catch (err) { streamUploadReady = false; } }
      machine.send({ type: 'CHUNK', size: e.data.size });
    };
    mediaRecorder.onstop = () => machine.send({ type: 'RECORDER_STOPPED' });
    mediaRecorder.onerror = () => machine.send({ type: 'STOP', source: 'recorder_error' });   // salvage what exists
    mediaRecorder.start(1000);
    captureWatchOff = capture && captureManager ? captureManager.watch({ streams: capture.streams, mixer: capture.mixer, onEvent: (e) => machine.send(e) }) : null;
    startHeartbeat();
    chrome.runtime.sendMessage({ type: 'RECORDER_STARTED', startTime: Date.now() });
    overlayMsg({ type: 'SR_OVERLAY_STATE', state: 'recording' });
  },
  pauseRecorder() { try { if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.pause(); } catch (e) {} },
  resumeRecorder() { try { if (mediaRecorder && mediaRecorder.state === 'paused') mediaRecorder.resume(); } catch (e) {} },
  // docs/03 §3.6 — stop the recorder and NOTHING else.
  stopRecorder() {
    try { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); else machine.send({ type: 'RECORDER_STOPPED' }); }
    catch (e) { machine.send({ type: 'RECORDER_STOPPED' }); }
  },
  // docs/03 §3.7 — only now do the tracks go.
  stopTracks() {
    if (captureWatchOff) { try { captureWatchOff(); } catch (e) {} captureWatchOff = null; }
    if (capture) { try { capture.dispose(); } catch (e) {} capture = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    closeBubble();
    focusWindow();
  },
  // docs/03 §3.7 — assemble the take, fix the duration header, mark the local session stopped.
  finalize(ctx) {
    stopHeartbeat();
    const duration = ctx.clientDuration || 0;
    const rawBlob = new Blob(chunks, { type: 'video/webm' });
    chunks = [];
    markLocalSession({ status: 'stopped', clientDuration: duration });
    (async () => {
      let blob = rawBlob;
      if (typeof fixWebmDuration === 'function' && duration > 0) { try { blob = await fixWebmDuration(rawBlob, duration * 1000); } catch (e) { blob = rawBlob; } }
      lastBlob = blob;
      if (!blob.size) { keepLocalSessionForRecovery(); return machine.send({ type: 'UPLOAD_FAILED', code: 'empty', retryable: false }); }
      machine.send({ type: 'FINALIZED' });
    })();
  },
  // docs/03 §3.8
  startUpload(ctx) {
    markLocalSession({ status: 'uploading' });
    runUpload(ctx).catch((e) => machine.send({ type: 'UPLOAD_FAILED', code: 'unexpected', retryable: true, message: e && e.message }));
  },
  // docs/03 §3.10 — the local copy goes ONLY now (server 200), then the watch page.
  complete(ctx) {
    const url = ctx.watchUrl; lastWatchUrl = url;
    (async () => {
      await deleteLocalSession();
      try { await chrome.storage.local.set({ shareLink: url, recording: false, recState: { recording: false }, lastRecording: { url, title: 'Screen recording', at: Date.now() } }); } catch (e) {}
      try { chrome.runtime.sendMessage({ type: 'UPLOAD_DONE', url, title: 'Screen recording' }); } catch (e) {}
      openTab(url);
      setTimeout(closeWindow, 1200);
    })();
  },
  download() { saveBlobLocally(); keepLocalSessionForRecovery(); },
  discard() { discardLocalSession(); },
  // docs/03 §3.11 — cleanup then CLEANED.
  cleanup(ctx) {
    try { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); } catch (e) {}
    mediaRecorder = null;
    chunks = [];
    if (captureWatchOff) { try { captureWatchOff(); } catch (e) {} captureWatchOff = null; }
    if (capture) { try { capture.dispose(); } catch (e) {} capture = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    countdownEl.classList.remove('show');
    discardLocalSession();
    closeBubble();
    if (ctx.restart) focusWindow();
    machine.send({ type: 'CLEANED' });
  },
  wakeLock() {
    let lock = null;
    try { navigator.wakeLock && navigator.wakeLock.request('screen').then((l) => { lock = l; }).catch(() => {}); } catch (e) {}
    return () => { try { lock && lock.release(); } catch (e) {} };
  },
  setTimer(fn, ms) { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
  persist(patch) { markLocalSession(patch); },
  warn(code) { render(machine.projection(), machine.state, machine.context); },
  clearProjection() { try { chrome.storage.local.set({ recording: false, recState: { recording: false } }); } catch (e) {} },
  // docs/03 §11 — recSession for overlays; the legacy keys mirrored in parallel.
  publish(projection, state, ctx) {
    render(projection, state, ctx);
    const recState = projection.recording
      ? { recording: true, startTime: projection.startedAt, paused: state === 'paused', pausedAccum: projection.pausedTotal, pauseStartedAt: projection.pauseStartedAt }
      : { recording: false };
    try { chrome.storage.local.set({ recSession: projection, recording: !!projection.recording, startTime: projection.startedAt, recState }); } catch (e) {}
  },
};

const machine = VeoRecMachine.createMachine({
  effects,
  log: (level, msg, meta) => { try { (level === 'warn' ? console.warn : console.log)('[machine]', msg, meta || ''); } catch (e) {} },
});

async function showCameraPreview(camStream) {
  try {
    const v = document.createElement('video');
    v.srcObject = camStream; v.muted = true; v.playsInline = true;
    await v.play();
    if (!v.videoWidth) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
    canvas.width = v.videoWidth || 1280; canvas.height = v.videoHeight || 720;
    const ctx2d = canvas.getContext('2d');
    previewWrap.classList.add('show');
    const draw = () => { ctx2d.drawImage(v, 0, 0, canvas.width, canvas.height); rafId = requestAnimationFrame(draw); };
    draw();
  } catch (e) { /* preview is optional */ }
}

// ── Rendering: the projection → the window ──────────────────────────────────
const WARN_TEXT = (code) => {
  if (!code) return '';
  if (typeof VeoRecCapture !== 'undefined' && VeoRecCapture.WARNING_TEXT[code]) return VeoRecCapture.WARNING_TEXT[code];
  if (code === 'duration_limit_near') return '30 seconds remaining on your plan limit';
  if (code === 'byte_limit_near') return 'Approaching your size limit — wrapping up soon…';
  return '';
};

function render(projection, state, ctx) {
  const recording = state === 'recording' || state === 'paused';
  if (recording) {
    controls.style.display = 'flex';
    mainBtn.style.display = 'none';
    timerEl.classList.add('show');
    pauseBtn.textContent = state === 'paused' ? '▶ Resume' : '⏸ Pause';
    const recMsg = opts.camera === 'bubble' ? '● Recording… (camera bubble is on your tab)' : '● Recording…';
    const warn = WARN_TEXT(ctx.warning);
    if (state === 'paused') setStatus('⏸ Paused', 'uploading');
    else setStatus(warn ? recMsg + ' ⚠ ' + warn : recMsg, 'recording');
    if (warn && ctx.warning !== renderedWarning) { renderedWarning = ctx.warning; overlayMsg({ type: 'SR_OVERLAY_WARN', text: warn }); if (ctx.warning === 'duration_limit_near') timerEl.classList.add('limitWarn'); }
    if (!uiTick) uiTick = setInterval(tickTimer, 500);
    tickTimer();
    return;
  }
  if (uiTick) { clearInterval(uiTick); uiTick = null; }
  if (state === 'countdown') { controls.style.display = 'none'; setStatus('Get ready…'); return; }
  if (state === 'stopping' || state === 'finalizing') {
    controls.style.display = 'none'; previewWrap.classList.remove('show'); timerEl.classList.remove('show');
    setStatus(ctx.stopSource === 'limit' ? `⏱ Recording limit reached (${Math.round(recordingLimitSec / 60)} min) — saving…` : 'Finishing…', 'uploading');
    return;
  }
  if (state === 'uploading') {
    controls.style.display = 'none'; timerEl.classList.remove('show');
    const pct = projection.uploadedPct;
    const mb = lastBlob ? ` (${(lastBlob.size / 1048576).toFixed(1)} MB)` : '';
    setStatus(pct != null && pct > 0 && pct < 100 ? `Uploading… ${pct}%${mb}` : `Uploading…${mb}`, 'uploading');
    return;
  }
  if (state === 'upload_failed') { renderUploadFailed(ctx); return; }
  if (state === 'completed') { setStatus('Saved ✓  Opening your video…', 'done'); return; }
  if (state === 'saved_locally') { setStatus('Saved to your device. The recording is kept here for recovery until you discard it.', 'done'); showStartButton(); return; }
  if (state === 'permission_denied') { renderPermissionDenied(ctx); return; }
  if (state === 'idle' && renderedWarning !== null) renderedWarning = null;
}
let renderedWarning = null;

function tickTimer() {
  const s = Math.floor(machine.elapsedMs() / 1000);
  const text = fmtClock(s);
  timerEl.textContent = text;
  overlayMsg({ type: 'SR_OVERLAY_TICK', text });
}

/** docs/03 §3.9 — Retry / Save to device / Discard; plan refusals get the quota options. */
function renderUploadFailed(ctx) {
  controls.style.display = 'none'; timerEl.classList.remove('show'); previewWrap.classList.remove('show');
  const code = ctx.lastError;
  const message = lastUploadMessage;
  if (code === 'plan_limit') { showUpgradePrompt(message); showQuotaOptions(); return; }
  if (code === 'unauthorized') { showStartButton('Session expired — please sign in again via the extension popup.'); showDownloadFallback(); return; }
  if (code === 'empty') { showStartButton('Nothing was recorded — please try again.'); return; }
  showStartButton(code === 'timeout' ? 'Upload timed out — check your connection and try again.' : 'Upload failed: ' + (message || code || 'error'));
  let retry = document.getElementById('retryUpload');
  if (!retry) {
    retry = document.createElement('button');
    retry.id = 'retryUpload'; retry.className = 'btn btn-start'; retry.style.marginTop = '10px';
    retry.textContent = '↻ Retry upload';
    retry.addEventListener('click', () => { retry.style.display = 'none'; machine.send({ type: 'RETRY_UPLOAD' }); });
    (mainBtn.parentNode || document.body).insertBefore(retry, mainBtn.nextSibling);
  }
  retry.style.display = ctx.retryable ? '' : 'none';
  showDownloadFallback();
}

/** docs/03 §3.2 — mic denied is an explicit choice; other failures show the docs/18 §4 copy. */
function renderPermissionDenied(ctx) {
  controls.style.display = 'none'; previewWrap.classList.remove('show');
  const code = ctx.lastError;
  let box = document.getElementById('permissionChoice');
  if (box) box.remove();
  if (code === 'mic_denied') {
    mainBtn.style.display = 'none';
    setStatus('Your microphone could not be accessed. Record without it, fix the permission, or cancel.', 'uploading');
    box = document.createElement('div');
    box.id = 'permissionChoice'; box.className = 'recovery-actions'; box.style.justifyContent = 'center'; box.style.marginTop = '10px';
    const mk = (label, cls, fn) => { const b = document.createElement('button'); b.className = `btn ${cls}`; b.textContent = label; b.addEventListener('click', () => { box.remove(); fn(); }); box.appendChild(b); };
    mk('🎙 Record without mic', 'btn-start', () => machine.send({ type: 'RETRY', config: { audio: false } }));
    mk('🔧 Fix permission', 'btn-pause', () => { openTab('chrome://settings/content/microphone'); machine.send({ type: 'RETRY' }); });
    mk('✕ Cancel', 'btn-cancel', () => machine.send({ type: 'DISMISS' }));
    (mainBtn.parentNode || document.body).insertBefore(box, mainBtn.nextSibling);
    return;
  }
  const copy = {
    permission_dismissed: 'Click “Start Recording”, then choose what to share.',
    permission_denied: 'Screen recording was blocked. Allow it in your browser settings, then click Start again.',
    no_device: 'No camera or microphone was found. Connect one, or record without it.',
    tab_capture_failed: 'This tab could not be captured — try “Entire Screen” instead.',
    constraint_failed: 'Your device could not record at this quality. Try a lower quality.',
    device_busy: 'The camera or microphone is in use by another app.',
  };
  // The Start button's default handler sends RETRY while in permission_denied.
  showStartButton(copy[code] || ('Error: ' + (code || 'could not start recording')));
}

// ── Commands (docs/03 §12): buttons, popup and overlay → events ─────────────
async function startRecording() {
  hideRecoveryCard();
  ['quotaBlocked', 'permissionChoice', 'retryUpload', 'dlFallback', 'quotaRetry'].forEach((id) => { const el = document.getElementById(id); if (el) el.remove(); });
  mainBtn.textContent = '▶ Start Recording';
  const config = { ...opts };
  if (machine.state === 'idle') {
    // T-402: local recovery protection (docs/05 §4) — refuse to start with under
    // 500 MB of free storage (better than dying mid-recording); warn under 2 GB.
    // A store that cannot be opened leaves the take unprotected but never
    // prevents recording: better un-protected than not recorded (docs/03 §7).
    const store = await openLocalStore();
    if (store) {
      const space = await store.checkSpace().catch(() => ({ level: 'unknown', ok: true }));
      if (!space.ok) { showStartButton('Not enough free disk space to protect this recording (under 500 MB). Free up space and try again.'); return; }
      if (space.level === 'warn') overlayMsg({ type: 'SR_OVERLAY_WARN', text: 'Low disk space — recovery protection may run out during a long recording.' });
    }
    machine.send({ type: 'START', config, durationLimitSec: recordingLimitSec });
  }
  else if (machine.state === 'permission_denied') machine.send({ type: 'RETRY' });
  else if (machine.state === 'upload_failed') {
    // Starting over never discards a failed take silently: it is kept as
    // `failed` and the relaunch's recovery scan offers it (docs/05 §6).
    keepLocalSessionForRecovery();
    window.location.reload();
  }
  else if (machine.state === 'saved_locally' || machine.state === 'completed') { window.location.reload(); }
}
mainBtn.addEventListener('click', () => { if (!mainBtn.dataset.custom) startRecording(); });
pauseBtn.addEventListener('click', () => machine.send({ type: machine.state === 'paused' ? 'RESUME' : 'PAUSE' }));
stopBtn.addEventListener('click', () => machine.send({ type: 'STOP', source: 'user' }));
cancelBtn.addEventListener('click', () => { machine.send({ type: 'CANCEL' }); setTimeout(closeWindow, 300); });
copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(linkUrl.textContent).then(() => { copyBtn.textContent = '✓ Copied!'; setTimeout(() => { copyBtn.textContent = '🔗 Copy Link'; }, 2000); });
});

// Remote controls — from the popup (STOP_RECORDING) and the on-screen overlay
// toolbar (SR_PAUSE / SR_STOP / SR_CANCEL / SR_RESTART). Invalid-in-state
// commands are ignored by the machine and logged, never crash.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'STOP_RECORDING' || msg.type === 'SR_STOP') machine.send({ type: 'STOP', source: 'user' });
  if (msg.type === 'SR_PAUSE') machine.send({ type: machine.state === 'paused' ? 'RESUME' : 'PAUSE' });
  if (msg.type === 'SR_CANCEL') { machine.send({ type: 'CANCEL' }); setTimeout(closeWindow, 300); }
  if (msg.type === 'SR_RESTART') machine.send({ type: 'RESTART' });
});

// docs/03 §9: closing the window while a take is active or uploading warns; on a
// real unload the IndexedDB data survives → recovery on next launch.
window.addEventListener('beforeunload', (e) => {
  const s = machine.state;
  if (['recording', 'paused', 'stopping', 'finalizing', 'uploading'].includes(s)) { e.preventDefault(); e.returnValue = ''; }
});

// On load: read options carried from popup, run the recovery scan (docs/05 §6,
// docs/03 §3.1 — BEFORE anything else), the quota pre-flight (docs/03 §3.0),
// then auto-start only when nothing needs the user's attention.
(async () => {
  try {
    const { recOptions } = await chrome.storage.local.get('recOptions');
    if (recOptions) opts = { ...opts, ...recOptions };
  } catch {}
  // Normalise the legacy countdown flag: true = 3 s, false/0 = none.
  if (opts.countdown === true) opts.countdown = 3;
  if (!opts.countdown) opts.countdown = 0;
  setStatus('Preparing your recording…');
  await loadPlanLimit();           // match the countdown to the user's plan
  const verdict = await runRecoveryScan().catch(() => ({ proceed: true }));
  if (!verdict.proceed) return;
  const quota = await loadQuotaPreflight();
  if (quota.state === 'blocked') { showQuotaBlocked(quota); return; }
  if (quota.state === 'warn') overlayMsg({ type: 'SR_OVERLAY_WARN', text: quota.message });
  startRecording();
})();
