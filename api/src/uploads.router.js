// ─────────────────────────────────────────────────────────────────────────────
// /api/v1/uploads — UPLOAD SESSION ENDPOINTS (T-301)
//
// The server-side half of the direct-to-storage upload protocol (docs/06).
// THE APPLICATION SERVER NEVER RECEIVES VIDEO BYTES: it creates the multipart
// upload, hands out presigned part URLs, records what the client reports, and
// finalises. Bytes go client → object storage.
//
// ── LAYERING ────────────────────────────────────────────────────────────────
//   this file      request validation, authorization, orchestration, wire shape
//   repositories   ALL PostgreSQL state, with ownership predicates in SQL
//   StorageProvider ALL object operations, presigning, multipart lifecycle
//
// There is no SQL here and no storage SDK here. A handler that needed either
// would mean the boundary had failed.
//
// ── SINGLE-PUT MODE (T-305, docs/06 §12) ────────────────────────────────────
// Files ≤ 32 MiB may use `mode:'single'`: one presigned PUT instead of a
// multipart upload. Same session row, same idempotency, same completion
// transaction — the only differences are that no multipart upload is opened,
// the PUT URL is signed with the EXACT Content-Length the client declared (so
// the provider itself refuses any other size), and completion HEADs the object
// instead of assembling parts. The declared size lives in `partSize`: a single
// session has exactly one "part", the whole object.
//
// ── OWNERSHIP ───────────────────────────────────────────────────────────────
// Every lookup goes through a SCOPED repository call, so knowing a valid
// upload-session id is never sufficient. A session belonging to someone else is
// reported as 404, identical to one that does not exist: distinguishing them
// would confirm the id to an attacker.
//
// ── WHAT T-301 DOES NOT DO ──────────────────────────────────────────────────
// No quota ledger and no atomic reservation — that is T-306. docs/06 §3 places
// a reservation in session creation, and docs/24 places the ledger in T-306, so
// this task takes the endpoints and leaves the ledger: `byteCeiling` comes from
// the plan rather than from a reserved quota, and entitlement is a pluggable
// check T-306 replaces with the ledger-backed version.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const express = require('express');
const {
  ApiError, errorHandler, badRequest, forbidden, notFound, conflict, unprocessable,
} = require('./errors');
const { createIdentityBridge, scopeOf } = require('./identity');

// docs/06 §3
const DEFAULT_PART_SIZE = 8 * 1024 * 1024;      // 8 MiB
const MIN_PART_SIZE = 5 * 1024 * 1024;          // S3 floor for every part but the last
const MAX_PARTS = 10_000;                        // S3 limit
const SESSION_TTL_MS = 48 * 60 * 60 * 1000;     // 48h
const MAX_PRESIGN_BATCH = 20;                   // docs/06 §4
const PART_URL_TTL_SECONDS = 3600;              // 1h
// docs/06 §12 — single-PUT mode
const SINGLE_MAX_BYTES = 32 * 1024 * 1024;      // 33,554,432: the single-mode ceiling
const SINGLE_URL_TTL_SECONDS = 3600;            // 1h, same as a part URL
const MODES = new Set(['multipart', 'single']);

// A hint only — FFprobe is the arbiter (invariants #11/#12).
const ALLOWED_MIME = new Set(['video/webm', 'video/mp4', 'video/quicktime']);
const MIME_CONTAINER = { 'video/webm': 'webm', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };

// A session may be created only from these recording states (docs/06 §3).
const CREATABLE_FROM = new Set(['recording', 'uploading', 'upload_failed']);

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * @param {object} deps
 * @param {() => object} deps.repositories   scoped repository factory (T-103)
 * @param {(fn) => Promise} deps.withTransaction
 * @param {object} deps.storage              StorageProvider (T-201)
 * @param {object} deps.keys                 canonical key builders
 * @param {Function} deps.requireAuth        express middleware setting req.userId
 * @param {object} [deps.entitlements]       { checkAtComplete } — replaced by T-306
 * @param {object} [deps.logger]
 */
