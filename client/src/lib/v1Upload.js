// ─────────────────────────────────────────────────────────────────────────────
// T-305 — browser-direct single-PUT upload (docs/06 §12).
//
// The file goes browser → object storage. The application server only ever
// sees JSON: it creates the recording, opens a single-PUT session, mints ONE
// presigned URL (signed with the exact Content-Length, so storage itself
// refuses any other size), and finalises after the browser reports completion.
// No video bytes are posted to `/api/*` anywhere in this module.
//
// ── THE FALLBACK BOUNDARY ───────────────────────────────────────────────────
// A caller may fall back to the legacy `/api/upload` path ONLY while nothing
// has been established on the v1 side — that is, until the upload session is
// created. Every error thrown before that point carries `fallbackAllowed:true`
// and leaves no v1 state behind (a recording row created for a session that
// then failed is deleted best-effort before the error is thrown).
//
// Once the session exists, `fallbackAllowed` is false for every error. Falling
// back after that would upload the same file a second time onto the legacy
// path and create a duplicate recording — precisely what the boundary exists
// to prevent. The caller surfaces the error instead.
// ─────────────────────────────────────────────────────────────────────────────

export const SINGLE_MAX_BYTES = 32 * 1024 * 1024;   // docs/06 §12: 33,554,432
const ALLOWED_MIME = new Set(['video/webm', 'video/mp4', 'video/quicktime']);

export class V1UploadError extends Error {
  constructor(message, { code = 'v1_upload_failed', status = 0, fallbackAllowed = false, userMessage } = {}) {
    super(message);
    this.name = 'V1UploadError';
    this.code = code;
    this.status = status;
    this.fallbackAllowed = fallbackAllowed;
    this.userMessage = userMessage || message;
  }
}

const newKey = () => (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID()
  : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;

/**
 * The server's decision. Any failure — offline, 5xx, malformed — returns null,
 * and null means LEGACY. The client never decides eligibility itself.
 */
export async function fetchClientConfig({ API, authFetch }) {
  try {
    const r = await authFetch(`${API}/api/client-config`);
    if (!r.ok) return null;
    const cfg = await r.json();
    return cfg && typeof cfg === 'object' ? cfg : null;
  } catch (e) {
    return null;
  }
}

/** Is the web editor told to use v1? Only an explicit `path:"v1"` counts. */
export const webUploadIsV1 = (cfg) => !!(cfg && cfg.webUpload && cfg.webUpload.path === 'v1');

/**
 * Pre-session checks. A file that cannot use single mode is not an error:
 * nothing has been created yet, so the caller simply uses the legacy path.
 */
export function preflightSingle(file) {
  if (!file) return { ok: false, reason: 'no_file' };
  if (!(file.size > 0)) return { ok: false, reason: 'empty' };
  if (file.size > SINGLE_MAX_BYTES) return { ok: false, reason: 'too_large_for_single' };
  const mimeType = (file.type || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_MIME.has(mimeType)) return { ok: false, reason: 'unsupported_mime' };
  return { ok: true, mimeType };
}

/**
 * Client-side duration read so the timeline has a length before probing.
 *
 * MediaRecorder-produced WebM carries no duration in its header, so the
 * browser reports `Infinity` until it has scanned the file. Seeking to a huge
 * time forces that scan (`durationchange` then fires with the real value) —
 * the same quirk the server-side fixwebm exists for. Anything that still
 * cannot be measured resolves to 0 rather than blocking the upload.
 */
export function measureDuration(file) {
  return new Promise((resolve) => {
    let settled = false;
    let v = null;
    const done = (d) => {
      if (settled) return;
      settled = true;
      try { if (v) { v.onloadedmetadata = v.ondurationchange = v.onerror = null; URL.revokeObjectURL(v.src); v.src = ''; } } catch (e) {}
      resolve(Number.isFinite(d) && d > 0 ? d : 0);
    };
    try {
      v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.onerror = () => done(0);
      v.onloadedmetadata = () => {
        if (Number.isFinite(v.duration) && v.duration > 0) return done(v.duration);
        // Infinity: force the scan. durationchange reports the real length.
        v.ondurationchange = () => { if (Number.isFinite(v.duration) && v.duration > 0) done(v.duration); };
        try { v.currentTime = 1e101; } catch (e) { done(0); }
      };
      setTimeout(() => done(0), 8000);   // never hold the upload hostage
      v.src = URL.createObjectURL(file);
    } catch (e) { done(0); }
  });
}

async function readJson(res) {
  try { return await res.json(); } catch (e) { return {}; }
}

function apiError(res, body, phase, fallbackAllowed) {
  const err = (body && body.error) || {};
  const code = err.code || `${phase}_failed`;
  return new V1UploadError(`${phase}: ${res.status} ${code}`, {
    code, status: res.status, fallbackAllowed,
    userMessage: err.message || 'Could not upload that clip.',
  });
}

/** Browser → storage PUT with progress. Never touches the API origin. */
function putDirect(url, file, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    // Content-Type was signed into the URL, so it must be sent exactly.
    // Content-Length is also signed; the browser sets it from the body itself
    // (it is a forbidden header for scripts), which is exactly what we want.
    if (contentType) xhr.setRequestHeader('Content-Type', contentType);
    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) onProgress(ev.loaded / ev.total); };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve({ status: xhr.status, etag: xhr.getResponseHeader('ETag') });
      else reject(new V1UploadError(`storage PUT ${xhr.status}`, {
        code: 'storage_put_failed', status: xhr.status, fallbackAllowed: false,
        userMessage: 'The upload to storage was refused. Please try again.',
      }));
    };
    xhr.onerror = () => reject(new V1UploadError('storage PUT network error', {
      code: 'storage_put_network', fallbackAllowed: false,
      userMessage: 'Network error while uploading. Please try again.',
    }));
    xhr.send(file);
  });
}

