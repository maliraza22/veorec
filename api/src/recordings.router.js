// ─────────────────────────────────────────────────────────────────────────────
// /api/v1/recordings — RECORDINGS CRUD (T-302)
//
// The dashboard's read path, served from PostgreSQL. Today the library page
// needs a JSON store read PLUS a Cloudinary listing to render; `GET /recordings`
// here is ONE indexed query, which is the point of "list from DB!" in the plan.
//
// ── LAYERING ────────────────────────────────────────────────────────────────
//   this file       validation, authorization, orchestration, wire shape
//   repositories    ALL PostgreSQL state, ownership predicates in SQL
//   StorageProvider ALL object operations (signed URLs only, here)
//
// No SQL and no storage SDK in this file. Cloudinary appears nowhere: the v1
// read path is Postgres + StorageProvider, and the legacy Cloudinary path keeps
// serving the legacy routes untouched.
//
// ── OWNERSHIP ───────────────────────────────────────────────────────────────
// Every call is a SCOPED repository call, so knowing a recording id is never
// sufficient. Another user's recording is reported 404, identical to one that
// does not exist — distinguishing them would confirm the id to an attacker.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const crypto = require('crypto');
const express = require('express');
const { errorHandler, badRequest, forbidden, notFound } = require('./errors');
const { createIdentityBridge, scopeOf } = require('./identity');

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 5000;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 50;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;

const SOURCE_KINDS = new Set(['extension', 'web_upload']);
const PRIVACY = new Set(['public', 'unlisted', 'workspace', 'login', 'password']);

// docs/08 §4: these three are Pro features and each is a paywall, not a
// validation error — they answer 403 `feature_locked`, never a silent no-op.
const GATED_FIELDS = {
  password: 'passwordProtection',
  removeBranding: 'removeBranding',
};

// Playback URLs are short-lived for private media (docs/12 §6).
const SIGNED_URL_TTL_SECONDS = 600;

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * @param {object} deps
 * @param {() => object} deps.repositories
 * @param {(fn) => Promise} deps.withTransaction
 * @param {object} deps.storage       StorageProvider — signed URLs only
 * @param {Function} deps.requireAuth
 * @param {object} [deps.entitlements] { isFeatureEnabled(feature, ctx) }
 * @param {object} [deps.logger]
 */
