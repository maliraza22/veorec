// ─────────────────────────────────────────────────────────────────────────────
// T-1201 — the editor's data layer (edit sessions, render jobs, silence removal).
//
// ONE module knows which API the editor talks to. The server decides
// (`GET /api/client-config` → `editor.path`); the page never guesses.
//
//   • path 'v1'     → /api/v1/recordings/:id (detail + gallery), edit sessions
//                     (`POST /recordings/:id/edit-sessions` → `POST /edit-sessions/:id/render`
//                     → poll `GET /render-jobs/:id` with REAL progress), the
//                     virtual save (`PATCH /recordings/:id/meta`) and silence
//                     removal (`POST` then poll `GET /recordings/:id/remove-silences`).
//                     The worker renders; sources are never modified (docs/14).
//   • path 'legacy' → /api/recordings/:id/{trim,compose,meta,remove-silences}
//                     exactly as before (the flag is OFF by default).
//
// Results are normalised to the shapes the page already renders; errors come
// back as `{ error, code, upgradeRequired }` (never thrown for a server
// refusal — the page decides how to show a paywall). Pure helpers are
// exported for the node tests.
// ─────────────────────────────────────────────────────────────────────────────

export const RENDER_TERMINAL = new Set(['done', 'failed']);
export const SILENCE_TERMINAL = new Set(['completed', 'failed', 'cancelled']);
export const MAX_POLLS = 2400;              // ≈ 2 h at the 3 s ceiling — a render never spins forever

const safeJson = async (r) => { try { return await r.json(); } catch { return null; } };
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Only an explicit `editor.path === 'v1'` counts; anything else is legacy. */
export const editorIsV1 = (cfg) => !!(cfg && cfg.editor && cfg.editor.path === 'v1');

/** The nested v1 error contract, or the legacy `{error: 'text', code}` — one shape for the page. */
export function errorOf(body, fallback = 'Something went wrong.') {
  if (body && body.error && typeof body.error === 'object') {
    return { error: body.error.message || fallback, code: body.error.code || null, upgradeRequired: body.error.upgradeRequired === true };
  }
  return { error: (body && typeof body.error === 'string' && body.error) || fallback, code: (body && body.code) || null, upgradeRequired: !!(body && body.upgradeRequired) };
}

/** Poll delay for a render / silence job: 1.5 s → 3 s. */
export const pollDelay = (attempt) => Math.min(3000, 1500 + attempt * 250);

/** The whole-video timeline, honouring an existing virtual edit (segments, else trims). */
export function timelineFromRecording(rec) {
  const dur = Number(rec && rec.duration) || 0;
  if (rec && Array.isArray(rec.segments) && rec.segments.length) {
    return rec.segments.map((sg) => ({ recordingId: rec.id, start: r3(sg.start), end: r3(sg.end) }));
  }
  const st = rec && rec.trimStart != null ? Number(rec.trimStart) : 0;
  const en = rec && rec.trimEnd != null ? Number(rec.trimEnd) : dur;
  return [{ recordingId: rec.id, start: r3(st), end: r3(en || dur) }];
}

/** Editor clips ({id, in, out}) → the API timeline. */
export const clipsToTimeline = (clips) => clips.map((c) => ({ recordingId: c.id, start: r3(c.in), end: r3(c.out) }));

/** A single base clip spanning the whole video (±50 ms): saving it clears the virtual edit. */
export function isFullLength(clips, rec) {
  if (!clips || clips.length !== 1 || !rec || clips[0].id !== rec.id) return false;
  return clips[0].in <= 0.05 && clips[0].out >= (Number(rec.duration) || 0) - 0.05;
}

/** Every clip is the base recording (a single-source timeline can be saved virtually or stream-copied). */
export const isSingleSource = (clips, baseId) => clips.length > 0 && clips.every((c) => c.id === baseId);

