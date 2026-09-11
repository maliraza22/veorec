// ─────────────────────────────────────────────────────────────────────────────
// RecorderStore — local recovery database (T-401, docs/05 §2–§5, §7)
//
// IndexedDB `veorec-recorder` v1 on the extension origin:
//   sessions  keyPath id
//   chunks    keyPath [sessionId, seq]
//   parts     keyPath [sessionId, partNumber]
//
// ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
// At most ~1 s of media may be lost on a hard crash (docs/05 §1): every
// `dataavailable` chunk is written here BEFORE the uploader sees it (T-402),
// and upload bookkeeping (which parts are durably in R2) survives restarts so
// a resume never re-uploads a completed part. The session row's `updatedAt`
// heartbeat is how a later launch tells a live recording from a dead one.
//
// ── ORDERING ─────────────────────────────────────────────────────────────────
// Chunk writes are queued per session on a promise chain, so `seq` is assigned
// and committed in arrival order even when the caller does not await — a
// recorder must never block on disk. A failed write retries once, then the
// caller sees `persist_failed` (or `quota_exceeded`); recording continues.
//
// ── WHAT IT IS NOT ───────────────────────────────────────────────────────────
// No network, no chrome.* APIs, no knowledge of the uploader: it stores what
// it is told and returns it in order. Plain UMD (no build step) like the
// uploader; testable in Node with fake-indexeddb.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VeoRecRecorderStore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DB_NAME = 'veorec-recorder';
  const DB_VERSION = 1;
  const HEARTBEAT_STALE_MS = 15 * 1000;           // docs/05 §3
  const GC_AGE_MS = 7 * 24 * 60 * 60 * 1000;       // docs/05 §7
  const SPACE_WARN_BELOW = 2 * 1024 * 1024 * 1024; // docs/05 §4
  const SPACE_REFUSE_BELOW = 500 * 1024 * 1024;
  const SESSION_STATUSES = ['recording', 'stopped', 'uploading', 'uploaded', 'failed'];
  const PART_STATUSES = ['pending', 'inflight', 'uploaded'];

  class StoreError extends Error {
    constructor(code, message, cause) { super(message); this.name = 'StoreError'; this.code = code; if (cause) this.cause = cause; }
  }

  const req = (r) => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('request failed'));
  });
  const done = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
  const isQuotaError = (e) => !!e && (e.name === 'QuotaExceededError' || e.code === 22 || /quota/i.test(String(e.message || '')));
  const uuid = () => (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); });
  const byteLength = (bytes) => bytes == null ? 0 : (typeof bytes.size === 'number' ? bytes.size : (bytes.byteLength || 0));

  function upgrade(db) {
    if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['sessionId', 'seq'] });
    if (!db.objectStoreNames.contains('parts')) db.createObjectStore('parts', { keyPath: ['sessionId', 'partNumber'] });
  }

  /**
   * Open (creating on first use) the recovery database.
   * @param {object} [options]
   * @param {IDBFactory} [options.indexedDB]   injectable for tests
   * @param {StorageManager} [options.storage] navigator.storage (persist/estimate)
   * @param {() => number} [options.now]
   * @param {(level:string, msg:string, meta?:object) => void} [options.log]
   * @param {string} [options.name]
   */
  async function openStore(options = {}) {
    const idb = options.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    if (!idb) throw new StoreError('unavailable', 'IndexedDB is not available');
    const storage = options.storage !== undefined ? options.storage
      : (typeof navigator !== 'undefined' && navigator.storage ? navigator.storage : null);
    const now = options.now || (() => Date.now());
    const log = options.log || (() => {});
    const name = options.name || DB_NAME;

    const db = await new Promise((resolve, reject) => {
      const r = idb.open(name, DB_VERSION);
      r.onupgradeneeded = () => upgrade(r.result);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(new StoreError('open_failed', 'could not open the recovery database', r.error));
      r.onblocked = () => reject(new StoreError('open_blocked', 'the recovery database is blocked by another connection'));
    });

    // docs/05 §2: best-effort persistence request, result logged.
    let persisted = null;
    if (storage && typeof storage.persist === 'function') {
      try { persisted = !!(await storage.persist()); }
      catch (e) { persisted = null; }
      log('info', 'recorder store: persistence ' + (persisted === null ? 'unknown' : persisted ? 'granted' : 'not granted'), { persisted });
    }

    const queues = new Map();                       // sessionId -> promise chain
    const enqueue = (sessionId, fn) => {
      const prev = queues.get(sessionId) || Promise.resolve();
      const next = prev.catch(() => {}).then(fn);
      queues.set(sessionId, next);
      // The housekeeping promise derived here must never surface the write's
      // rejection a second time — the caller's `next` is the one that reports
      // it. An unhandled derived rejection would crash the page.
      next.finally(() => { if (queues.get(sessionId) === next) queues.delete(sessionId); }).catch(() => {});
      return next;
    };

    const tx = (stores, mode) => db.transaction(stores, mode);

    // ── Space ──────────────────────────────────────────────────────────────
    /** docs/05 §4: ok | warn (< 2 GB) | insufficient_disk (< 500 MB). */
    async function checkSpace() {
      if (!storage || typeof storage.estimate !== 'function') return { level: 'unknown', ok: true, quota: null, usage: null, available: null };
      let est;
      try { est = await storage.estimate(); } catch (e) { return { level: 'unknown', ok: true, quota: null, usage: null, available: null }; }
      const quota = Number(est.quota || 0), usage = Number(est.usage || 0);
      const available = Math.max(0, quota - usage);
      if (quota > 0 && available < SPACE_REFUSE_BELOW) return { level: 'insufficient_disk', ok: false, quota, usage, available };
      if (quota > 0 && available < SPACE_WARN_BELOW) return { level: 'warn', ok: true, quota, usage, available };
      return { level: 'ok', ok: true, quota, usage, available };
    }

    // ── Sessions ───────────────────────────────────────────────────────────
    async function createSession(fields = {}) {
      const t = now();
      const session = {
        id: fields.id || uuid(),
        createdAt: t, updatedAt: t,
        status: 'recording',
        mimeType: fields.mimeType || 'video/webm',
        config: fields.config || {},
        clientDuration: null,
        chunkCount: 0, totalBytes: 0,
        recordingId: fields.recordingId || null,
        uploadSessionId: fields.uploadSessionId || null,
        storageUploadId: fields.storageUploadId || null,
        partSize: fields.partSize || null,
        title: fields.title || 'Screen recording',
        userId: fields.userId || null,
      };
      const x = tx(['sessions'], 'readwrite');
      x.objectStore('sessions').add(session);
      await done(x);
      return session;
    }
    async function getSession(id) {
      const x = tx(['sessions'], 'readonly');
      return (await req(x.objectStore('sessions').get(id))) || null;
    }
    async function listSessions() {
      const x = tx(['sessions'], 'readonly');
      const all = await req(x.objectStore('sessions').getAll());
      return all.sort((a, b) => a.createdAt - b.createdAt);
    }
    /** Patch fields; bumps updatedAt (the heartbeat) unless told not to. */
    async function updateSession(id, patch = {}, { touch = true } = {}) {
      if (patch.status && !SESSION_STATUSES.includes(patch.status)) throw new StoreError('invalid_status', `invalid session status ${patch.status}`);
      const x = tx(['sessions'], 'readwrite');
      const store = x.objectStore('sessions');
      const cur = await req(store.get(id));
      if (!cur) throw new StoreError('not_found', `session ${id} not found`);
      const next = { ...cur, ...patch, id: cur.id, createdAt: cur.createdAt };
      if (touch) next.updatedAt = now();
      store.put(next);
      await done(x);
      return next;
    }
    const heartbeat = (id) => updateSession(id, {}, { touch: true });
    const setStatus = (id, status) => updateSession(id, { status });
    /** docs/05 §3: live iff status recording and heartbeat within 15 s. */
    function liveness(session, at = now()) {
      if (!session) return 'missing';
      if (session.status !== 'recording') return 'not_recording';
      return (at - Number(session.updatedAt || 0)) <= HEARTBEAT_STALE_MS ? 'live' : 'dead';
    }

    // ── Chunks ─────────────────────────────────────────────────────────────
    /**
     * Append one dataavailable chunk. Queued per session so seq is assigned in
     * arrival order even without awaiting. Retries once; then throws
     * quota_exceeded or persist_failed (the recording must go on).
     */
    function appendChunk(sessionId, bytes, { at } = {}) {
      return enqueue(sessionId, async () => {
        const size = byteLength(bytes);
        let lastErr = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const x = tx(['sessions', 'chunks'], 'readwrite');
            const sessions = x.objectStore('sessions');
            const cur = await req(sessions.get(sessionId));
            if (!cur) throw new StoreError('not_found', `session ${sessionId} not found`);
            const seq = Number(cur.chunkCount || 0);
            x.objectStore('chunks').add({ sessionId, seq, bytes, size, at: at != null ? at : now() });
            sessions.put({ ...cur, chunkCount: seq + 1, totalBytes: Number(cur.totalBytes || 0) + size, updatedAt: now() });
            await done(x);
            return { seq, size };
          } catch (e) {
            if (e instanceof StoreError && e.code === 'not_found') throw e;
            lastErr = e;
            if (isQuotaError(e)) break;                       // no point retrying
          }
        }
        if (isQuotaError(lastErr)) throw new StoreError('quota_exceeded', 'the browser refused more storage', lastErr);
        throw new StoreError('persist_failed', 'chunk could not be persisted', lastErr);
      });
    }
    /** All chunks of a session in seq order, optionally a range (inclusive). */
    async function getChunks(sessionId, { fromSeq = 0, toSeq = Infinity } = {}) {
      const x = tx(['chunks'], 'readonly');
      const range = IDBKeyRange.bound([sessionId, fromSeq], [sessionId, toSeq === Infinity ? Number.MAX_SAFE_INTEGER : toSeq]);
      const rows = await req(x.objectStore('chunks').getAll(range));
      return rows.sort((a, b) => a.seq - b.seq);
    }
    /** Stream-assemble the session's media in order (local download source). */
    async function assembleBlob(sessionId, { type } = {}) {
      const session = await getSession(sessionId);
      const rows = await getChunks(sessionId);
      const parts = rows.map((r) => r.bytes);
      return new Blob(parts, { type: type || (session && session.mimeType) || 'video/webm' });
    }

    // ── Parts ──────────────────────────────────────────────────────────────
    async function upsertPart(sessionId, part) {
      if (!Number.isInteger(part.partNumber) || part.partNumber < 1) throw new StoreError('invalid_part', 'partNumber must be a positive integer');
      if (part.status && !PART_STATUSES.includes(part.status)) throw new StoreError('invalid_status', `invalid part status ${part.status}`);
      const x = tx(['parts'], 'readwrite');
      const store = x.objectStore('parts');
      const cur = (await req(store.get([sessionId, part.partNumber]))) || {};
      // An upsert that does not mention status keeps the stored one: a merge
      // that only bumps `attempts` must never demote an uploaded part.
      const status = part.status || cur.status || 'pending';
      const row = {
        sessionId, partNumber: part.partNumber,
        firstSeq: part.firstSeq ?? cur.firstSeq ?? null, lastSeq: part.lastSeq ?? cur.lastSeq ?? null,
        size: part.size ?? cur.size ?? 0,
        status, etag: part.etag ?? cur.etag ?? null, crc32c: part.crc32c ?? cur.crc32c ?? null,
        attempts: part.attempts ?? cur.attempts ?? 0, lastError: part.lastError ?? cur.lastError ?? null,
      };
      store.put(row);
      await done(x);
      return row;
    }
    async function setPartStatus(sessionId, partNumber, patch = {}) {
      const x = tx(['parts'], 'readwrite');
      const store = x.objectStore('parts');
      const cur = await req(store.get([sessionId, partNumber]));
      if (!cur) throw new StoreError('not_found', `part ${partNumber} of ${sessionId} not found`);
      if (patch.status && !PART_STATUSES.includes(patch.status)) throw new StoreError('invalid_status', `invalid part status ${patch.status}`);
      const row = { ...cur, ...patch, sessionId, partNumber };
      store.put(row);
      await done(x);
      return row;
    }
    async function listParts(sessionId) {
      const x = tx(['parts'], 'readonly');
      const rows = await req(x.objectStore('parts').getAll(IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER])));
      return rows.sort((a, b) => a.partNumber - b.partNumber);
    }

    /**
     * docs/05 §5: delete chunk rows covered by parts that are `uploaded` AND
     * have an etag — only under space pressure (`force`), because by default
     * everything is kept so a local download always has full fidelity.
     */
    async function pruneChunks(sessionId, { force = false } = {}) {
      if (!force) return { pruned: 0, skipped: 'no_pressure' };
      const parts = (await listParts(sessionId)).filter((p) => p.status === 'uploaded' && p.etag && p.firstSeq != null && p.lastSeq != null);
      let pruned = 0;
      const x = tx(['chunks'], 'readwrite');
      const store = x.objectStore('chunks');
      for (const p of parts) {
        const rows = await req(store.getAllKeys(IDBKeyRange.bound([sessionId, p.firstSeq], [sessionId, p.lastSeq])));
        for (const key of rows) { store.delete(key); pruned += 1; }
      }
      await done(x);
      return { pruned, skipped: null };
    }

    // ── Cleanup ────────────────────────────────────────────────────────────
    /** docs/05 §7: session + chunks + parts in ONE transaction. */
    async function deleteSession(sessionId) {
      const x = tx(['sessions', 'chunks', 'parts'], 'readwrite');
      x.objectStore('sessions').delete(sessionId);
      x.objectStore('chunks').delete(IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]));
      x.objectStore('parts').delete(IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]));
      await done(x);
      return { deleted: sessionId };
    }
    /** docs/05 §7: sessions untouched for 7 days are garbage-collected. */
    async function gc({ olderThanMs = GC_AGE_MS, at = now() } = {}) {
      const sessions = await listSessions();
      const stale = sessions.filter((s) => at - Number(s.updatedAt || 0) > olderThanMs);
      for (const s of stale) {
        await deleteSession(s.id);
        log('info', 'recorder store: garbage-collected a stale session', { sessionId: s.id, ageMs: at - s.updatedAt });
      }
      return { deleted: stale.map((s) => s.id) };
    }

    return {
      db, name, persisted, checkSpace,
      createSession, getSession, listSessions, updateSession, heartbeat, setStatus, liveness,
      appendChunk, getChunks, assembleBlob,
      upsertPart, setPartStatus, listParts, pruneChunks,
      deleteSession, gc,
      close() { try { db.close(); } catch (e) { /* already closed */ } },
    };
  }

  return {
    openStore, StoreError,
    DB_NAME, DB_VERSION, HEARTBEAT_STALE_MS, GC_AGE_MS, SPACE_WARN_BELOW, SPACE_REFUSE_BELOW,
    SESSION_STATUSES, PART_STATUSES,
  };
}));