function createRecordingsRouter(deps) {
  const {
    repositories, withTransaction, storage, requireAuth,
    entitlements = defaultEntitlements(), logger = console,
  } = deps;

  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));   // metadata only — never media
  router.use(requireAuth);
  // Translate the legacy id to the PostgreSQL identity ONCE, here, before any
  // ownership scope is built. `req.userId` is deliberately untouched: the same
  // requireAuth instance serves 59 legacy routes that read it as the legacy id.
  router.use(createIdentityBridge({ repositories, logger }));


  // ── POST /recordings ──────────────────────────────────────────────────────
  router.post('/recordings', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const { title, source, clientMeta } = req.body || {};

    if (!SOURCE_KINDS.has(source)) {
      throw badRequest('invalid_request', `source must be one of ${[...SOURCE_KINDS].join(', ')}.`);
    }
    const cleanTitle = title === undefined ? undefined : normaliseTitle(title);
    const idempotencyKey = req.get('Idempotency-Key');

    // Idempotency without a dedicated column: the id is DERIVED from
    // (userId, key), so a replayed create collides on the primary key and
    // returns the same row instead of making a second recording. The user id is
    // inside the hash, so two users' keys can never collide, and a guessed id
    // still fails the scoped read because the row belongs to someone else.
    let id;
    if (idempotencyKey) {
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length > 200) {
        throw badRequest('invalid_request', 'Idempotency-Key must be a string of at most 200 characters.');
      }
      // Namespaced by the POSTGRESQL identity: the recording is a PostgreSQL
      // row, so the legacy id has no business appearing inside its key.
      id = derivedRecordingId(req.pgUserId, idempotencyKey);
      const existing = await repos.recordings.get(scope, id);
      if (existing) return res.status(200).json(summary(existing, null));
    }

    // Advisory only (docs/08 §4): authoritative enforcement is the atomic
    // reservation at upload-session creation, which is T-306. A row costs
    // nothing, so this must not be the gate.
    const advisory = await entitlements.canCreateRecording({ repos, scope });
    if (advisory && advisory.allowed === false) {
      throw forbidden(advisory.code || 'video_limit', advisory.message || 'Plan limit reached.',
        { upgradeRequired: true, meta: advisory.meta });
    }

    const created = await repos.recordings.create(scope, {
      ...(id ? { id } : {}),
      title: cleanTitle,
      sourceKind: source,
      status: 'recording',
      clientDurationHint: clientMeta && Number.isFinite(clientMeta.duration)
        ? clientMeta.duration : null,
    });
    return res.status(201).json({ id: created.id, status: created.status });
  }));

  // ── GET /recordings — the dashboard list, one indexed query ──────────────
  router.get('/recordings', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();

    const limit = clampInt(req.query.limit, DEFAULT_PAGE, 1, MAX_PAGE);
    const archived = req.query.archived === 'true';
    const folderId = req.query.folder === undefined ? undefined
      : (req.query.folder === '' || req.query.folder === 'null' ? null : String(req.query.folder));
    const cursor = req.query.cursor ? new Date(req.query.cursor) : undefined;
    if (cursor && Number.isNaN(cursor.getTime())) {
      throw badRequest('invalid_request', 'cursor must be an ISO timestamp.');
    }

    // One extra row tells us whether another page exists without a COUNT.
    const rows = await repos.recordings.list(scope, {
      folderId, archived, limit: limit + 1, cursor,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    // `q` is a client-side convenience filter in v1: the canonical text search
    // belongs with the search index, and a naive LIKE over a growing library
    // would be a silent performance trap.
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const filtered = q
      ? page.filter((r) => String(r.title || '').toLowerCase().includes(q))
      : page;

    return res.json({
      items: filtered.map((r) => summary(r, null)),
      nextCursor: hasMore ? page[page.length - 1].createdAt : null,
    });
  }));

  // ── GET /recordings/:id ───────────────────────────────────────────────────
  router.get('/recordings/:id', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const recording = await mustGet(repos, scope, req.params.id);
    const assets = await repos.assets.listForRecording(scope, recording.id);

    // Signed, short-lived, and minted only AFTER the scoped read proved
    // ownership — never derived from a stored public URL.
    let playbackUrl = null;
    const source = assets.find((a) => a.kind === 'source' && a.status === 'ready');
    if (source && storage) {
      playbackUrl = await storage.getSignedDownloadUrl(source.storageKey,
        { expiresIn: SIGNED_URL_TTL_SECONDS }).catch(() => null);
    }

    return res.json({
      ...summary(recording, null),
      description: recording.description,
      trimStart: numOrNull(recording.trimStart),
      trimEnd: numOrNull(recording.trimEnd),
      segments: recording.segments ?? null,
      chapters: recording.chapters ?? null,
      audience: recording.audience ?? {},
      cta: recording.cta ?? null,
      recommendedSpeed: numOrNull(recording.recommendedSpeed),
      animatedThumbnail: recording.animatedThumbnail,
      removeBranding: recording.removeBranding ?? false,
      width: recording.width ?? null,
      height: recording.height ?? null,
      failureCode: recording.failureCode ?? null,
      assets: assets.map((a) => ({
        id: a.id, kind: a.kind, status: a.status, variant: a.variant ?? null,
        sizeBytes: a.sizeBytes ?? null,
        // The storage KEY is internal. Callers get a signed URL or nothing.
      })),
      playbackUrl,
      // Capability flags the dashboard renders from, rather than guessing.
      canTranscribe: recording.status === 'ready' || recording.status === 'uploaded',
      canStitch: recording.status === 'ready',
    });
  }));

  // ── PATCH /recordings/:id — title only ────────────────────────────────────
  router.patch('/recordings/:id', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    await mustGet(repos, scope, req.params.id);

    if (!req.body || req.body.title === undefined) {
      throw badRequest('invalid_request', 'title is required.');
    }
    const title = normaliseTitle(req.body.title);
    const updated = await repos.recordings.update(scope, req.params.id, { title });
    return res.json({ title: updated.title });
  }));

  // ── PATCH /recordings/:id/meta ────────────────────────────────────────────
  router.patch('/recordings/:id/meta', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const recording = await mustGet(repos, scope, req.params.id);

    const patch = await buildMetaPatch(req.body || {}, {
      entitlements, repos, scope, recording,
    });
    if (Object.keys(patch).length === 0) {
      throw badRequest('invalid_request', 'No supported metadata field was supplied.');
    }
    const updated = await repos.recordings.update(scope, recording.id, patch);
    return res.json(metaBody(updated));
  }));

  // ── DELETE /recordings/:id — soft delete + usage, one transaction ─────────
  router.delete('/recordings/:id', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();

    // Idempotent (docs/08 §4): deleting an already-deleted recording is 200.
    // A scoped read excludes soft-deleted rows, so "already deleted" and
    // "never existed" both land here — and both are a successful no-op, which
    // is what makes a retried delete safe.
    const existing = await repos.recordings.get(scope, req.params.id);
    if (!existing) return res.json({ ok: true });

    await withTransaction(async (tx) => {
      // Lock the usage row FIRST and for the whole transaction. Two deletes, or
      // a delete racing an upload completion, serialize here instead of both
      // reading a stale total and writing back a wrong one. getForUpdate
      // refuses to run outside a transaction, so this cannot be bypassed.
      const current = await tx.usage.getForUpdate(scope);

      // Re-read inside the transaction: between the check above and this lock
      // another request may already have deleted it, and decrementing twice for
      // one recording would corrupt the ledger permanently.
      const row = await tx.recordings.get(scope, req.params.id);
      if (!row) return;

      await tx.recordings.softDelete(scope, req.params.id);

      // Soft delete frees quota immediately; the bytes move to a
      // pending-deletion bucket until the 30-day purge drains them
      // (docs/16, Q15). This is ledger MAINTENANCE — the atomic reservation
      // that gates uploads is T-306 and is deliberately not implemented here.
      const size = Number(row.sizeBytes || 0);
      const seconds = Math.round(Number(row.duration || 0));
      // Clamped so a ledger that was never incremented (a recording created
      // before the ledger existed) cannot be driven negative into the CHECK
      // constraints — the counters are non-negative by definition.
      const delta = {
        storageRetainedBytes: -Math.min(size, Number(current.storageRetainedBytes || 0)),
        storagePendingDeletionBytes: size,
        activeVideoCount: -Math.min(1, Number(current.activeVideoCount || 0)),
        recordingSeconds: -Math.min(seconds, Number(current.recordingSeconds || 0)),
      };
      await tx.usage.applyDelta(scope, delta);
    });

    return res.json({ ok: true });
  }));

  router.use(errorHandler(logger));
  return router;
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function mustGet(repos, scope, id) {
  if (!id || typeof id !== 'string') throw badRequest('invalid_request', 'A recording id is required.');
  const recording = await repos.recordings.get(scope, id);
  // Not-found and not-yours are indistinguishable, by design.
  if (!recording) throw notFound('recording_not_found', 'Recording not found.');
  return recording;
}

