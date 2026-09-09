// ─────────────────────────────────────────────────────────────────────────────
// R2 UPLOAD MIRROR (T-203)
//
// After the legacy upload has already succeeded, copy the same bytes to R2 at
// `sources/{recordingId}/source.{ext}` and record a `video_assets` row.
//
// ── THE RULE THAT OUTRANKS EVERYTHING ELSE ──────────────────────────────────
// Cloudinary (or the local disk store) remains AUTHORITATIVE. This mirror runs
// after the response has been sent and can never fail, delay, or alter a
// legacy upload. Every failure path here ends in a journal entry and a log
// line, never in a thrown error reaching the request.
//
// OFF BY DEFAULT. Only the literal string 'true' enables it, matching T-105.
// When off, nothing is loaded, no storage client is constructed, and the temp
// file is removed exactly as before — so disabling is an instant rollback.
//
// ── ORDERING, WHICH IS THE SUBTLE PART ──────────────────────────────────────
// The `video_assets` row has a FOREIGN KEY to `recordings`, and that parent row
// is itself only a mirror, written on T-105's single FIFO lane. Writing the
// asset row on any other path would race its parent and fail the FK — the very
// defect T-105 already hit with concurrent mirrors. So the asset row is handed
// to `dualwrite.recordingAsset()`, which enqueues on that same lane and is
// therefore guaranteed to run after the recording it belongs to.
//
// Bytes go to storage FIRST, the row is written SECOND. If the upload fails we
// write no row, so a row never claims an object that does not exist. If the row
// fails we are left with an orphan object, which is the safe direction: it
// wastes a little storage and is detectable, whereas a dangling row would make
// the database lie about what is in the bucket.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const ENABLED = process.env.R2_MIRROR_UPLOADS === 'true'; // absent/anything else ⇒ OFF

// A mirror competes with real traffic for disk and bandwidth, so only a couple
// run at once; the rest queue. Uploads that arrive faster than we can mirror
// are shed to the journal rather than growing an unbounded queue.
const MAX_CONCURRENT = Number(process.env.R2_MIRROR_CONCURRENCY || 2) || 2;
const MAX_QUEUED = Number(process.env.R2_MIRROR_MAX_QUEUED || 100) || 100;
const TIMEOUT_MS = Number(process.env.R2_MIRROR_TIMEOUT_MS || 300_000) || 300_000;

const JOURNAL = path.join(process.env.DATA_DIR || __dirname, 'r2-mirror-failures.jsonl');

let logger = console;
let counters = null;
let dualwrite = null;
let provider = null;
let keys = null;
let initFailed = false;

const queue = [];
let inflight = 0;

/** Wire the shared logger, KPI counters and the dual-write lane (from index.js). */
function configure(deps = {}) {
  if (deps.logger) logger = deps.logger;
  if (deps.counters) counters = deps.counters;
  if (deps.dualwrite) dualwrite = deps.dualwrite;
  return module.exports;
}

/** Load the storage package lazily — never when the mirror is disabled. */
function init() {
  if (provider) return true;
  if (initFailed) return false;
  try {
    const storage = require('../storage/src/index.js');
    provider = storage.storageProvider();
    keys = storage.keys;
    (logger.info ? logger : console).info(
      { r2Mirror: true, storage: provider.describe() },
      'R2 upload mirror ENABLED (Cloudinary/legacy remains authoritative)');
    return true;
  } catch (err) {
    initFailed = true;
    (logger.error ? logger : console).error(
      { err: { message: String(err && err.message).slice(0, 300) } },
      'R2 upload mirror could not initialise — uploads are unaffected');
    return false;
  }
}

/**
 * Append a durable failure record. Written even when PostgreSQL and R2 are both
 * down, so nothing is lost to a crash; T-204/reconciliation consumes it.
 * Contains identifiers only — never bytes, URLs, tokens or request bodies.
 */
function journal(entry) {
  try {
    fs.appendFileSync(JOURNAL, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // The journal is best-effort; failing to record must not throw either.
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`r2 mirror timeout after ${ms}ms (${label})`)), ms);
    }),
  ]);
}

function drain() {
  while (inflight < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    inflight += 1;
    job().catch(() => {}).finally(() => { inflight -= 1; drain(); });
  }
}

/** Best-effort unlink that never throws and never rejects. */
function removeFile(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, () => {});
}

/**
 * Mirror one freshly uploaded file to R2.
 *
 * @param {string} filePath        the file the legacy handler just stored
 * @param {object} info
 * @param {string} info.legacyRecordingId  legacy uuid — mapped to `rec_<uuid>`
 * @param {string} info.legacyUserId
 * @param {number} info.sizeBytes          expected byte count (verified after upload)
 * @param {string} [info.container]        'webm' | 'mp4' | … server-determined
 * @param {string} [info.contentType]
 * @param {object} [opts]
 * @param {boolean} [opts.deleteAfter]     take ownership of `filePath` and remove it
 * @param {object} [ctx]                   { requestId }
 * @returns {void} never throws, never awaited by the caller
 */
