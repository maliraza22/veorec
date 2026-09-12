// ─────────────────────────────────────────────────────────────────────────────
// T-802 — the watch page's data layer (docs/11 §1–§2, docs/08 §7, docs/12).
//
// ONE module knows which API the page is talking to. The server decides
// (`GET /api/client-config/public` → `watch.path`); the page never guesses.
//
//   • path 'v1'     → /api/v1/watch/* (PostgreSQL + signed storage URLs). A
//                     recording the v1 API does not know (404 recording_not_found)
//                     is a LEGACY recording that the T-204 backfill has not
//                     reached yet, so the page falls back to /api/watch/* for
//                     that id — one deterministic request, not a retry loop.
//   • path 'legacy' → /api/watch/* exactly as before (the flag is OFF by default).
//
// Page state is DRIVEN BY THE API (docs/11 §1): `stateFor(rec)` maps the
// payload to one of the explicit states; nothing here waits on a timer to
// decide whether a video is ready.
//
// Pure helpers are exported for unit tests (this file is plain ESM and runs
// in node as well as in the browser bundle).
// ─────────────────────────────────────────────────────────────────────────────

export const PROCESSING_STATUSES = new Set(['recording', 'uploading', 'uploaded', 'processing']);
export const FAILED_STATUSES = new Set(['failed', 'rejected_limit']);
export const REFRESH_LEAD_MS = 60 * 1000;          // refresh /media this long before expiry (docs/11 §2)
export const POLL_MIN_MS = 2000, POLL_MAX_MS = 5000; // status polling 2 s → 5 s backoff (docs/11 §1)

const ACCESS_KEY = (id) => `veorec_watch_access_${id}`;
const safeJson = async (r) => { try { return await r.json(); } catch { return null; } };
const errCode = (body) => (body && body.error && typeof body.error === 'object') ? body.error.code : null;

// ── access token (unlock / lead grant) — per recording, this session only ──
export function loadAccessToken(id, storage = globalThis.sessionStorage) {
  try { return storage ? storage.getItem(ACCESS_KEY(id)) || null : null; } catch { return null; }
}
export function saveAccessToken(id, token, storage = globalThis.sessionStorage) {
  try { if (!storage) return; if (token) storage.setItem(ACCESS_KEY(id), token); else storage.removeItem(ACCESS_KEY(id)); } catch {}
}

/** Only an explicit `watch.path === 'v1'` counts; anything else is legacy. */
export const watchIsV1 = (cfg) => !!(cfg && cfg.watch && cfg.watch.path === 'v1');

/** The server's decision for anonymous viewers. Any failure → null → legacy. */
export async function fetchWatchConfig({ API, fetchImpl = globalThis.fetch }) {
  try {
    const r = await fetchImpl(`${API}/api/client-config/public`);
    if (!r.ok) return null;
    const cfg = await safeJson(r);
    return cfg && typeof cfg === 'object' ? cfg : null;
  } catch { return null; }
}

/** Explicit page state from the payload (docs/11 §1). */
export function stateFor(rec) {
  if (!rec) return 'loading';
  if (rec.requiresPassword) return 'password_gate';
  if (rec.requiresEmail) return 'email_gate';
  if (FAILED_STATUSES.has(rec.status)) return 'failed';
  if (PROCESSING_STATUSES.has(rec.status)) return 'processing';
  return 'ready';
}

/** Poll delay: 2 s for the first few polls, then 5 s (docs/11 §1). */
export const pollDelay = (attempt) => (attempt < 5 ? POLL_MIN_MS : POLL_MAX_MS);

/** Should the media URLs be refreshed now? (expiresAt − now < 60 s) */
export function shouldRefresh(expiresAt, now = Date.now()) {
  const t = expiresAt ? new Date(expiresAt).getTime() : NaN;
  return !Number.isFinite(t) || t - now < REFRESH_LEAD_MS;
}

/** Milliseconds until the refresh timer should fire (never below 1 s). */
export function refreshDelay(expiresAt, now = Date.now()) {
  const t = expiresAt ? new Date(expiresAt).getTime() : NaN;
  if (!Number.isFinite(t)) return 1000;
  return Math.max(1000, t - now - REFRESH_LEAD_MS);
}

/**
 * One recording shape for the page, whichever API answered.
 * `source` tells the page which write endpoints and engagement routes apply.
 */