function createUploadRouter(deps) {
  const {
    repositories, withTransaction, storage, keys, requireAuth,
    entitlements = defaultEntitlements(), logger = console,
    // T-304: optional hook so a v1 upload reports through the SAME KPI module
    // as the legacy path. A no-op by default, so the router stays usable
    // without it and no parallel metrics store is created.
    telemetry = { uploadStarted() {}, uploadFinished() {} },
    // T-306: the quota ledger (api/src/quota createQuota). When present, session
    // creation reserves quota atomically in the same transaction that inserts
    // the session, completion reconciles, and abort releases. When absent the
    // T-301 `entitlements` seam applies unchanged — so the router is usable
    // (and its earlier suites hold) without a ledger.
    quota = null,
  } = deps;

  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));   // manifests only — never bytes
  router.use(requireAuth);
  // Translate the legacy id to the PostgreSQL identity ONCE, here, before any
  // ownership scope is built. `req.userId` is deliberately untouched: the same
  // requireAuth instance serves 59 legacy routes that read it as the legacy id.
  router.use(createIdentityBridge({ repositories, logger }));


  // ── POST /uploads — create (or replay) a session ──────────────────────────
  router.post('/uploads', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const { recordingId, mimeType, sizeBytes } = req.body || {};
    const mode = (req.body && req.body.mode) || 'multipart';
    const idempotencyKey = req.get('Idempotency-Key');

    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length > 200) {
      throw badRequest('idempotency_key_required',
        'An Idempotency-Key header is required so a retried request cannot create a second session.');
    }
    if (!recordingId || typeof recordingId !== 'string') {
      throw badRequest('invalid_request', 'recordingId is required.');
    }
    if (!ALLOWED_MIME.has(mimeType)) {
      throw badRequest('unsupported_media_type',
        `mimeType must be one of ${[...ALLOWED_MIME].join(', ')}.`);
    }
    if (!MODES.has(mode)) {
      throw badRequest('invalid_request', `mode must be one of ${[...MODES].join(', ')}.`);
    }
    // Single mode signs the PUT with an exact Content-Length, so the size must
    // be declared up front — and it must fit under the single-mode ceiling.
    if (mode === 'single') {
      if (!Number.isInteger(sizeBytes) || sizeBytes < 1) {
        throw badRequest('invalid_request', 'sizeBytes (a positive integer) is required for mode "single".');
      }
      if (sizeBytes > SINGLE_MAX_BYTES) {
        throw badRequest('invalid_request',
          `Single-PUT uploads are limited to ${SINGLE_MAX_BYTES} bytes; use multipart for larger files.`,
          { meta: { singleMaxBytes: SINGLE_MAX_BYTES, sizeBytes } });
      }
    }

    // Retry of the same request returns the same session — checked FIRST so a
    // replay never reaches the storage provider or creates a second multipart.
    const replay = await repos.uploads.findByIdempotencyKey(scope, idempotencyKey);
    if (replay) return res.status(200).json(await sessionBody(storage, replay));

    // Ownership: a scoped read. A recording belonging to another user is simply
    // not found, which is also what makes id-guessing useless.
    const recording = await repos.recordings.get(scope, recordingId);
    if (!recording) throw notFound('recording_not_found', 'Recording not found.');
    if (!CREATABLE_FROM.has(recording.status)) {
      throw conflict('invalid_state',
        `An upload cannot start while the recording is "${recording.status}".`);
    }

    // One live session per recording: return the existing one rather than
    // opening a second multipart upload against the same key (docs/06 §2).
    const open = await repos.uploads.findOpenForRecording(scope, recordingId);
    if (open) return res.status(200).json(await sessionBody(storage, open));

    const container = MIME_CONTAINER[mimeType];
    const storageKey = keys.source(recordingId, container);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const limits = quota ? await quota.resolveLimits(req) : null;
    // Without a ledger (T-301 seam) the ceiling is the plan's; with one, the
    // ceiling IS the reservation, decided inside the transaction below.
    const planCeiling = quota ? null : await entitlements.byteCeiling({ repos, scope, recording });

    /**
     * Insert the session row — and, with a ledger, reserve quota in the SAME
     * transaction (docs/06 §3, docs/16 §4.3): usage row lock → live totals →
     * guarded UPDATE → session → reservation row. A guard refusal throws the
     * 403 and rolls everything back, so no session and no reservation exist.
     * `fixedCeiling` (single mode) caps the reservation at the declared size's
     * mode ceiling; the declared size itself must fit or the create is refused.
     */
    async function persistSession(fields, { fixedCeiling = null, declaredBytes = null } = {}) {
      if (!quota) {
        return repos.uploads.createSession(scope, { ...fields, byteCeiling: fixedCeiling ?? planCeiling, expiresAt });
      }
      return withTransaction(async (tx) => {
        const { reserveBytes } = await quota.reserve({
          tx, scope, limits, expiresAt, maxBytes: fixedCeiling, declaredBytes,
        });
        const session = await tx.uploads.createSession(scope, { ...fields, byteCeiling: reserveBytes, expiresAt });
        await quota.attach({ tx, scope, uploadSessionId: session.id, reserveBytes, expiresAt });
        return session;
      });
    }

    async function replayOnConflict(err) {
      if (err && err.code === 'conflict') {
        const existing = await repos.uploads.findByIdempotencyKey(scope, idempotencyKey)
          || await repos.uploads.findOpenForRecording(scope, recordingId);
        if (existing) return existing;
      }
      throw err;
    }

    if (mode === 'single') {
      // docs/06 §12: the single-mode ceiling is the byte ceiling — never more
      // than the plan allows, never more than 32 MiB. The declared size must
      // already fit, or the PUT we are about to sign could never succeed.
      if (!quota && sizeBytes > Math.min(planCeiling, SINGLE_MAX_BYTES)) {
        throw forbidden('storage_limit',
          'This upload would exceed the size limit reserved for the recording.',
          { upgradeRequired: true, meta: { byteCeiling: Math.min(planCeiling, SINGLE_MAX_BYTES), sizeBytes } });
      }
      // No multipart upload to open: the row is the only thing created here.
      let session;
      try {
        session = await persistSession({
          recordingId, storageKey, storageUploadId: null, mode: 'single',
          partSize: sizeBytes, clientMime: mimeType, idempotencyKey,
        }, { fixedCeiling: SINGLE_MAX_BYTES, declaredBytes: sizeBytes });
      } catch (err) {
        const existing = await replayOnConflict(err);
        return res.status(200).json(await sessionBody(storage, existing));
      }
      telemetry.uploadStarted(req, { sizeBytes, mode: 'single' });
      return res.status(201).json(await sessionBody(storage, session));
    }

    // The multipart upload is created BEFORE the row, so a row never claims a
    // storage upload that does not exist. The reverse would leave a session the
    // client could presign against with no upload behind it.
    const { uploadId } = await storage.createMultipartUpload(storageKey, {
      contentType: mimeType,
    });

    let session;
    try {
      session = await persistSession({
        recordingId, storageKey, storageUploadId: uploadId,
        partSize: DEFAULT_PART_SIZE, clientMime: mimeType, idempotencyKey,
      });
    } catch (err) {
      // The row lost a race (concurrent create with the same key, or another
      // session for this recording), or the quota guard refused. Abandoning
      // the multipart we just opened would leak an incomplete upload, so abort
      // it — abort is idempotent.
      await storage.abortMultipartUpload(storageKey, uploadId).catch(() => {});
      const existing = await replayOnConflict(err);
      return res.status(200).json(await sessionBody(storage, existing));
    }

    telemetry.uploadStarted(req, { sizeBytes: null, mode: 'multipart' });
    return res.status(201).json(await sessionBody(storage, session));
  }));

  // ── GET /uploads/:id — status + parts, the resume source of truth ─────────
  router.get('/uploads/:id', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const session = await mustGetSession(repos, scope, req.params.id);

    const recorded = await repos.uploads.listParts(scope, session.id);

    // docs/06 §10: where our rows and storage disagree, STORAGE WINS. Our row
    // is only a report from the client; the object store is what actually holds
    // the bytes, so a part we never recorded is still uploaded.
    let authoritative = recorded;
    if (session.storageUploadId && (session.status === 'pending' || session.status === 'active')) {
      const live = await storage.listParts(session.storageKey, session.storageUploadId)
        .catch(() => null);
      if (live) authoritative = mergePartsStorageWins(recorded, live);
    }

    return res.json({
      uploadSessionId: session.id,
      recordingId: session.recordingId,
      status: session.status,
      mode: session.mode,
      partSize: session.partSize,
      minPartSize: MIN_PART_SIZE,
      maxParts: MAX_PARTS,
      byteCeiling: Number(session.byteCeiling),
      expiresAt: session.expiresAt,
      parts: authoritative.map((p) => ({
        partNumber: p.partNumber, size: p.size ?? null, etag: p.etag ?? null,
      })),
    });
  }));

  // ── POST /uploads/:id/parts — batched presign ─────────────────────────────
  router.post('/uploads/:id/parts', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const session = await mustGetSession(repos, scope, req.params.id);
    assertUsable(session);

    assertMultipart(session);
    const requested = normalisePartRequest(req.body, session.partSize);

    // Byte-ceiling enforcement (docs/06 §4). A hostile client holding valid
    // URLs still cannot push bytes past its ceiling, because we refuse to MINT
    // the URLs — and each URL is signed with its exact Content-Length, so the
    // bytes cannot exceed what was authorised either.
    const already = await repos.uploads.sumPartBytes(scope, session.id);
    const declared = requested.reduce((sum, p) => sum + p.size, 0);
    const ceiling = Number(session.byteCeiling);
    if (already + declared > ceiling) {
      throw forbidden('storage_limit',
        'This upload would exceed the size limit reserved for the recording.',
        { upgradeRequired: true, meta: { byteCeiling: ceiling, alreadyDeclared: already } });
    }

    // First presign moves the session pending → active (docs/06 §4).
    if (session.status === 'pending') {
      await repos.uploads.setSessionStatus(scope, session.id, 'active');
    }

    const urls = [];
    for (const part of requested) {
      urls.push({
        partNumber: part.partNumber,
        url: await storage.getSignedPartUrl(
          session.storageKey, session.storageUploadId, part.partNumber,
          { expiresIn: PART_URL_TTL_SECONDS, contentLength: part.size }),
        expiresAt: new Date(Date.now() + PART_URL_TTL_SECONDS * 1000).toISOString(),
      });
    }
    // Presigned URLs are bearer credentials for one object — never logged.
    return res.json({ parts: urls });
  }));

  // ── PUT /uploads/:id/parts/:n — record a part the client uploaded ─────────
  router.put('/uploads/:id/parts/:n', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const session = await mustGetSession(repos, scope, req.params.id);
    assertUsable(session);

    assertMultipart(session);
    const partNumber = Number(req.params.n);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) {
      throw badRequest('invalid_request', `partNumber must be an integer in [1, ${MAX_PARTS}].`);
    }
    const { etag, size, crc32c } = req.body || {};
    if (typeof etag !== 'string' || !etag) throw badRequest('invalid_request', 'etag is required.');
    if (!Number.isInteger(size) || size < 1) throw badRequest('invalid_request', 'size must be a positive integer.');

    // Upsert on (session, partNumber) — naturally idempotent, so the client's
    // retry-after-timeout is free and re-recording a part is not an error.
    const part = await repos.uploads.recordPart(scope, session.id, {
      partNumber, size, etag: stripQuotes(etag), crc32c: crc32c || null,
    });
    return res.json({ partNumber: part.partNumber, size: part.size, etag: part.etag });
  }));

  // ── POST /uploads/:id/complete — finalise (idempotent) ────────────────────
  router.post('/uploads/:id/complete', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const session = await mustGetSession(repos, scope, req.params.id);

    // 1. Already completed → replay the canonical result. This is the spec's
    //    own idempotency example and must never create a second asset.
    if (session.status === 'completed') {
      return res.json(completedBody(session));
    }
    if (session.status === 'aborted' || session.status === 'expired') {
      throw conflict('invalid_state', `This upload session is ${session.status}.`);
    }

    let stored;
    if (session.mode === 'single') {
      // docs/06 §12: complete is the same endpoint with `parts:[]`, and the
      // server HEADs the object. There is nothing to assemble — the PUT either
      // landed the whole object or it did not.
      const parts = req.body && req.body.parts;
      if (parts !== undefined && !(Array.isArray(parts) && parts.length === 0)) {
        throw unprocessable('upload_manifest_invalid',
          'A single-PUT session completes with an empty parts list.');
      }
      stored = await storage.headObject(session.storageKey).catch((err) => {
        if (err && err.code === 'object_not_found') return null;
        throw err;
      });
      if (!stored) {
        // The client says it finished but the object is not there. Nothing is
        // changed: the session stays usable so the client can PUT and retry.
        throw new ApiError(409, 'upload_object_missing',
          'The uploaded file was not found in storage. Upload it, then complete again.');
      }
      const declared = Number(session.partSize);
      if (stored.contentLength !== declared) {
        // The signed Content-Length should make this impossible; if it happens
        // the bytes are suspect and nothing is finalised. Not deleted either.
        throw new ApiError(500, 'upload_size_mismatch',
          'The stored object size does not match the declared size. Please retry.',
          { meta: { storedBytes: stored.contentLength, declaredBytes: declared } });
      }
    } else {
      // 2. Validate the manifest BEFORE touching storage.
      const manifest = normaliseManifest(req.body, session);
      const total = manifest.reduce((sum, p) => sum + p.size, 0);
      const ceiling = Number(session.byteCeiling);
      if (total > ceiling) {
        // Over the ceiling: abort the multipart so the parts do not linger, and
        // refuse. No application state is created — and with a ledger, the
        // reservation goes back too (T-306), or it would sit held until expiry.
        await storage.abortMultipartUpload(session.storageKey, session.storageUploadId).catch(() => {});
        if (quota) {
          await withTransaction(async (tx) => {
            await quota.release({ tx, scope, session, status: 'released' });
            await tx.uploads.setSessionStatus(scope, session.id, 'aborted');
          });
        } else {
          await repos.uploads.setSessionStatus(scope, session.id, 'aborted');
        }
        throw unprocessable('upload_manifest_invalid',
          'The upload is larger than the limit reserved for this recording.',
          { meta: { byteCeiling: ceiling, declaredBytes: total } });
      }

      // 3+4. Finalise in storage and confirm the object. Deliberately OUTSIDE the
      // database transaction: CompleteMultipartUpload is a network call, and
      // holding a transaction across it would pin a connection for its duration.
      // Safe because step 3's own rule makes a crash here recoverable — a retry
      // finds the upload gone but the object present and treats that as success.
      stored = await finaliseInStorage(storage, session, manifest);
      if (stored.contentLength !== total) {
        // Do NOT delete anything: the bytes may be fine and the manifest wrong.
        throw new ApiError(500, 'upload_size_mismatch',
          'The stored object size does not match the uploaded parts. Please retry.',
          { meta: { storedBytes: stored.contentLength, declaredBytes: total } });
      }
    }

    // Entitlement at completion (docs/06 §7 step 5): re-checked with the REAL
    // size, which is the only size that was ever trustworthy.
    //
    // Rejection keeps the source (user content is never silently destroyed —
    // an upgrade can still rescue it, docs/06 §7), marks the recording
    // rejected_limit, aborts the session and, with a ledger, RELEASES the
    // reservation so the refused bytes do not stay counted against the user.
    const reject = async (verdict) => {
      await repos.recordings.updateSystem(session.recordingId, { status: 'rejected_limit' },
        'T-301: entitlement rejected the upload at completion');
      if (quota) {
        await withTransaction(async (tx) => {
          await quota.release({ tx, scope, session, status: 'released' });
          await tx.uploads.setSessionStatus(scope, session.id, 'aborted');
        });
      } else {
        await repos.uploads.setSessionStatus(scope, session.id, 'aborted');
      }
      telemetry.uploadFinished(req, 'rejected_limit', { code: verdict.code || 'storage_limit', mode: session.mode });
      throw forbidden(verdict.code || 'storage_limit', verdict.message
        || 'This upload exceeds your plan.', { upgradeRequired: true, meta: verdict.meta });
    };
    if (!quota) {
      const verdict = await entitlements.checkAtComplete({ repos, scope, session, sizeBytes: stored.contentLength });
      if (!verdict.allowed) await reject(verdict);
    }

    // 5+6. One short transaction: session, recording, asset and the outbox row
    // commit together. If any part fails, none of it happened — the database
    // can never claim a completed recording whose asset row is missing.
    //
    // T-306: with a ledger, the plan re-check and the reconciliation happen
    // HERE, under the usage row lock (docs/16 §4.4 — "all in the same
    // transaction as the event"): retained += real size, reserved −= the
    // reservation, one slot back, active += 1, reservation reconciled. A
    // failed re-check throws out of the transaction (nothing committed) and is
    // then handled by `reject` above.
    let quotaVerdict = null;
    const result = await withTransaction(async (tx) => {
      if (quota) {
        const limits = await quota.resolveLimits(req);
        const v = await quota.checkAtComplete({ tx, scope, limits, session, sizeBytes: stored.contentLength });
        if (!v.allowed) { quotaVerdict = v; throw new ApiError(403, v.code || 'storage_limit', v.message || 'Rejected'); }
        await quota.reconcile({ tx, scope, session, sizeBytes: stored.contentLength });
      }
      await tx.uploads.setSessionStatus(scope, session.id, 'completed',
        { completedAt: new Date() });
      await tx.recordings.updateSystem(session.recordingId,
        { status: 'uploaded', sizeBytes: stored.contentLength },
        'T-301: upload completed');
      await tx.assets.upsertSourceSystem({
        recordingId: session.recordingId, storageKey: session.storageKey,
        sizeBytes: stored.contentLength, container: MIME_CONTAINER[session.clientMime] || 'webm',
      }, 'T-301: source asset finalised from a completed upload session');
      // Transactional outbox (docs/10 §3): the job row commits WITH the state
      // change, so a probe can never be lost by a crash between them, and a
      // relay enqueues it afterwards. T-301 writes the row only — T-601 builds
      // the relay and the workers.
      await tx.jobs.enqueue({
        queue: 'probe', dedupeKey: `probe:${session.recordingId}`,
        recordingId: session.recordingId, payload: { storageKey: session.storageKey },
      });
      return tx.uploads.getSession(scope, session.id);
    }).catch(async (err) => {
      // A quota verdict threw out of the transaction: nothing was committed.
      // Now apply the rejection outcome in its own transaction.
      if (quotaVerdict) await reject(quotaVerdict);
      throw err;
    });

    telemetry.uploadFinished(req, 'success', { sizeBytes: stored.contentLength, mode: session.mode });
    return res.json(completedBody(result || session));
  }));

  // ── DELETE /uploads/:id — abort, idempotent ───────────────────────────────
  router.delete('/uploads/:id', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const session = await mustGetSession(repos, scope, req.params.id);

    // Aborting a completed session must not destroy a finished upload.
    if (session.status === 'completed') {
      throw conflict('invalid_state', 'This upload has already completed and cannot be aborted.');
    }
    // Already aborted/expired → 200. Discard is a user action that may be
    // retried, and a second abort is not an error (docs/06 §8).
    if (session.status === 'aborted' || session.status === 'expired') {
      return res.json({ uploadSessionId: session.id, status: session.status });
    }

    if (session.storageUploadId) {
      await storage.abortMultipartUpload(session.storageKey, session.storageUploadId)
        .catch((err) => {
          // Abort is safely repeatable and an unknown upload resolves, so a
          // failure here must not strand the session in a live state.
          logger.warn && logger.warn({ code: err && err.code },
            'v1 upload abort: storage abort failed; marking the session aborted anyway');
        });
    } else if (session.mode === 'single') {
      // A single-PUT session may already have landed its object. Discarding
      // an INCOMPLETE upload is the user's explicit action and is the same
      // thing abort does to multipart parts; a completed session was refused
      // above, so a finished recording can never be deleted through here.
      await storage.deleteObject(session.storageKey).catch((err) => {
        logger.warn && logger.warn({ code: err && err.code },
          'v1 upload abort: single-PUT object delete failed; marking the session aborted anyway');
      });
    }
    // T-306: the reservation is returned in the same transaction that aborts
    // the session (docs/16 §4.4). Release is idempotent — a re-abort, or a
    // session that never held a reservation, releases nothing.
    if (quota) {
      await withTransaction(async (tx) => {
        await quota.release({ tx, scope, session, status: 'released' });
        await tx.uploads.setSessionStatus(scope, session.id, 'aborted');
      });
    } else {
      await repos.uploads.setSessionStatus(scope, session.id, 'aborted');
    }
    return res.json({ uploadSessionId: session.id, status: 'aborted' });
  }));

  router.use(errorHandler(logger));
  return router;
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function mustGetSession(repos, scope, id) {
  if (!id || typeof id !== 'string') throw badRequest('invalid_request', 'An upload session id is required.');
  // SCOPED: another user's session is indistinguishable from a missing one.
  const session = await repos.uploads.getSession(scope, id);
  if (!session) throw notFound('upload_session_not_found', 'Upload session not found.');
  return session;
}