/** `rec_<sha256(userId:key)>` — stable, and namespaced by user. */
function derivedRecordingId(userId, key) {
  const h = crypto.createHash('sha256').update(`${userId}:${key}`).digest('hex').slice(0, 32);
  return `rec_${h}`;
}

function normaliseTitle(value) {
  if (typeof value !== 'string') throw badRequest('invalid_request', 'title must be a string.');
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_TITLE) {
    throw badRequest('invalid_request', `title must be 1–${MAX_TITLE} characters after trimming.`);
  }
  return trimmed;
}

/** Validate the documented meta field set, enforcing Pro gates as paywalls. */
async function buildMetaPatch(body, { entitlements, repos, scope, recording }) {
  const patch = {};

  if (body.description !== undefined) {
    if (typeof body.description !== 'string' || body.description.length > MAX_DESCRIPTION) {
      throw badRequest('invalid_request', `description must be a string of at most ${MAX_DESCRIPTION} characters.`);
    }
    patch.description = body.description;
  }

  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > MAX_TAGS) {
      throw badRequest('invalid_request', `tags must be an array of at most ${MAX_TAGS} entries.`);
    }
    const tags = body.tags.map((t) => {
      if (typeof t !== 'string' || !t.trim() || t.length > MAX_TAG_LENGTH) {
        throw badRequest('invalid_request', `each tag must be a non-empty string of at most ${MAX_TAG_LENGTH} characters.`);
      }
      return t.trim();
    });
    patch.tags = [...new Set(tags)];
  }

  if (body.privacy !== undefined) {
    if (!PRIVACY.has(body.privacy)) {
      throw badRequest('invalid_request', `privacy must be one of ${[...PRIVACY].join(', ')}.`);
    }
    patch.privacy = body.privacy;
  }

  if (body.folder !== undefined) {
    if (body.folder === null) patch.folderId = null;
    else {
      // Ownership of the DESTINATION matters too: moving a recording into
      // someone else's folder would leak it across accounts.
      const folders = await repos.folders.list(scope);
      if (!folders.some((f) => f.id === body.folder)) {
        throw notFound('folder_not_found', 'Folder not found.');
      }
      patch.folderId = body.folder;
    }
  }

  if (body.archived !== undefined) {
    if (typeof body.archived !== 'boolean') throw badRequest('invalid_request', 'archived must be a boolean.');
    patch.archived = body.archived;
  }

  for (const key of ['trimStart', 'trimEnd', 'recommendedSpeed']) {
    if (body[key] === undefined) continue;
    if (body[key] === null) { patch[key] = null; continue; }
    if (!Number.isFinite(body[key]) || body[key] < 0) {
      throw badRequest('invalid_request', `${key} must be a non-negative number or null.`);
    }
    patch[key] = body[key];
  }
  if (patch.trimStart != null && patch.trimEnd != null && patch.trimEnd <= patch.trimStart) {
    throw badRequest('invalid_request', 'trimEnd must be greater than trimStart.');
  }

  if (body.segments !== undefined) {
    if (body.segments !== null && !Array.isArray(body.segments)) {
      throw badRequest('invalid_request', 'segments must be an array or null.');
    }
    patch.segments = body.segments;
  }
  if (body.audience !== undefined) {
    if (body.audience === null || typeof body.audience !== 'object' || Array.isArray(body.audience)) {
      throw badRequest('invalid_request', 'audience must be an object.');
    }
    patch.audience = body.audience;
  }
  if (body.cta !== undefined) {
    if (body.cta !== null && (typeof body.cta !== 'object' || Array.isArray(body.cta))) {
      throw badRequest('invalid_request', 'cta must be an object or null.');
    }
    patch.cta = body.cta;
  }
  if (body.animatedThumbnail !== undefined) {
    if (typeof body.animatedThumbnail !== 'boolean') {
      throw badRequest('invalid_request', 'animatedThumbnail must be a boolean.');
    }
    patch.animatedThumbnail = body.animatedThumbnail;
  }

  // ── Pro-gated fields. A locked feature is a PAYWALL (403 feature_locked),
  // never a silent drop: silently ignoring the field would tell the user their
  // password was set when it was not.
  for (const [field, feature] of Object.entries(GATED_FIELDS)) {
    if (body[field] === undefined) continue;
    const enabled = await entitlements.isFeatureEnabled(feature, { repos, scope, recording });
    if (!enabled) {
      throw forbidden('feature_locked', `${feature} is not available on your plan.`,
        { upgradeRequired: true, meta: { feature } });
    }
    if (field === 'password') {
      if (body.password === null) patch.passwordHash = null;
      else {
        if (typeof body.password !== 'string' || body.password.length < 4) {
          throw badRequest('invalid_request', 'password must be at least 4 characters, or null to clear it.');
        }
        // Hashed here so the plaintext never reaches the database or a log.
        patch.passwordHash = crypto.createHash('sha256').update(body.password).digest('hex');
        patch.privacy = 'password';
      }
    } else {
      if (typeof body[field] !== 'boolean') {
        throw badRequest('invalid_request', `${field} must be a boolean.`);
      }
      patch[field] = body[field];
    }
  }

  return patch;
}