export function normalizePayload(data, source) {
  if (!data) return null;
  if (source === 'v1') {
    return {
      source: 'v1',
      id: data.id, title: data.title, description: data.description || '',
      status: data.status, failureCode: data.failureCode ?? null,
      duration: data.duration ?? null, width: data.width ?? null, height: data.height ?? null,
      privacy: data.privacy, created_at: data.created_at ? new Date(data.created_at).getTime() : null,
      author: data.author && data.author.name ? data.author.name : '',
      branding: data.branding !== false,
      chapters: Array.isArray(data.chapters) ? data.chapters : [],
      audience: data.audience || {}, cta: data.cta ?? null,
      trimStart: data.trimStart ?? null, trimEnd: data.trimEnd ?? null, segments: data.segments ?? null,
      recommendedSpeed: data.recommendedSpeed ?? null, animatedThumbnail: data.animatedThumbnail !== false,
      archived: !!data.archived, tags: Array.isArray(data.tags) ? data.tags : [], folder: null,
      views: data.views ?? 0, ai_status: data.ai_status ?? null,
      requiresEmail: data.requiresEmail === true, requiresPassword: data.requiresPassword === true,
      viewer: data.viewer || { isOwner: false, isAdmin: false, via: null, signedIn: false },
      legacy: null,
    };
  }
  // Legacy /api/watch payload (JSON store + Cloudinary). Media readiness is a
  // guess there (the file may still be finalising), so the page keeps the
  // legacy overlay ONLY for this source.
  return {
    source: 'legacy',
    id: data.id, title: data.title, description: data.description || '',
    status: 'ready', failureCode: null,
    duration: data.duration ?? null, width: null, height: null,
    privacy: data.privacy || 'public', created_at: data.created_at ?? null,
    author: typeof data.author === 'string' ? data.author : (data.author && data.author.name) || '',
    branding: data.branding !== false,
    chapters: Array.isArray(data.chapters) ? data.chapters : [],
    audience: data.audience || {}, cta: data.cta ?? null,
    trimStart: data.trimStart ?? null, trimEnd: data.trimEnd ?? null, segments: data.segments ?? null,
    recommendedSpeed: data.recommendedSpeed ?? null, animatedThumbnail: data.animatedThumbnail !== false,
    archived: !!data.archived, tags: Array.isArray(data.tags) ? data.tags : [], folder: data.folder ?? null,
    views: data.views ?? 0, ai_status: null,
    requiresEmail: false, requiresPassword: data.requiresPassword === true,
    viewer: { isOwner: false, isAdmin: false, via: null, signedIn: false },
    legacy: { cloudinary: !!data.cloudinary, filename: data.filename || '' },
  };
}

/** Legacy media resolution (Cloudinary URL or /uploads) — the pre-T-801 rule, unchanged. */
export function legacyMedia(rec, API) {
  const l = rec && rec.legacy;
  if (!l) return null;
  const src = l.cloudinary ? l.filename : `${API}/uploads/${l.filename}`;
  const downloadUrl = (l.cloudinary && src.includes('/upload/')) ? src.replace('/upload/', '/upload/fl_attachment/') : src;
  return { mp4Url: src, hlsUrl: null, posterUrl: null, captionsUrl: null, expiresAt: null, downloadUrl, isWebm: /\.webm(\?|$)/i.test(src) };
}

/**
 * The client for one recording. `API` is the origin ('' in dev), `authHeaders()`
 * returns the Bearer header when signed in, `shareToken` comes from `?s=`.
 */