function assertUsable(session) {
  if (session.status === 'completed') {
    throw conflict('invalid_state', 'This upload has already completed.');
  }
  if (session.status === 'aborted' || session.status === 'expired') {
    throw conflict('invalid_state', `This upload session is ${session.status}.`);
  }
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    throw conflict('upload_session_expired', 'This upload session has expired; start a new one.');
  }
}

function normalisePartRequest(body, partSize) {
  const raw = (body && (body.parts || body.partNumbers)) || null;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw badRequest('invalid_request', 'parts must be a non-empty array.');
  }
  if (raw.length > MAX_PRESIGN_BATCH) {
    throw badRequest('invalid_request', `At most ${MAX_PRESIGN_BATCH} parts may be presigned per call.`);
  }
  const seen = new Set();
  return raw.map((entry) => {
    const partNumber = typeof entry === 'number' ? entry : entry && entry.partNumber;
    const size = (typeof entry === 'object' && entry && entry.size != null) ? entry.size : partSize;
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) {
      throw badRequest('invalid_request', `partNumber must be an integer in [1, ${MAX_PARTS}].`);
    }
    if (seen.has(partNumber)) throw badRequest('invalid_request', `Duplicate partNumber ${partNumber}.`);
    seen.add(partNumber);
    if (!Number.isInteger(size) || size < 1) {
      throw badRequest('invalid_request', `size for part ${partNumber} must be a positive integer.`);
    }
    return { partNumber, size };
  });
}

