// ─────────────────────────────────────────────────────────────────────────────
// VeoRec streaming uploader (T-303)
//
// Uploads a recording to object storage IN PARTS, WHILE IT IS STILL BEING
// RECORDED. By the time the user hits Stop, usually only the final part and the
// completion call remain — which is the whole reliability win: today the entire
// file is POSTed through the server after recording ends, so a 40-minute take
// is a single 500 MB request that a flaky connection can lose completely.
//
// Bytes go browser → storage directly via presigned URLs (docs/06). The server
// only mints URLs and records what happened.
//
// ── FILE NAME ───────────────────────────────────────────────────────────────
// The plan names this `uploader.ts`. The extension is plain MV3 JavaScript with
// no TypeScript toolchain and no build step — every other file is loaded raw by
// the browser — so introducing one here would change how the whole extension
// ships. This is the same JS, with types expressed in JSDoc.
//
// ── TESTABILITY ─────────────────────────────────────────────────────────────
// Every side effect is injectable (`fetch`, `sleep`, `now`, `random`), so the
// retry classifier, the backoff schedule and the resume diff can be exercised
// deterministically without a network or a clock.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VeoRecUploader = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // docs/06 §6 — attempts PER PART before the uploader goes `stalled`.
  const MAX_PART_ATTEMPTS = 8;
  const MAX_BACKOFF_MS = 60_000;
  const STALLED_RETRY_MS = 60_000;
  // docs/06 §5 — leave bandwidth for the meeting being recorded; open up after.
  const CONCURRENCY_RECORDING = 2;
  const CONCURRENCY_STOPPED = 4;
  // docs/06 §4 — presign in batches, keep a few ahead so a sealed part never
  // waits for a round trip.
  const PRESIGN_BATCH = 5;
  const PREFETCH_TARGET = 3;
  // docs/03 §8 / docs/16 §4.3a — stop early enough that the final part still fits.
  const CEILING_HEADROOM_BYTES = 16 * 1024 * 1024;
  const CEILING_WARN_RATIO = 0.9;

  // ── CRC32C (Castagnoli), docs/06 §9 ────────────────────────────────────────
  // Computed per part so the server records what the client believed it sent.
  let CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
      t[i] = c >>> 0;
    }
    CRC_TABLE = t;
    return t;
  }
  function crc32c(bytes) {
    const t = crcTable();
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    c = (c ^ 0xffffffff) >>> 0;
    // Base64 of the big-endian u32, matching x-amz-checksum-crc32c.
    const b = [c >>> 24 & 0xff, c >>> 16 & 0xff, c >>> 8 & 0xff, c & 0xff];
    if (typeof btoa === 'function') return btoa(String.fromCharCode.apply(null, b));
    return Buffer.from(b).toString('base64');
  }

  // ── Retry classification (docs/06 §6) ──────────────────────────────────────
  // The distinctions here decide whether a recording survives a bad network.
  // Getting them wrong means either giving up on a recoverable blip or retrying
  // forever against a verdict that will never change.
  const OUTCOME = {
    ok: 'ok',
    retry: 'retry',           // transient — back off and try the same bytes again
    repress: 'repress',       // the URL expired; re-mint it, NOT a data attempt
    fatal: 'fatal',           // a verdict retrying cannot change
  };

  /**
   * @param {{status?: number, networkError?: boolean, timeout?: boolean,
   *          expiredSignature?: boolean}} signal
   */
  function classify(signal) {
    if (signal.networkError || signal.timeout) return OUTCOME.retry;
    const s = signal.status;
    if (s === undefined || s === null) return OUTCOME.retry;
    if (s >= 200 && s < 300) return OUTCOME.ok;
    // A presigned URL that aged out is not a failed upload — re-minting is free
    // and repeatable, so it must not consume one of the eight data attempts.
    if (s === 403 && signal.expiredSignature) return OUTCOME.repress;
    if (s === 429 || s >= 500) return OUTCOME.retry;
    // Every other 4xx is the server's considered answer.
    return OUTCOME.fatal;
  }

  /** Exponential backoff with FULL jitter (docs/06 §6). */
  function backoffMs(attempt, random) {
    const ceiling = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, attempt));
    return Math.floor((random ? random() : Math.random()) * ceiling);
  }

  /** Per-attempt timeout: generous, and scaled by part size (docs/06 §6). */
  const attemptTimeoutMs = (size) => Math.max(60_000, (size / 50_000) * 1000);

  /** Storage says a presigned URL expired in the body, not the status alone. */
  function looksExpired(status, text) {
    return status === 403 && /expired|AccessDenied|Request has expired/i.test(String(text || ''));
  }

  function createUploader(options) {
    const {
      server, token,
      fetchImpl = (typeof fetch !== 'undefined' ? fetch.bind(null) : null),
      sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
      now = () => Date.now(),
      random = Math.random,
      onEvent = () => {},
    } = options || {};

    const state = {
      status: 'idle',          // idle | active | stalled | completing | completed | failed
      session: null,           // { uploadSessionId, partSize, byteCeiling, ... }
      recordingId: null,
      buffer: [],              // chunks not yet sealed into a part
      bufferedBytes: 0,
      nextPartNumber: 1,
      parts: new Map(),        // partNumber -> { size, bytes, etag, status, attempts }
      presigned: new Map(),    // partNumber -> { url, expiresAt }
      recordedBytes: 0,
      uploadedBytes: 0,
      recording: true,         // drives the 2-vs-4 concurrency split
      ceilingWarned: false,
      ceilingReached: false,
      inFlight: 0,
      fatal: null,
    };

    const emit = (type, detail) => { try { onEvent({ type, ...detail }); } catch (e) { /* never break the recorder */ } };

    const authHeaders = () => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    });

    /** Call the API. Returns { ok, status, body }. Never throws for HTTP status. */
    async function apiCall(method, path, body) {
      try {
        const res = await fetchImpl(`${server}${path}`, {
          method, headers: authHeaders(),
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        let json = null;
        try { json = await res.json(); } catch (e) { json = null; }
        return { ok: res.ok, status: res.status, body: json };
      } catch (err) {
        return { ok: false, status: null, networkError: true, body: null };
      }
    }

    // ── Session ──────────────────────────────────────────────────────────────

    /** Open an upload session. Idempotent: a retry returns the same session. */
    async function begin({ recordingId, mimeType = 'video/webm', idempotencyKey }) {
      state.recordingId = recordingId;
      const key = idempotencyKey || `up-${recordingId}`;
      const res = await fetchWithKey('POST', '/api/v1/uploads',
        { recordingId, mimeType }, key);
      if (!res.ok) {
        state.status = 'failed';
        state.fatal = describe(res, 'could not start the upload');
        emit('failed', { reason: state.fatal });
        return null;
      }
      state.session = res.body;
      state.status = 'active';
      emit('started', { session: res.body });
      return res.body;
    }

    async function fetchWithKey(method, path, body, key) {
      try {
        const res = await fetchImpl(`${server}${path}`, {
          method,
          headers: { ...authHeaders(), 'Idempotency-Key': key },
          body: JSON.stringify(body),
        });
        let json = null;
        try { json = await res.json(); } catch (e) { json = null; }
        return { ok: res.ok, status: res.status, body: json };
      } catch (err) {
        return { ok: false, status: null, networkError: true, body: null };
      }
    }

    // ── Buffering (docs/06 §5) ───────────────────────────────────────────────

    /**
     * Feed one `dataavailable` chunk. Seals a part as soon as partSize is
     * reached, so uploading overlaps recording instead of following it.
     * @param {Uint8Array|Blob} chunk
     */
    function addChunk(chunk) {
      const size = chunk.size !== undefined ? chunk.size : chunk.length;
      if (!size) return;
      state.buffer.push(chunk);
      state.bufferedBytes += size;
      state.recordedBytes += size;

      checkCeiling();

      const partSize = (state.session && state.session.partSize) || 8 * 1024 * 1024;
      while (state.bufferedBytes >= partSize) sealPart(partSize);
      drain();
    }

    /** The byte ceiling is the recorder's, not just the server's (docs/03 §8). */
    function checkCeiling() {
      const ceiling = state.session && Number(state.session.byteCeiling);
      if (!ceiling) return;
      if (!state.ceilingWarned && state.recordedBytes >= ceiling * CEILING_WARN_RATIO) {
        state.ceilingWarned = true;
        emit('ceiling-warning', { recordedBytes: state.recordedBytes, byteCeiling: ceiling });
      }
      // Stop with headroom so the final part still fits under the ceiling —
      // stopping AT the ceiling would leave no room for it.
      if (!state.ceilingReached && state.recordedBytes >= ceiling - CEILING_HEADROOM_BYTES) {
        state.ceilingReached = true;
        emit('ceiling-reached', { recordedBytes: state.recordedBytes, byteCeiling: ceiling });
      }
    }

    /** Move exactly `partSize` bytes (or everything, when finalising) into a part. */
    function sealPart(limit) {
      const take = [];
      let taken = 0;
      while (state.buffer.length && (limit === null || taken < limit)) {
        const chunk = state.buffer[0];
        const size = chunk.size !== undefined ? chunk.size : chunk.length;
        // Take the chunk that CROSSES the boundary too: docs/06 §5 seals at
        // ">= partSize", and stopping short would make a non-final part smaller
        // than partSize — under S3's 5 MiB floor once real sizes are in play.
        take.push(state.buffer.shift());
        taken += size;
      }
      if (!taken) return null;
      state.bufferedBytes -= taken;
      const partNumber = state.nextPartNumber;
      state.nextPartNumber += 1;
      state.parts.set(partNumber, {
        partNumber, size: taken, chunks: take, status: 'pending', attempts: 0, etag: null,
      });
      emit('part-sealed', { partNumber, size: taken });
      return partNumber;
    }

    // ── Presigning, with prefetch (docs/06 §4) ──────────────────────────────

    async function ensurePresigned(partNumbers) {
      const missing = partNumbers.filter((n) => !state.presigned.has(n));
      if (!missing.length) return true;
      const batch = missing.slice(0, PRESIGN_BATCH).map((n) => ({
        partNumber: n, size: state.parts.get(n).size,
      }));
      const res = await apiCall('POST',
        `/api/v1/uploads/${state.session.uploadSessionId}/parts`, { parts: batch });
      if (!res.ok) {
        // A refused presign is the server enforcing the byte ceiling — a
        // verdict, not a transient fault.
        if (res.status === 403) {
          state.fatal = describe(res, 'the upload exceeded its size limit');
          state.status = 'failed';
          emit('failed', { reason: state.fatal });
        }
        return false;
      }
      for (const p of res.body.parts) {
        state.presigned.set(p.partNumber, { url: p.url, expiresAt: p.expiresAt });
      }
      return true;
    }

    // ── The drain loop ───────────────────────────────────────────────────────

    let draining = null;
    function drain() {
      if (state.status === 'failed' || state.status === 'completed') return Promise.resolve();
      // Join the in-flight drain instead of returning immediately: a caller
      // awaiting drain() must wait for the parts, not merely for the fact that
      // somebody else is already draining.
      if (draining) return draining;
      draining = drainLoop().finally(() => { draining = null; });
      return draining;
    }
    async function drainLoop() {
      {
        for (;;) {
          if (!state.session) break;
          const limit = state.recording ? CONCURRENCY_RECORDING : CONCURRENCY_STOPPED;
          const pending = [...state.parts.values()]
            .filter((p) => p.status === 'pending')
            .sort((a, b) => a.partNumber - b.partNumber);
          if (!pending.length) break;

          // Prefetch a few URLs ahead so a sealed part never waits on a round trip.
          const wanted = pending.slice(0, Math.max(limit, PREFETCH_TARGET)).map((p) => p.partNumber);
          const presigned = await ensurePresigned(wanted);
          if (!presigned) break;

          const batch = pending.slice(0, limit).filter((p) => state.presigned.has(p.partNumber));
          if (!batch.length) break;

          for (const p of batch) p.status = 'uploading';
          await Promise.all(batch.map((p) => uploadPart(p)));

          if (state.status === 'failed') break;
          if (batch.every((p) => p.status === 'stalled')) { state.status = 'stalled'; break; }
        }
      }
    }

    /** Upload one part, with the full retry policy. Never throws. */
    async function uploadPart(part) {
      for (;;) {
        const entry = state.presigned.get(part.partNumber);
        if (!entry) { part.status = 'pending'; return; }

        const bytes = await toBytes(part.chunks);
        let signal;
        try {
          const res = await fetchImpl(entry.url, {
            method: 'PUT', body: blobOf(part.chunks, bytes),
            headers: { 'Content-Length': String(part.size) },
          });
          let text = '';
          if (!res.ok) { try { text = await res.text(); } catch (e) { text = ''; } }
          signal = {
            status: res.status,
            expiredSignature: looksExpired(res.status, text),
            etag: (res.headers && res.headers.get ? res.headers.get('etag') : null),
          };
        } catch (err) {
          signal = { networkError: true };
        }

        const outcome = classify(signal);

        if (outcome === OUTCOME.ok) {
          part.etag = String(signal.etag || '').replace(/"/g, '');
          part.crc32c = crc32c(bytes);
          part.status = 'uploaded';
          state.uploadedBytes += part.size;
          // Free the bytes: holding every part in memory would defeat the point
          // of streaming a long recording.
          part.chunks = null;
          emit('progress', {
            uploadedBytes: state.uploadedBytes, recordedBytes: state.recordedBytes,
            partNumber: part.partNumber,
          });
          await recordPart(part);
          return;
        }

        if (outcome === OUTCOME.repress) {
          // Re-mint and try again WITHOUT consuming a data attempt.
          state.presigned.delete(part.partNumber);
          const ok = await ensurePresigned([part.partNumber]);
          if (!ok) { part.status = 'pending'; return; }
          continue;
        }

        if (outcome === OUTCOME.fatal) {
          state.fatal = describe({ status: signal.status }, 'storage rejected a part');
          state.status = 'failed';
          part.status = 'failed';
          emit('failed', { reason: state.fatal });
          return;
        }

        part.attempts += 1;
        if (part.attempts >= MAX_PART_ATTEMPTS) {
          // Not fatal: the session stays, the bytes stay, and the whole drain is
          // retried later. A bad ten minutes must not lose a recording.
          part.status = 'stalled';
          emit('stalled', { partNumber: part.partNumber, attempts: part.attempts });
          return;
        }
        const wait = signal.retryAfterMs != null
          ? signal.retryAfterMs : backoffMs(part.attempts, random);
        await sleep(wait);
      }
    }

    /** Tell the server the part landed. Idempotent server-side (docs/06 §5). */
    async function recordPart(part) {
      const res = await apiCall('PUT',
        `/api/v1/uploads/${state.session.uploadSessionId}/parts/${part.partNumber}`,
        { etag: part.etag, size: part.size, crc32c: part.crc32c });
      // Losing this call is survivable: the truth is recoverable from the
      // server's own ListParts merge at resume/complete, so it is not retried
      // aggressively here.
      if (!res.ok) emit('part-record-failed', { partNumber: part.partNumber, status: res.status });
    }

    // ── Resume (docs/06 §10) ─────────────────────────────────────────────────

    /**
     * Reconcile local state with the server's view. The SERVER wins: it merges
     * its rows with live storage, so a part we lost track of after a crash is
     * adopted rather than re-sent, and no completed byte is uploaded twice.
     */
    async function resume(uploadSessionId) {
      const res = await apiCall('GET', `/api/v1/uploads/${uploadSessionId}`);
      if (!res.ok) return { ok: false, status: res.status };
      const server = res.body;
      state.session = { ...(state.session || {}), ...server, uploadSessionId };
      const serverParts = new Map((server.parts || []).map((p) => [p.partNumber, p]));

      const diff = { adopted: [], reupload: [], missing: [] };
      for (const [partNumber, sp] of serverParts) {
        const local = state.parts.get(partNumber);
        if (!local) {
          // Server has it, we do not — adopt it (we crashed after the PUT).
          state.parts.set(partNumber, {
            partNumber, size: sp.size, chunks: null, status: 'uploaded',
            attempts: 0, etag: sp.etag, crc32c: null,
          });
          diff.adopted.push(partNumber);
        } else if (!local.etag && sp.etag) {
          local.etag = sp.etag; local.status = 'uploaded'; local.chunks = null;
          diff.adopted.push(partNumber);
        }
      }
      for (const [partNumber, local] of state.parts) {
        if (local.status !== 'uploaded' && !serverParts.has(partNumber)) {
          local.status = 'pending';
          diff.reupload.push(partNumber);
        }
      }
      state.nextPartNumber = Math.max(state.nextPartNumber,
        ...[...state.parts.keys()].map((k) => k + 1), 1);
      emit('resumed', diff);
      return { ok: true, diff };
    }

    // ── Finalise ─────────────────────────────────────────────────────────────

    /**
     * Seal whatever is buffered, drain everything, then complete.
     * Concurrency opens to 4 here: the recording is over, so there is no
     * meeting left to starve of bandwidth.
     */
    async function finalize({ clientDuration } = {}) {
      state.recording = false;
      if (state.bufferedBytes > 0) sealPart(null);
      if (!state.session) return { ok: false, reason: 'no upload session' };

      state.status = 'completing';
      // Loop: work sealed during an in-flight drain needs another pass.
      for (let i = 0; i < 3; i += 1) {
        await drain();
        if (![...state.parts.values()].some((p) => p.status === 'pending')) break;
      }

      // One retry round for anything that stalled — the network may be back.
      if ([...state.parts.values()].some((p) => p.status !== 'uploaded')) {
        for (const p of state.parts.values()) if (p.status === 'stalled') { p.status = 'pending'; p.attempts = 0; }
        await drain();
      }

      // A fatal verdict during the drain (storage rejected a part, the ceiling
      // refused a presign) is final. Reporting it as "stalled" would invite the
      // caller to retry something that can never succeed.
      if (state.status === 'failed') {
        return { ok: false, fatal: true, reason: state.fatal };
      }

      const outstanding = [...state.parts.values()].filter((p) => p.status !== 'uploaded');
      if (outstanding.length) {
        state.status = 'stalled';
        return { ok: false, reason: 'parts outstanding', outstanding: outstanding.map((p) => p.partNumber) };
      }

      const manifest = [...state.parts.values()]
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((p) => ({ partNumber: p.partNumber, etag: p.etag, size: p.size, crc32c: p.crc32c }));

      const res = await apiCall('POST',
        `/api/v1/uploads/${state.session.uploadSessionId}/complete`,
        { parts: manifest, clientDuration });
      if (!res.ok) {
        // A 403 here is a plan verdict — fatal. Anything else may be retried by
        // calling finalize() again; completion is idempotent server-side.
        state.status = res.status === 403 ? 'failed' : 'stalled';
        state.fatal = res.status === 403 ? describe(res, 'the upload was rejected') : null;
        emit(res.status === 403 ? 'failed' : 'stalled', { reason: state.fatal, status: res.status });
        return { ok: false, status: res.status, body: res.body };
      }
      state.status = 'completed';
      emit('completed', res.body);
      return { ok: true, body: res.body };
    }

    /** Discard the session (user pressed Discard). Idempotent server-side. */
    async function abort() {
      if (!state.session) return { ok: true };
      const res = await apiCall('DELETE', `/api/v1/uploads/${state.session.uploadSessionId}`);
      state.status = 'idle';
      return { ok: res.ok };
    }

    /** While stalled, retry the whole drain periodically (docs/06 §6). */
    function scheduleStalledRetry() {
      if (state.status !== 'stalled') return null;
      return sleep(STALLED_RETRY_MS).then(() => {
        for (const p of state.parts.values()) if (p.status === 'stalled') { p.status = 'pending'; p.attempts = 0; }
        state.status = 'active';
        return drain();
      });
    }

    return {
      begin, addChunk, finalize, resume, abort, drain, scheduleStalledRetry,
      get state() { return state; },
      get status() { return state.status; },
      get progress() {
        return {
          uploadedBytes: state.uploadedBytes, recordedBytes: state.recordedBytes,
          ratio: state.recordedBytes ? state.uploadedBytes / state.recordedBytes : 0,
        };
      },
      _internals: { sealPart, classify, backoffMs, crc32c },
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  function describe(res, fallback) {
    const err = res && res.body && res.body.error;
    return {
      code: (err && err.code) || 'upload_failed',
      message: (err && err.message) || fallback,
      upgradeRequired: !!(err && err.upgradeRequired),
      status: res && res.status,
    };
  }

  /** Concatenate the chunks for checksumming. Works with Blob or Uint8Array. */
  async function toBytes(chunks) {
    if (!chunks || !chunks.length) return new Uint8Array(0);
    if (typeof Blob !== 'undefined' && chunks[0] instanceof Blob) {
      const buf = await new Blob(chunks).arrayBuffer();
      return new Uint8Array(buf);
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  /** The PUT body: a Blob in the browser (streams a slice, never assembled). */
  function blobOf(chunks, bytes) {
    if (typeof Blob !== 'undefined' && chunks && chunks.length && chunks[0] instanceof Blob) {
      return new Blob(chunks);
    }
    return bytes;
  }

  return {
    createUploader, classify, backoffMs, crc32c, attemptTimeoutMs, looksExpired,
    OUTCOME, MAX_PART_ATTEMPTS, CONCURRENCY_RECORDING, CONCURRENCY_STOPPED,
    CEILING_HEADROOM_BYTES, CEILING_WARN_RATIO,
  };
}));