function mirrorSource(filePath, info, opts = {}, ctx = {}) {
  const deleteAfter = !!opts.deleteAfter;

  // Disabled: behave exactly as the pre-T-203 handler did.
  if (!ENABLED) { if (deleteAfter) removeFile(filePath); return; }

  if (!filePath || !info || !info.legacyRecordingId) {
    if (deleteAfter) removeFile(filePath);
    return;
  }

  if (!init()) {
    journal({ op: 'source.mirror', legacyId: info.legacyRecordingId, reason: 'init_failed', retryable: true });
    if (counters) counters.r2MirrorFailure++;
    if (deleteAfter) removeFile(filePath);
    return;
  }

  if (queue.length >= MAX_QUEUED) {
    journal({ op: 'source.mirror', legacyId: info.legacyRecordingId, reason: 'overloaded', retryable: true });
    if (counters) { counters.r2MirrorAttempt++; counters.r2MirrorFailure++; }
    (logger.warn ? logger : console).warn(
      { legacyId: info.legacyRecordingId, queued: queue.length },
      'R2 mirror skipped: queue is full');
    if (deleteAfter) removeFile(filePath);
    return;
  }

  if (counters) counters.r2MirrorAttempt++;

  queue.push(async () => {
    const startedAt = Date.now();
    try {
      await withTimeout(runMirror(filePath, info, ctx), TIMEOUT_MS, 'source.mirror');
      if (counters) counters.r2MirrorSuccess++;
      logger.debug({ legacyId: info.legacyRecordingId, durationMs: Date.now() - startedAt },
        'R2 mirror ok');
    } catch (err) {
      if (counters) counters.r2MirrorFailure++;
      const message = String(err && err.message).slice(0, 300);
      // `retryable` comes from the storage taxonomy (T-201) so a transient
      // provider outage is distinguishable from a permanent rejection.
      const retryable = !!(err && err.retryable);
      logger.error({
        legacyId: info.legacyRecordingId, request_id: ctx.requestId ?? null,
        errorCode: (err && err.code) || null, retryable,
        durationMs: Date.now() - startedAt, err: { message },
      }, 'R2 mirror FAILED — the legacy upload already succeeded; needs reconciliation');
      journal({
        op: 'source.mirror', legacyId: info.legacyRecordingId,
        legacyUserId: info.legacyUserId ?? null, requestId: ctx.requestId ?? null,
        reason: 'error', errorCode: (err && err.code) || null, retryable, message,
      });
    } finally {
      // The temp file is ours only when the caller handed it over. It must be
      // removed on every path, or a failing mirror would silently fill the disk.
      if (deleteAfter) removeFile(filePath);
    }
  });
  drain();
}

/** The actual copy + row write. Throws on failure; the caller contains it. */
async function runMirror(filePath, info, ctx) {
  const recordingId = `rec_${info.legacyRecordingId}`;
  // Throws for an unsupported container — caught and journalled, never surfaced.
  const storageKey = keys.source(recordingId, info.container || 'webm');

  const stat = fs.statSync(filePath);
  const sizeBytes = stat.size;

  // Stream rather than buffer: a 500 MB recording must not be held in memory.
  // ContentLength lets the SDK send the stream directly instead of buffering it.
  await provider.putObject(storageKey, fs.createReadStream(filePath), {
    contentType: info.contentType || 'video/webm',
    contentLength: sizeBytes,
  });

  // Verify the object actually landed at the right size before claiming it
  // exists in the database. This is the canonical acceptance check ("R2 object
  // exists, size matches") and it is what stops a truncated copy from being
  // recorded as a good source.
  const head = await provider.headObject(storageKey);
  if (head.contentLength !== sizeBytes) {
    const err = new Error(
      `mirrored object size mismatch: stored ${head.contentLength}, expected ${sizeBytes}`);
    err.code = 'size_mismatch';
    throw err;
  }

  // Row LAST, and on the dual-write lane so it can never precede its parent
  // recording row. When dual-write is off there is no parent to attach to, so
  // the object is mirrored without a row and reconciliation picks it up.
  if (dualwrite && dualwrite.enabled) {
    dualwrite.recordingAsset(info.legacyRecordingId, {
      storageKey,
      sizeBytes,
      container: info.container || 'webm',
      width: info.width ?? null,
      height: info.height ?? null,
      duration: info.duration ?? null,
    }, ctx);
  }

  return { storageKey, sizeBytes };
}

module.exports = {
  configure,
  mirrorSource,
  enabled: ENABLED,
  journalPath: JOURNAL,
  _stats: () => ({ queued: queue.length, inflight, enabled: ENABLED }),
};