function normaliseManifest(body, session) {
  const parts = body && body.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw unprocessable('upload_manifest_invalid', 'The manifest must list at least one part.');
  }
  const normalised = parts.map((p) => {
    if (!p || !Number.isInteger(p.partNumber) || typeof p.etag !== 'string' || !p.etag
      || !Number.isInteger(p.size) || p.size < 1) {
      throw unprocessable('upload_manifest_invalid',
        'Every manifest entry needs a partNumber, an etag and a size.');
    }
    return { partNumber: p.partNumber, etag: stripQuotes(p.etag), size: p.size };
  }).sort((a, b) => a.partNumber - b.partNumber);

  // Contiguous from 1 — a gap means a missing part, and completing with one
  // would produce a silently truncated recording.
  for (let i = 0; i < normalised.length; i += 1) {
    if (normalised[i].partNumber !== i + 1) {
      throw unprocessable('upload_manifest_invalid',
        `Part numbers must be contiguous from 1; part ${i + 1} is missing.`);
    }
    const isLast = i === normalised.length - 1;
    if (!isLast && normalised[i].size < MIN_PART_SIZE) {
      throw unprocessable('upload_manifest_invalid',
        `Part ${normalised[i].partNumber} is below the ${MIN_PART_SIZE}-byte minimum; only the last part may be smaller.`);
    }
  }
  if (normalised.length > MAX_PARTS) {
    throw unprocessable('upload_manifest_invalid', `A manifest may not exceed ${MAX_PARTS} parts.`);
  }
  return normalised;
}