export function createWatchClient({ API, id, authHeaders = () => ({}), shareToken = null, fetchImpl = globalThis.fetch, storage = globalThis.sessionStorage }) {
  let accessToken = loadAccessToken(id, storage);
  const url = (p, params = {}) => {
    const u = new URLSearchParams();
    if (shareToken) u.set('s', shareToken);
    for (const [k, v] of Object.entries(params)) if (v != null) u.set(k, v);
    const q = u.toString();
    return `${API}/api/v1/watch/${encodeURIComponent(id)}${p}${q ? `?${q}` : ''}`;
  };
  const headers = (extra = {}) => ({ ...authHeaders(), ...(accessToken ? { 'X-Watch-Access': accessToken } : {}), ...extra });
  const v1 = (p, init = {}, params = {}) => fetchImpl(url(p, params), { ...init, headers: headers(init.headers || {}) });
  const legacy = (p, init = {}) => fetchImpl(`${API}/api/watch/${encodeURIComponent(id)}${p}`, { ...init, headers: { ...authHeaders(), ...(init.headers || {}) } });

  const gateFrom = (status, body) => {
    const code = errCode(body);
    if (status === 401 && (code === 'login_required' || (body && body.error === 'login_required'))) return { state: 'login_gate', title: (body && (body.title || (body.error && body.error.meta && body.error.meta.title))) || '' };
    if (status === 403 && code === 'link_expired') return { state: 'link_expired' };
    if (status === 403 && code === 'password_required') return { state: 'password_gate' };
    if (status === 403 && code === 'email_required') return { state: 'email_gate' };
    if (status === 404) return { state: 'not_found' };
    return { state: 'error', code: code || null, status };
  };

  return {
    get source() { return this._source; },
    _source: 'v1',
    get accessToken() { return accessToken; },
    setAccessToken(t) { accessToken = t || null; saveAccessToken(id, accessToken, storage); },

    /**
     * Load the watch payload. Resolves `{rec}` or `{gate:{state,...}}`.
     * On the v1 path an unknown id falls back to legacy ONCE (see header).
     */
    async load({ useV1 }) {
      if (useV1) {
        const r = await v1('');
        const body = await safeJson(r);
        if (r.ok) { this._source = 'v1'; return { rec: normalizePayload(body, 'v1') }; }
        if (!(r.status === 404 && errCode(body) === 'recording_not_found')) return { gate: gateFrom(r.status, body) };
        // fall through: not a v1 recording (yet)
      }
      this._source = 'legacy';
      const r = await legacy('');
      const body = await safeJson(r);
      if (r.ok) return { rec: normalizePayload(body, 'legacy') };
      if (r.status === 401 && body && body.error === 'login_required') return { gate: { state: 'login_gate', title: body.title || '' } };
      return { gate: gateFrom(r.status, body) };
    },

    async unlock(password) {
      if (this._source === 'legacy') {
        const r = await legacy('/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
        const body = await safeJson(r);
        if (!r.ok) return { error: (body && body.error) || 'Wrong password' };
        return { rec: normalizePayload(body, 'legacy') };
      }
      const r = await v1('/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      const body = await safeJson(r);
      if (!r.ok) return { error: errCode(body) === 'rate_limited' ? 'Too many attempts — please wait a moment.' : (body && body.error && body.error.message) || 'Wrong password', code: errCode(body) };
      if (body.accessToken) this.setAccessToken(body.accessToken);
      return { rec: normalizePayload(body, 'v1') };
    },

    /** Signed media URLs (v1) or the legacy rule. `{media}` or `{gate}`. */
    async media({ rec, disposition = null } = {}) {
      if (this._source === 'legacy') return { media: legacyMedia(rec, API) };
      const r = await v1('/media', {}, { disposition });
      const body = await safeJson(r);
      if (!r.ok) return { gate: gateFrom(r.status, body) };
      return { media: { mp4Url: body.mp4Url || null, hlsUrl: body.hlsUrl || null, posterUrl: body.posterUrl || null, captionsUrl: body.captionsUrl || null, expiresAt: body.expiresAt || null, ttlSeconds: body.ttlSeconds || null, status: body.status, download: body.download !== false, downloadUrl: null, isWebm: false } };
    },

    /** The download URL is minted on demand (its own signature carries the disposition). */
    async downloadUrl({ rec }) {
      if (this._source === 'legacy') { const m = legacyMedia(rec, API); return m ? m.downloadUrl : null; }
      const r = await v1('/media', {}, { disposition: 'attachment' });
      const body = await safeJson(r);
      return r.ok && body ? body.mp4Url || null : null;
    },

    async transcript() {
      const r = this._source === 'legacy' ? await legacy('/transcript') : await v1('/transcript');
      const body = await safeJson(r);
      if (!r.ok) return { error: errCode(body) || 'unavailable', status: r.status };
      return { transcript: body };
    },

    async lead({ email, name }) {
      if (this._source === 'legacy') {
        const r = await legacy('/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, name }) });
        return { ok: r.ok };
      }
      const r = await v1('/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, name }) });
      const body = await safeJson(r);
      if (!r.ok) return { ok: false, error: (body && body.error && body.error.message) || 'Could not submit.' };
      if (body.accessToken) this.setAccessToken(body.accessToken);
      return { ok: true };
    },

    /** Re-fetch the payload for status polling (viewers and owners alike). */
    async poll() {
      const r = await (this._source === 'legacy' ? legacy('') : v1(''));
      const body = await safeJson(r);
      if (!r.ok) return null;
      return normalizePayload(body, this._source);
    },
  };
}

/** Map a MediaError / hls.js error to the docs/11 §5 classes. */
export function classifyPlaybackError({ mediaError = null, hlsError = null } = {}) {
  if (hlsError) {
    if (hlsError.type === 'networkError') return hlsError.response && hlsError.response.code === 404 ? 'removed' : 'network';
    if (hlsError.type === 'mediaError') return 'decode';
    return 'other';
  }
  const code = mediaError && mediaError.code;
  if (code === 2) return 'network';
  if (code === 3) return 'decode';
  if (code === 4) return 'unsupported';
  return code ? 'other' : null;
}