/** docs/08 §4 RecordingSummary. Never exposes a storage key or a password hash. */
function summary(r) {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    duration: numOrNull(r.duration),
    size_bytes: r.sizeBytes ?? null,
    created_at: r.createdAt,
    privacy: r.privacy,
    folder_id: r.folderId ?? null,
    archived: r.archived,
    tags: r.tags ?? [],
    ai_status: r.aiStatus ?? null,
    // Populated once the thumbnail/poster assets and the watch payload land
    // (T-802); null is the honest answer until then rather than a guessed URL.
    thumbnailUrl: null,
    posterUrl: null,
    views: r.viewCount ?? 0,
    commentCount: r.commentCount ?? 0,
  };
}

const metaBody = (r) => ({
  description: r.description, tags: r.tags ?? [], privacy: r.privacy,
  folder: r.folderId ?? null, archived: r.archived,
  trimStart: numOrNull(r.trimStart), trimEnd: numOrNull(r.trimEnd),
  segments: r.segments ?? null, audience: r.audience ?? {}, cta: r.cta ?? null,
  recommendedSpeed: numOrNull(r.recommendedSpeed),
  animatedThumbnail: r.animatedThumbnail,
  removeBranding: r.removeBranding ?? false,
  // passwordHash is deliberately absent: whether a password is set is
  // reportable, the hash is not.
  passwordProtected: !!r.passwordHash,
});

const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/**
 * Default entitlements.
 *
 * Pro features are OFF until billing integration supplies a real checker, and
 * recording creation is unrestricted because docs/08 §4 makes the check here
 * advisory — the authoritative gate is T-306's reservation at upload-session
 * creation. Being permissive here cannot over-admit anything: a row costs
 * nothing, and no bytes can be stored without passing that gate.
 */
function defaultEntitlements() {
  return {
    async canCreateRecording() { return { allowed: true }; },
    async isFeatureEnabled() { return false; },
  };
}

module.exports = {
  createRecordingsRouter, defaultEntitlements,
  derivedRecordingId, normaliseTitle, buildMetaPatch, summary,
  MAX_TITLE, MAX_PAGE, PRIVACY, SOURCE_KINDS,
};
