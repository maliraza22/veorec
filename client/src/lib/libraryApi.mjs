// ─────────────────────────────────────────────────────────────────────────────
// T-803 — the library's data layer (dashboard, folders, notifications).
//
// ONE module knows which API the signed-in pages talk to. The server decides
// (`GET /api/client-config` → `library.path`); the pages never guess.
//
//   • path 'v1'     → /api/v1/recordings, /api/v1/folders, /api/v1/notifications
//                     (PostgreSQL; thumbnails are signed storage URLs, with the
//                     Cloudinary poster as a READ fallback for legacy rows the
//                     backfill has not reached — no Cloudinary listing, ever).
//   • path 'legacy' → /api/recordings, /api/folders, /api/notifications exactly
//                     as before (the flag is OFF by default).
//
// Every list item is normalised to the card shape the pages already render,
// tagged with `source` so writes (rename/meta/delete) follow the right API.
// Pure helpers are exported for the node tests.
// ─────────────────────────────────────────────────────────────────────────────

export const PAGE_SIZE = 100;
export const MAX_PAGES = 20;          // 2,000 recordings per list — the dashboard is whole-library

const safeJson = async (r) => { try { return await r.json(); } catch { return null; } };
const errMessage = (body, fallback) => (body && body.error && typeof body.error === 'object' ? body.error.message : (body && typeof body.error === 'string' ? body.error : null)) || fallback;
const ms = (v) => (v == null ? null : (typeof v === 'number' ? v : new Date(v).getTime()));

/** Only an explicit `library.path === 'v1'` counts; anything else is legacy. */
export const libraryIsV1 = (cfg) => !!(cfg && cfg.library && cfg.library.path === 'v1');

/** A v1 RecordingSummary → the card shape (docs/08 §4 → what Dashboard/Folders render). */
export function normalizeSummary(r) {
  return {
    source: 'v1',
    id: r.id, title: r.title || 'Untitled Recording', status: r.status,
    thumbnail: r.thumbnailUrl || r.posterUrl || null,
    posterUrl: r.posterUrl || null,
    previewUrl: r.previewUrl || null,
    // Legacy card fields: a v1 card never plays the full file on hover and
    // never builds a Cloudinary URL.
    filename: null, cloudinary: false, legacyMedia: !!r.legacyMedia,
    size: r.size_bytes ?? null, duration: r.duration ?? 0,
    created_at: ms(r.created_at), views: r.views ?? 0, commentCount: r.commentCount ?? 0,
    privacy: r.privacy, folder: r.folder_id ?? null, archived: !!r.archived,
    tags: Array.isArray(r.tags) ? r.tags : [], ai_status: r.ai_status ?? null,
    description: r.description ?? '', cta: r.cta ?? null,
    trimStart: r.trimStart ?? null, trimEnd: r.trimEnd ?? null,
    animatedThumbnail: r.animatedThumbnail !== false,
  };
}

/** A legacy list row, tagged. Unchanged fields — the legacy card renders them as before. */
export const normalizeLegacy = (r) => ({ ...r, source: 'legacy', previewUrl: null, legacyMedia: true });

/** A v1 folder → the shape the pages use. */
export const normalizeFolder = (f) => ({ id: f.id, name: f.name, created_at: ms(f.created_at) });

/**
 * The client for the signed-in library pages.
 * `authFetch` is the AuthContext fetch (Bearer attached); `useV1` is the server's decision.
 */
export function createLibraryClient({ API, authFetch, useV1 }) {
  const base = useV1 ? `${API}/api/v1` : `${API}/api`;
  const json = (init = {}, body) => ({ ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

  async function listV1(archived) {
    const items = [];
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const u = new URLSearchParams({ limit: String(PAGE_SIZE), archived: archived ? 'true' : 'false' });
      if (cursor) u.set('cursor', cursor);
      const r = await authFetch(`${base}/recordings?${u.toString()}`);
      if (!r.ok) throw new Error(errMessage(await safeJson(r), 'Could not load your library.'));
      const body = await safeJson(r);
      for (const it of (body && body.items) || []) items.push(normalizeSummary(it));
      cursor = body && body.nextCursor;
      if (!cursor) break;
    }
    return items;
  }

  return {
    useV1,
    /** Every recording (live + archived), newest first. */
    async listRecordings() {
      if (!useV1) {
        const r = await authFetch(`${base}/recordings`);
        const body = await safeJson(r);
        return Array.isArray(body) ? body.map(normalizeLegacy) : [];
      }
      const [live, archived] = await Promise.all([listV1(false), listV1(true)]);
      return [...live, ...archived].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    },
    async listFolders() {
      const r = await authFetch(`${base}/folders`);
      const body = await safeJson(r);
      if (!useV1) return Array.isArray(body) ? body : [];
      return ((body && body.items) || []).map(normalizeFolder);
    },
    async createFolder(name) {
      const r = await authFetch(`${base}/folders`, json({ method: 'POST' }, { name }));
      const body = await safeJson(r);
      if (!r.ok) return { error: errMessage(body, 'Could not create the folder.') };
      return { folder: useV1 ? normalizeFolder(body) : body };
    },
    async renameFolder(id, name) {
      const r = await authFetch(`${base}/folders/${encodeURIComponent(id)}`, json({ method: 'PATCH' }, { name }));
      const body = await safeJson(r);
      if (!r.ok) return { error: errMessage(body, 'Could not rename the folder.') };
      return { folder: useV1 ? normalizeFolder(body) : body };
    },
    async deleteFolder(id) {
      const r = await authFetch(`${base}/folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return { ok: r.ok };
    },
    /** Writes on one recording follow ITS source, not the page's path. */
    recordingBase(rec) { return rec && rec.source === 'v1' ? `${API}/api/v1/recordings/${encodeURIComponent(rec.id)}` : `${API}/api/recordings/${encodeURIComponent(rec.id)}`; },
    async patchMeta(rec, patch) {
      const r = await authFetch(`${this.recordingBase(rec)}/meta`, json({ method: 'PATCH' }, patch));
      const body = await safeJson(r);
      return r.ok ? { meta: body } : { error: errMessage(body, 'Could not save the change.'), code: body && body.error && body.error.code };
    },
    async rename(rec, title) {
      const r = await authFetch(this.recordingBase(rec), json({ method: 'PATCH' }, { title }));
      const body = await safeJson(r);
      return r.ok ? { title: (body && body.title) || title } : { error: errMessage(body, 'Could not rename the video.') };
    },
    async remove(rec) {
      const r = await authFetch(this.recordingBase(rec), { method: 'DELETE' });
      return { ok: r.ok };
    },
    async notifications() {
      const r = await authFetch(`${base}/notifications`);
      const body = await safeJson(r);
      if (!r.ok || !body) return null;
      return { items: Array.isArray(body.items) ? body.items : [], unread: body.unread || 0, lastReadAt: body.lastReadAt || 0 };
    },
    async markNotificationsRead() {
      const r = await authFetch(`${base}/notifications/read`, { method: 'POST' });
      return r.ok;
    },
  };
}