/** A recording detail → the shape the editor renders. `filename` is the ACTIVE media URL. */
export function normalizeDetail(d, { useV1 }) {
  if (!d) return null;
  if (!useV1) return { ...d, source: 'legacy', filename: d.filename || '' };
  return {
    source: 'v1',
    id: d.id, title: d.title || 'Untitled Recording', status: d.status,
    duration: Number(d.duration) || 0,
    filename: d.mediaUrl || d.playbackUrl || '',
    segments: Array.isArray(d.segments) ? d.segments : null,
    trimStart: d.trimStart ?? null, trimEnd: d.trimEnd ?? null,
    // The v1 detail's canStitch is "ready"; the plan gate answers at render (403 feature_locked).
    canStitch: d.canStitch !== false,
    ready: d.status === 'ready',
  };
}

/** A v1 list row → a gallery card (no full-file URL exists for v1 rows; the poster is the thumbnail). */
export const normalizeGalleryItem = (r) => ({
  id: r.id, title: r.title || 'Untitled Recording', duration: Number(r.duration) || 0,
  thumbnail: r.thumbnailUrl || r.posterUrl || null, filename: null, status: r.status, source: 'v1',
});

/**
 * The editor's client. `authFetch` is the AuthContext fetch (Bearer attached);
 * `useV1` is the server's decision; `sleep` is injectable for tests.
 */