/**
 * Upload one file through the v1 single-PUT protocol.
 *
 * Resolves `{ recordingId, uploadSessionId, playbackUrl }`.
 * Rejects with V1UploadError; inspect `fallbackAllowed` before ever using the
 * legacy path (see THE FALLBACK BOUNDARY above).
 */
export async function uploadSingle({ API, authFetch, file, title, onProgress }) {
  const pre = preflightSingle(file);
  if (!pre.ok) {
    throw new V1UploadError(`preflight: ${pre.reason}`, { code: pre.reason, fallbackAllowed: true });
  }
  const json = { 'Content-Type': 'application/json' };

  // 1. The recording row. Failure here leaves nothing behind → fallback OK.
  const recRes = await authFetch(`${API}/api/v1/recordings`, {
    method: 'POST', headers: { ...json, 'Idempotency-Key': newKey() },
    body: JSON.stringify({ title, source: 'web_upload' }),
  });
  const rec = await readJson(recRes);
  if (!recRes.ok || !rec.id) throw apiError(recRes, rec, 'create_recording', true);

  // 2. The single-PUT session. Failure → delete the recording we just made so
  //    the legacy path does not leave a duplicate, empty recording behind.
  const sesRes = await authFetch(`${API}/api/v1/uploads`, {
    method: 'POST', headers: { ...json, 'Idempotency-Key': newKey() },
    body: JSON.stringify({ recordingId: rec.id, mimeType: pre.mimeType, mode: 'single', sizeBytes: file.size }),
  });
  const ses = await readJson(sesRes);
  if (!sesRes.ok || !ses.uploadSessionId || !ses.uploadUrl) {
    try { await authFetch(`${API}/api/v1/recordings/${rec.id}`, { method: 'DELETE' }); } catch (e) {}
    throw apiError(sesRes, ses, 'create_session', true);
  }

  // ── Boundary: a v1 session now exists. No fallback from here on. ─────────

  // 3. Browser → storage. The URL is a bearer credential for one object.
  await putDirect(ses.uploadUrl, file, pre.mimeType, onProgress);

  // 4. Complete: an empty parts list; the server HEADs the object.
  const doneRes = await authFetch(`${API}/api/v1/uploads/${ses.uploadSessionId}/complete`, {
    method: 'POST', headers: json, body: JSON.stringify({ parts: [] }),
  });
  const done = await readJson(doneRes);
  if (!doneRes.ok) throw apiError(doneRes, done, 'complete', false);

  // 5. The playable, signed URL — minted only after the scoped read.
  const detRes = await authFetch(`${API}/api/v1/recordings/${rec.id}`);
  const det = await readJson(detRes);
  if (!detRes.ok) throw apiError(detRes, det, 'detail', false);

  return { recordingId: rec.id, uploadSessionId: ses.uploadSessionId, playbackUrl: det.playbackUrl || null };
}