/**
 * Complete in storage, tolerating the crash-recovery case.
 * docs/06 §7 step 3: if the upload id is gone but the object is present at the
 * expected size, a previous attempt already completed it — that is success, not
 * an error, and it is what makes a crash between storage and the database safe.
 */
async function finaliseInStorage(storage, session, manifest) {
  try {
    await storage.completeMultipartUpload(session.storageKey, session.storageUploadId,
      manifest.map((p) => ({ partNumber: p.partNumber, etag: p.etag })));
  } catch (err) {
    const recoverable = err && (err.code === 'upload_not_found' || err.code === 'multipart_failed');
    if (!recoverable) throw err;
    const existing = await storage.headObject(session.storageKey).catch(() => null);
    if (!existing) throw err;
  }
  return storage.headObject(session.storageKey);
}

/** docs/06 §10: our rows are a client report; the object store is the truth. */
function mergePartsStorageWins(recorded, live) {
  const merged = new Map();
  for (const p of recorded) merged.set(p.partNumber, { partNumber: p.partNumber, size: p.size, etag: p.etag });
  for (const p of live) merged.set(p.partNumber, { partNumber: p.partNumber, size: p.size, etag: p.etag });
  return [...merged.values()].sort((a, b) => a.partNumber - b.partNumber);
}

