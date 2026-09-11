// ─────────────────────────────────────────────────────────────────────────────
// Recovery — launch scan, server reconciliation, resume / download / discard
// (T-403, docs/05 §6–§8, docs/03 §3.1)
//
// Runs at recorder-window launch, BEFORE anything else: if an unfinished
// session exists in IndexedDB the user is offered Resume upload / Download /
// Discard before a new recording can start. Nothing here ever deletes local
// data except on server-confirmed completion or an explicit Discard — a quota
// verdict, an auth failure or a network failure keeps the take.
//
// ── SERVER VIEW WINS (docs/05 §6.1, docs/06 §10) ────────────────────────────
// Resume asks the server which parts it holds (the uploader's resume() does the
// ListParts diff); the local `parts` rows are corrected to match, the chunks
// those parts cover are SKIPPED, and only the remainder is fed and uploaded —
// a crash between a successful PUT and the etag write costs nothing.
//
// ── DEPENDENCIES ARE INJECTED ───────────────────────────────────────────────
// store (T-401), createUploader (T-303), fetch, now, the signed-in user id,
// fixWebmDuration and a saveAs sink. The module knows no DOM and no chrome.*;
// the recorder window wires it (recorder.js) and the popup shows the badge.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VeoRecRecovery = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RECOVERY_HEADER = 'X-VeoRec-Recovery';

  /** Outcome kinds of a resume attempt. */
  const OUTCOME = {
    saved: 'saved',                   // uploaded and completed now
    alreadySaved: 'already_saved',    // server had completed it before the crash
    authRequired: 'auth_required',    // 401 — keep data, sign in, retry
    quota: 'quota',                   // 403 storage_limit | video_limit — keep data
    failed: 'failed',                 // anything else — keep data
    crossAccount: 'cross_account',    // never upload under another account
  };

  /**
   * Launch scan (docs/05 §6): GC, phantoms, liveness, ownership.
   * @returns {{live: object|null, recoverable: object[], deleted: string[]}}
   */
  async function scan({ store, now = () => Date.now(), currentUserId = null }) {
    const gc = await store.gc({ at: now() }).catch(() => ({ deleted: [] }));
    const sessions = await store.listSessions();
    const deleted = [...(gc.deleted || [])];
    let live = null;
    const recoverable = [];
    for (const s of sessions) {
      const liveness = store.liveness(s, now());
      if (liveness === 'live') { live = s; continue; }
      if (!s.chunkCount) {                          // nothing captured: a phantom, not a recovery
        await store.deleteSession(s.id).catch(() => {});
        deleted.push(s.id);
        continue;
      }
      recoverable.push({
        ...s,
        ownedByCurrentUser: !s.userId || !currentUserId || s.userId === currentUserId,
      });
    }
    recoverable.sort((a, b) => b.createdAt - a.createdAt);   // newest first (docs/05 §6.2)
    return { live, recoverable, deleted };
  }

  /** Card facts (docs/05 §6.2). Duration estimate = chunkCount seconds. */
  async function describe(store, session) {
    const parts = await store.listParts(session.id).catch(() => []);
    const uploaded = parts.filter((p) => p.status === 'uploaded' && p.etag).length;
    return {
      id: session.id,
      title: session.title || 'Screen recording',
      recordedAt: session.createdAt,
      durationSec: session.clientDuration != null ? Math.round(session.clientDuration) : Number(session.chunkCount || 0),
      sizeBytes: Number(session.totalBytes || 0),
      uploadedParts: uploaded,
      totalParts: parts.length,
      status: session.status,
      ownedByCurrentUser: session.ownedByCurrentUser !== false,
    };
  }

  /** fetch that tags every /api/v1 call as recovery traffic (docs/19 §7 KPI). */
  function recoveryFetch(fetchImpl) {
    return (url, init = {}) => {
      const headers = Object.assign({}, init.headers || {});
      if (/\/api\/v1\//.test(String(url))) headers[RECOVERY_HEADER] = '1';
      return fetchImpl(url, { ...init, headers });
    };
  }

  /** Seqs covered by local parts the server already holds. */
  function coveredSeqs(localParts, adoptedPartNumbers) {
    const covered = new Set();
    for (const p of localParts) {
      if (!adoptedPartNumbers.has(p.partNumber) || p.firstSeq == null || p.lastSeq == null) continue;
      for (let s = p.firstSeq; s <= p.lastSeq; s += 1) covered.add(s);
    }
    return covered;
  }

  /**
   * Resume the upload of one session (docs/05 §6.1).
   * @param {object} p
   * @param {object} p.store
   * @param {object} p.session
   * @param {string} p.server        API origin
   * @param {string} p.token
   * @param {Function} p.createUploader   VeoRecUploader.createUploader
   * @param {Function} p.fetchImpl
   * @param {string|null} [p.currentUserId]
   * @param {(e:object)=>void} [p.onEvent]  uploader events + {type:'phase', phase}
   * @param {Function} [p.log]
   */
  async function resumeSession(p) {
    const { store, session, server, token, createUploader, fetchImpl, currentUserId = null, onEvent = () => {}, log = () => {} } = p;
    if (session.userId && currentUserId && session.userId !== currentUserId) return { kind: OUTCOME.crossAccount };
    const fetchR = recoveryFetch(fetchImpl);
    const watchUrl = (recordingId) => `https://veorec.com/watch/${recordingId}`;
    const keepAs = async (status) => { await store.updateSession(session.id, { status }).catch(() => {}); };
    const finishSaved = async (recordingId, kind) => {
      await store.deleteSession(session.id).catch(() => {});
      return { kind, watchUrl: watchUrl(recordingId), recordingId };
    };

    await keepAs('uploading');
    const up = createUploader({ server, token, fetchImpl: fetchR, onEvent });
    let recordingId = session.recordingId;
    let adopted = new Set();
    let resumed = false;

    // 1–2. An existing server session: reconcile, or discover it already completed.
    if (session.uploadSessionId) {
      onEvent({ type: 'phase', phase: 'reconciling' });
      const r = await up.resume(session.uploadSessionId);
      if (r.ok) {
        const serverStatus = up.state.session && up.state.session.status;
        if (serverStatus === 'completed') {
          log('info', 'recovery: server had already completed this upload');
          return finishSaved(recordingId || up.state.session.recordingId, OUTCOME.alreadySaved);
        }
        if (serverStatus === 'pending' || serverStatus === 'active') {
          adopted = new Set(r.diff.adopted);
          // Server view wins: correct the local rows.
          for (const n of adopted) {
            const sp = up.state.parts.get(n);
            await store.upsertPart(session.id, { partNumber: n, status: 'uploaded', etag: sp && sp.etag, size: sp && sp.size }).catch(() => {});
          }
          resumed = true;
        }
        // expired / aborted → fall through to a fresh session
      } else if (r.status === 401) {
        await keepAs('failed');
        return { kind: OUTCOME.authRequired };
      }
      // 404/409/410 or a network failure → fresh session below
    }

    // 3. Fresh session when there is none to resume (offline start, expired, aborted).
    if (!resumed) {
      onEvent({ type: 'phase', phase: 'starting' });
      if (!recordingId) {
        const res = await fetchR(`${server}/api/v1/recordings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': `recover-${session.id}` },
          body: JSON.stringify({ title: session.title || 'Screen recording', source: 'extension' }),
        }).catch(() => null);
        if (!res) { await keepAs('failed'); return { kind: OUTCOME.failed, reason: 'network' }; }
        if (res.status === 401) { await keepAs('failed'); return { kind: OUTCOME.authRequired }; }
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.id) { await keepAs('failed'); return { kind: OUTCOME.failed, reason: `create_recording_${res.status}` }; }
        recordingId = body.id;
        await store.updateSession(session.id, { recordingId }).catch(() => {});
      }
      const began = await up.begin({ recordingId, mimeType: (session.mimeType || 'video/webm').split(';')[0], idempotencyKey: `recover-${session.id}-${Date.now()}` });
      if (!began) {
        const f = up.state.fatal || {};
        await keepAs('failed');
        if (f.status === 401) return { kind: OUTCOME.authRequired };
        if (f.status === 403 && /limit/.test(String(f.code || ''))) return { kind: OUTCOME.quota, code: f.code, message: f.message };
        return { kind: OUTCOME.failed, reason: f.code || 'begin_failed', status: f.status };
      }
      await store.updateSession(session.id, { uploadSessionId: began.uploadSessionId, partSize: began.partSize }).catch(() => {});
    }

    // 4. Feed every chunk the server does not already hold, in order.
    onEvent({ type: 'phase', phase: 'uploading' });
    const localParts = await store.listParts(session.id).catch(() => []);
    const skip = coveredSeqs(localParts, adopted);
    const chunks = await store.getChunks(session.id);
    let fed = 0;
    for (const c of chunks) {
      if (skip.has(c.seq)) continue;
      up.addChunk(c.bytes);
      fed += 1;
    }
    const out = await up.finalize({ clientDuration: session.clientDuration != null ? session.clientDuration : chunks.length });
    if (out && out.ok) {
      log('info', 'recovery: upload completed', { fed, adopted: adopted.size });
      return finishSaved(recordingId, OUTCOME.saved);
    }
    await keepAs('failed');
    const status = out && out.status;
    if (status === 401) return { kind: OUTCOME.authRequired };
    if (status === 403) return { kind: OUTCOME.quota, code: out.body && out.body.error && out.body.error.code, message: out.body && out.body.error && out.body.error.message };
    return { kind: OUTCOME.failed, reason: (out && (out.reason || out.status)) || 'finalize_failed' };
  }

  /** Local download: assemble → fixWebmDuration → save (docs/05 §4). */
  async function downloadSession({ store, session, fixWebmDuration = null, saveAs }) {
    const raw = await store.assembleBlob(session.id);
    const seconds = session.clientDuration != null ? session.clientDuration : Number(session.chunkCount || 0);
    let blob = raw;
    if (typeof fixWebmDuration === 'function' && seconds > 0) {
      try { blob = await fixWebmDuration(raw, seconds * 1000); } catch (e) { blob = raw; }
    }
    const name = `veorec-recovered-${new Date(session.createdAt || Date.now()).toISOString().replace(/[:.]/g, '-')}.webm`;
    await saveAs(blob, name);
    return { name, size: blob.size, seconds };
  }

  /** Explicit discard: server session aborted best-effort, then local data gone (docs/05 §7). */
  async function discardSession({ store, session, server, token, fetchImpl }) {
    if (session.uploadSessionId && server && token && fetchImpl) {
      try { await fetchImpl(`${server}/api/v1/uploads/${session.uploadSessionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }); } catch (e) { /* best-effort */ }
    }
    await store.deleteSession(session.id);
    return { discarded: session.id };
  }

  return { scan, describe, resumeSession, downloadSession, discardSession, coveredSeqs, recoveryFetch, OUTCOME, RECOVERY_HEADER };
}));