export function createEditorClient({ API, authFetch, useV1, sleep = defaultSleep }) {
  const base = useV1 ? `${API}/api/v1` : `${API}/api`;
  const json = (init = {}, body) => ({ ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const recPath = (id) => `${base}/recordings/${encodeURIComponent(id)}`;

  return {
    useV1,
    async loadRecording(id) {
      const r = await authFetch(recPath(id));
      const body = await safeJson(r);
      if (!r.ok) return { ...errorOf(body, 'Could not load this video.'), status: r.status };
      return { rec: normalizeDetail(body, { useV1 }) };
    },
    /** Other owned videos that can be added to the timeline (v1: ready only; legacy: the list as before). */
    async listGallery(excludeId) {
      if (!useV1) {
        const r = await authFetch(`${base}/recordings`);
        const body = await safeJson(r);
        return (Array.isArray(body) ? body : []).filter((v) => v.id !== excludeId);
      }
      const r = await authFetch(`${base}/recordings?limit=100&archived=false`);
      const body = await safeJson(r);
      return (((body && body.items) || []).filter((v) => v.id !== excludeId && v.status === 'ready')).map(normalizeGalleryItem);
    },
    /** The instant path: segments / trims on the recording (no render). */
    async saveVirtual(id, patch) {
      const r = await authFetch(`${recPath(id)}/meta`, json({ method: 'PATCH' }, patch));
      const body = await safeJson(r);
      return r.ok ? { ok: true } : errorOf(body, 'Could not save the change.');
    },
    /**
     * Bake the timeline. v1: an edit session + a render job (202) the caller
     * polls with `waitForRender`. Legacy: the synchronous trim/compose.
     * Returns `{ renderJobId, outputRecordingId, editSessionId }` (v1),
     * `{ done: true, id }` (legacy) or `{ error, code, upgradeRequired }`.
     */
    async startRender({ recordingId, clips, mode, title }) {
      const hasOther = clips.some((c) => c.id !== recordingId);
      if (!useV1) {
        const r = hasOther
          ? await authFetch(`${recPath(recordingId)}/compose`, json({ method: 'POST' }, { clips: clips.map((c) => ({ id: c.id, start: c.in, end: c.out })), mode }))
          : await authFetch(`${recPath(recordingId)}/trim`, json({ method: 'POST' }, { segments: clips.map((c) => ({ start: c.in, end: c.out })), mode }));
        const body = await safeJson(r);
        if (!r.ok) return errorOf(body, hasOther ? 'Save failed' : 'Trim failed');
        return { done: true, id: (body && body.id) || recordingId };
      }
      const s = await authFetch(`${recPath(recordingId)}/edit-sessions`, json({ method: 'POST' }, { timeline: clipsToTimeline(clips) }));
      const sb = await safeJson(s);
      if (!s.ok) return errorOf(sb, 'Could not start the edit.');
      const r = await authFetch(`${base}/edit-sessions/${encodeURIComponent(sb.editSessionId)}/render`, json({ method: 'POST' }, title ? { mode, title } : { mode }));
      const rb = await safeJson(r);
      if (!r.ok) return errorOf(rb, 'Could not start the render.');
      return { editSessionId: sb.editSessionId, renderJobId: rb.renderJobId, outputRecordingId: rb.outputRecordingId || recordingId };
    },
    async getRenderJob(renderJobId) {
      const r = await authFetch(`${base}/render-jobs/${encodeURIComponent(renderJobId)}`);
      const body = await safeJson(r);
      if (!r.ok) return errorOf(body, 'Could not read the render status.');
      return { status: body.status, progress: typeof body.progress === 'number' ? body.progress : 0, outputRecordingId: body.outputRecordingId || null, error: body.error || null };
    },
    /** Poll a render job until done/failed; `onProgress(0..100)`; an AbortSignal stops the wait (not the render). */
    async waitForRender(renderJobId, { onProgress = null, signal = null } = {}) {
      for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
        if (signal && signal.aborted) return { status: 'aborted' };
        const j = await this.getRenderJob(renderJobId);
        if (j.error && !j.status) return j;
        if (onProgress) onProgress(Math.max(0, Math.min(100, j.progress || 0)));
        if (RENDER_TERMINAL.has(j.status)) return j;
        await sleep(pollDelay(attempt));
      }
      return { status: 'timeout', error: 'The render is taking longer than expected. It continues in the background — check your library later.' };
    },
    /**
     * Combine whole videos (the watch page's "Combine"). v1: sugar over an edit
     * session → a copy render (202); legacy: the synchronous stitch. Resolves
     * `{ outputRecordingId, renderJobId }` (v1), `{ done: true, id }` (legacy) or an error.
     */
    async stitch(ids, { title } = {}) {
      const r = await authFetch(`${base}/recordings/stitch`, json({ method: 'POST' }, title ? { ids, title } : { ids }));
      const body = await safeJson(r);
      if (!r.ok) return errorOf(body, 'Could not combine the videos.');
      if (!useV1) return body && body.id ? { done: true, id: body.id } : errorOf(body, 'Could not combine the videos.');
      return { editSessionId: body.editSessionId, renderJobId: body.renderJobId, outputRecordingId: body.outputRecordingId };
    },
    /**
     * Silence removal. v1: request (202) then poll the job; legacy: the
     * synchronous route. Resolves `{ segments, keptSeconds, removedSeconds }`
     * or `{ error, code }`.
     */
    async removeSilences(id, { signal = null } = {}) {
      const p = await authFetch(`${recPath(id)}/remove-silences`, { method: 'POST' });
      const pb = await safeJson(p);
      if (!p.ok) return errorOf(pb, 'Could not remove silences.');
      if (!useV1) return pb && pb.segments ? { segments: pb.segments, keptSeconds: pb.keptSeconds, removedSeconds: pb.removedSeconds } : errorOf(pb, 'Could not remove silences.');
      for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
        if (signal && signal.aborted) return { error: 'Cancelled.', code: 'aborted' };
        await sleep(pollDelay(attempt));
        const g = await authFetch(`${recPath(id)}/remove-silences`);
        const gb = await safeJson(g);
        if (!g.ok) return errorOf(gb, 'Could not read the silence detection.');
        if (gb.status === 'completed' && gb.result) return { segments: gb.result.segments, keptSeconds: gb.result.keptSeconds, removedSeconds: gb.result.removedSeconds, method: gb.result.method };
        if (SILENCE_TERMINAL.has(gb.status)) return { error: friendlySilenceError(gb.error), code: 'silence_failed' };
      }
      return { error: 'Silence detection is taking too long — please try again later.', code: 'timeout' };
    },
  };
}

/** The worker's terminal reasons → what a person can act on. */
export function friendlySilenceError(raw) {
  const s = String(raw || '');
  if (/no_silence/.test(s)) return 'No significant silences were found — nothing to trim.';
  if (/no_speech/.test(s)) return 'No speech was detected, so there is nothing to keep. Transcribe the video first, then try again.';
  if (/recording_not_ready/.test(s)) return 'The video is still processing — try again once it is ready.';
  return 'Silence detection failed. Please try again.';
}