/** Presign and record refuse a single-PUT session: it has no parts. */
function assertMultipart(session) {
  if (session.mode === 'single') {
    throw conflict('invalid_state',
      'This is a single-PUT session; upload the whole file to its uploadUrl and then complete.');
  }
}

/**
 * The create/replay body. For a single-PUT session this MINTS the PUT URL on
 * every call — presigned URLs are bearer credentials and are never stored, so
 * a replay gets a fresh one for the same key, signed with the same exact size.
 */
async function sessionBody(storage, s) {
  const body = {
    uploadSessionId: s.id,
    recordingId: s.recordingId,
    mode: s.mode || 'multipart',
    partSize: s.partSize,
    minPartSize: MIN_PART_SIZE,
    maxParts: MAX_PARTS,
    byteCeiling: Number(s.byteCeiling),
    expiresAt: s.expiresAt,
    status: s.status,
  };
  if (s.mode === 'single' && (s.status === 'pending' || s.status === 'active')) {
    const declared = Number(s.partSize);
    body.uploadUrl = await storage.getSignedUploadUrl(s.storageKey, {
      expiresIn: SINGLE_URL_TTL_SECONDS,
      contentLength: declared,                 // signed: the provider enforces it
      contentType: s.clientMime || undefined,  // signed: the client must send it
    });
    body.uploadUrlExpiresAt = new Date(Date.now() + SINGLE_URL_TTL_SECONDS * 1000).toISOString();
    body.uploadHeaders = { 'Content-Type': s.clientMime, 'Content-Length': declared };
  }
  return body;
}

const completedBody = (s) => ({
  recordingId: s.recordingId,
  uploadSessionId: s.id,
  status: 'uploaded',
});

const stripQuotes = (v) => String(v).replace(/^"|"$/g, '');

/**
 * Default entitlement boundary.
 *
 * T-301 deliberately does NOT implement the quota ledger or atomic reservation
 * (T-306). This provides the plan-level ceiling the protocol needs — so a
 * hostile client still cannot exceed a server-decided size — and the
 * completion-time re-check the spec requires, without touching `usage`.
 * T-306 replaces this object with the ledger-backed version.
 */
function defaultEntitlements() {
  const PLAN_MAX_UPLOAD_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 512 * 1024 * 1024);
  return {
    async byteCeiling() { return PLAN_MAX_UPLOAD_BYTES; },
    async checkAtComplete({ session, sizeBytes }) {
      const ceiling = Number(session.byteCeiling);
      if (sizeBytes > ceiling) {
        return {
          allowed: false, code: 'storage_limit',
          message: 'This recording is larger than your plan allows.',
          meta: { byteCeiling: ceiling, actualBytes: sizeBytes },
        };
      }
      return { allowed: true };
    },
  };
}

module.exports = {
  createUploadRouter, defaultEntitlements,
  DEFAULT_PART_SIZE, MIN_PART_SIZE, MAX_PARTS, MAX_PRESIGN_BATCH, SESSION_TTL_MS,
  SINGLE_MAX_BYTES, SINGLE_URL_TTL_SECONDS,
  ALLOWED_MIME, normaliseManifest, mergePartsStorageWins,
};
