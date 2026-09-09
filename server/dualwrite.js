// ─────────────────────────────────────────────────────────────────────────────
// POSTGRESQL DUAL-WRITE MIRROR (T-105)
//
// THE LEGACY APPLICATION REMAINS AUTHORITATIVE. This module mirrors successful
// legacy mutations into PostgreSQL as a SECONDARY write. PostgreSQL is not read
// by the application, and a mirror failure can never change a legacy response.
//
//   legacy operation ──► JSON / Cloudinary   (authoritative, unchanged)
//                    └─► PostgreSQL mirror   (secondary, best-effort, journaled)
//
// SAFETY PROPERTIES
//   • Disabled by default. Without PG_DUAL_WRITE=true this module loads no
//     database code, opens no pool, and every mirror call is a no-op.
//   • Never throws into a request path — mirrors run AFTER the response and all
//     errors are contained here.
//   • Ordered: mirrors run through a single FIFO lane, so they apply in the
//     same causal order as the legacy writes that produced them (a user exists
//     before their folder; a recording before its comments). Running them
//     concurrently would race foreign keys under normal request timing.
//   • Bounded: the lane holds at most MAX_QUEUED pending mirrors. Overflow is
//     journaled for reconciliation rather than queued in memory, so nothing is
//     lost on a restart and memory cannot grow without limit.
//   • Durable failures: every failed/skipped mirror is appended to
//     dual-write-failures.jsonl (DATA_DIR) — the reconciliation input. That
//     file works even when PostgreSQL is the thing that is down.
//   • Idempotent: writes use the deterministic legacy→PG id mapping shared with
//     the T-104 importer, so a retry or a later reconcile converges instead of
//     duplicating.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const ENABLED = process.env.PG_DUAL_WRITE === 'true';   // absent/anything else ⇒ OFF
const MAX_QUEUED = Number(process.env.PG_DUAL_WRITE_MAX_QUEUED || 500);
const TIMEOUT_MS = Number(process.env.PG_DUAL_WRITE_TIMEOUT_MS || 5000);
const DATA_DIR = process.env.DATA_DIR || __dirname;
const JOURNAL = path.join(DATA_DIR, 'dual-write-failures.jsonl');

let logger = console;
let counters = null;   // set by index.js so failures appear in KPI snapshots

// Lazily-loaded database bindings — only touched when the flag is on.
let dbMod = null;
let mirrors = null;
let client = null;
let initError = null;

function init() {
  if (dbMod || initError) return !initError;
  try {
    dbMod = require('../db/src');
    mirrors = require('../db/src/migration/mirrors');
    client = dbMod.createClient(dbMod.getPool());
    logger.info({ dualWrite: true }, 'pg dual-write ENABLED (PostgreSQL is a mirror; legacy remains authoritative)');
    return true;
  } catch (err) {
    initError = err;
    logger.error({ err }, 'pg dual-write could not initialise — continuing legacy-only');
    return false;
  }
}

// Single-lane FIFO: preserves the legacy write order, which the foreign keys
// depend on. Depth is bounded; overflow goes to the journal, never to memory.
const queue = [];
let draining = false;
let inflight = 0;

// Circuit breaker. When PostgreSQL is down, every mirror would otherwise sit
// through its timeout in a serial lane and back the queue up. After
// CIRCUIT_THRESHOLD consecutive failures the circuit opens: mirrors are
// journaled immediately (still fully reconcilable) until a probe succeeds.
const CIRCUIT_THRESHOLD = Number(process.env.PG_DUAL_WRITE_CIRCUIT_THRESHOLD || 3);
const CIRCUIT_COOLDOWN_MS = Number(process.env.PG_DUAL_WRITE_CIRCUIT_COOLDOWN_MS || 30000);
let consecutiveFailures = 0;
let circuitOpenedAt = 0;

const circuitOpen = () => circuitOpenedAt > 0 && (Date.now() - circuitOpenedAt) < CIRCUIT_COOLDOWN_MS;

function noteResult(success) {
  if (success) {
    if (circuitOpenedAt) logger.info({}, 'dual-write circuit closed — mirroring resumed');
    consecutiveFailures = 0;
    circuitOpenedAt = 0;
    return;
  }
  consecutiveFailures++;
  if (consecutiveFailures >= CIRCUIT_THRESHOLD && !circuitOpen()) {
    circuitOpenedAt = Date.now();
    logger.error({ consecutiveFailures, cooldownMs: CIRCUIT_COOLDOWN_MS },
      'dual-write circuit OPEN — mirrors journaled for reconciliation until PostgreSQL recovers');
  }
}

async function drainQueue() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const task = queue.shift();
      inflight = 1;
      await task();
      inflight = 0;
    }
  } finally {
    draining = false;
    inflight = 0;
  }
}

/** Append a durable record of a mirror that did not happen. */
function journal(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
  try {
    fs.appendFileSync(JOURNAL, line);
  } catch (err) {
    // Last resort: the log still carries everything needed to reconcile.
    logger.error({ err, entry }, 'dual-write: could not append to the failure journal');
  }
}

/** Classify an error so the journal/metrics distinguish transient from terminal. */
function classify(err) {
  // Walk the wrapper chain: drizzle wraps driver errors, so the SQLSTATE and
  // the constraint NAME (never values) sit on `cause`.
  let pg = err, depth = 0;
  while (pg && depth++ < 5 && !(typeof pg.code === 'string' && /^[0-9A-Z]{5}$/.test(pg.code))) pg = pg.cause;
  const constraint = (pg && pg.constraint) || null;
  const code = (pg && pg.code) || (err && err.code);
  const retryable = !!(err && err.retryable)
    || ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', '08006', '08003', '57P01', '40001', '40P01'].includes(code)
    || /timeout/i.test(String(err && err.message));
  return { code: String(code || 'unknown'), constraint, retryable };
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`dual-write timeout after ${ms}ms (${label})`)), ms); }),
  ]);
}

/**
 * Run one mirror operation. Never throws, never blocks the caller's response.
 * @param {string} op        e.g. 'user.upsert'
 * @param {object} ctx       { entity, legacyId, requestId }
 * @param {(m, db) => Promise} fn  the mirror body
 */
function mirror(op, ctx, fn) {
  if (!ENABLED) return;
  if (!init()) {
    journal({ op, ...ctx, reason: 'init_failed', retryable: true });
    if (counters) counters.dualWriteFailure++;
    return;
  }
  if (queue.length >= MAX_QUEUED) {
    // Shed load rather than growing an unbounded in-memory queue: the journal
    // makes the skipped record reconcilable.
    journal({ op, ...ctx, reason: 'overloaded', retryable: true });
    if (counters) { counters.dualWriteAttempt++; counters.dualWriteFailure++; counters.dualWriteRetryable++; }
    (logger.warn ? logger : console).warn({ op, ...ctx, queued: queue.length },
      'dual-write skipped: mirror queue is full');
    return;
  }

  if (counters) counters.dualWriteAttempt++;

  if (circuitOpen()) {
    // Fail fast: the database is known-down. Journaling immediately keeps the
    // record reconcilable without stalling the lane on a timeout.
    journal({ op, ...ctx, reason: 'circuit_open', retryable: true });
    if (counters) { counters.dualWriteFailure++; counters.dualWriteRetryable++; }
    return;
  }

  queue.push(async () => {
    const startedAt = Date.now();
    try {
      await withTimeout(Promise.resolve().then(() => fn(mirrors, client)), TIMEOUT_MS, op);
      if (counters) counters.dualWriteSuccess++;
      noteResult(true);
      logger.debug({ op, ...ctx, durationMs: Date.now() - startedAt }, 'dual-write ok');
    } catch (err) {
      const { code, constraint, retryable } = classify(err);
      noteResult(false);
      if (counters) { counters.dualWriteFailure++; if (retryable) counters.dualWriteRetryable++; }
      // Structured, reconcilable, and free of secrets/bodies/tokens.
      logger.error({
        op, entity: ctx.entity, legacyId: ctx.legacyId, pgId: ctx.pgId ?? null,
        request_id: ctx.requestId ?? null, errorCode: code, constraint, retryable,
        durationMs: Date.now() - startedAt,
        err: { message: String(err && err.message).slice(0, 300) },
      }, 'dual-write FAILED — legacy write already succeeded; mirror needs reconciliation');
      journal({ op, ...ctx, reason: 'error', errorCode: code, constraint, retryable,
        message: String(err && err.message).slice(0, 300) });
    }
  });
  drainQueue();
}

/** Wire the shared logger + KPI counters (called once from index.js). */
function configure({ logger: log, counters: c } = {}) {
  if (log) logger = log;
  if (c) counters = c;
  return module.exports;
}

// ── Mirror API — one function per legacy mutation ────────────────────────────
// Each takes the legacy record that was JUST written successfully.

const { idFor } = ENABLED ? require('../db/src/legacy-ids') : { idFor: (p, id) => `${p}_${id}` };

const api = {
  user(legacyUser, ctx = {}) {
    mirror('user.upsert', { entity: 'users', legacyId: legacyUser && legacyUser.id, pgId: legacyUser && idFor('usr', legacyUser.id), ...ctx },
      (m, db) => m.upsertUser(db, legacyUser));
  },

  folder(legacyFolder, ctx = {}) {
    mirror('folder.upsert', { entity: 'folders', legacyId: legacyFolder && legacyFolder.id, ...ctx },
      (m, db) => m.upsertFolder(db, legacyFolder, idFor('usr', legacyFolder.userId)));
  },

  folderDeleted(legacyFolderId, legacyUserId, ctx = {}) {
    mirror('folder.delete', { entity: 'folders', legacyId: legacyFolderId, ...ctx },
      (m, db) => m.deleteFolder(db, legacyFolderId, idFor('usr', legacyUserId)));
  },

  /** A new recording (upload completed in the legacy path). */
  recording(rec, meta = {}, ctx = {}) {
    mirror('recording.upsert', { entity: 'recordings', legacyId: rec.legacyId, pgId: idFor('rec', rec.legacyId), ...ctx },
      async (m, db) => {
        await m.upsertRecording(db, { ...rec, ownerId: idFor('usr', rec.legacyUserId) }, meta);
        if (rec.media) await m.upsertMediaMap(db, idFor('rec', rec.legacyId), rec.media);
      });
  },

  /** Owner metadata change (title / privacy / folder / audience / trims …). */
  /**
   * Record a mirrored SOURCE asset for a recording (T-203).
   *
   * Deliberately on THIS lane, not a separate path: video_assets has a foreign
   * key to recordings, and the parent row is written by recording() above. The
   * single FIFO lane is what guarantees the parent lands first — concurrent
   * mirrors racing an FK is a defect this lane already had to fix once.
   *
   * Idempotent: the storage key is deterministic, so a replayed mirror
   * converges on the existing row instead of violating the unique index.
   */
  recordingAsset(legacyRecordingId, asset, ctx = {}) {
    const recordingId = idFor('rec', legacyRecordingId);
    mirror('recording_asset.upsert',
      { entity: 'video_asset', legacyId: legacyRecordingId, pgId: recordingId, ...ctx },
      async (m, db) => {
        const { createRepositories } = require('../db/src');
        const repos = createRepositories(db);
        await repos.assets.upsertSourceSystem({
          recordingId,
          kind: 'source',
          storageKey: asset.storageKey,
          status: 'ready',
          sizeBytes: asset.sizeBytes ?? null,
          width: asset.width ?? null,
          height: asset.height ?? null,
          duration: asset.duration ?? null,
          container: asset.container ?? null,
        }, 'T-203 upload mirror: records the R2 object copied after a successful legacy upload');
      });
  },

  recordingMeta(legacyRecordingId, legacyUserId, meta, extra = {}, ctx = {}) {
    mirror('recording.meta', { entity: 'recordings', legacyId: legacyRecordingId, pgId: idFor('rec', legacyRecordingId), ...ctx },
      (m, db) => m.upsertRecording(db, {
        legacyId: legacyRecordingId,
        ownerId: idFor('usr', legacyUserId),
        folderId: meta && meta.folder ? idFor('fld', meta.folder) : null,
        ...extra,
      }, meta || {}));
  },

  comment(legacyRecordingId, comment, ctx = {}) {
    mirror('comment.insert', { entity: 'comments', legacyId: comment && comment.id, ...ctx },
      (m, db) => m.upsertComment(db, idFor('rec', legacyRecordingId), comment));
  },

  reaction(legacyRecordingId, reaction, ctx = {}) {
    mirror('reaction.insert', { entity: 'reactions', legacyId: legacyRecordingId, ...ctx },
      (m, db) => m.upsertReaction(db, idFor('rec', legacyRecordingId), reaction));
  },

  view(legacyRecordingId, viewerKey, extra = {}, ctx = {}) {
    mirror('view.upsert', { entity: 'view_sessions', legacyId: legacyRecordingId, ...ctx },
      (m, db) => m.upsertViewSession(db, idFor('rec', legacyRecordingId), viewerKey, extra));
  },

  lead(legacyRecordingId, lead, ctx = {}) {
    mirror('lead.upsert', { entity: 'leads', legacyId: legacyRecordingId, ...ctx },
      (m, db) => m.upsertLead(db, idFor('rec', legacyRecordingId), lead));
  },

  /** Mirrored SNAPSHOT of the legacy counters — never a quota enforcement input. */
  usage(legacyUserId, usageRecord, ctx = {}) {
    mirror('usage.upsert', { entity: 'usage', legacyId: legacyUserId, ...ctx },
      (m, db) => m.upsertUsage(db, idFor('usr', legacyUserId), usageRecord));
  },

  subscription(legacyUserId, sub, ctx = {}) {
    mirror('subscription.upsert', { entity: 'subscriptions', legacyId: legacyUserId, ...ctx },
      (m, db) => m.upsertSubscription(db, idFor('usr', legacyUserId), sub, legacyUserId));
  },

  contact(contact, ctx = {}) {
    mirror('contact.insert', { entity: 'contacts', legacyId: contact && contact.id, ...ctx },
      (m, db) => m.upsertContact(db, contact, contact.userId ? idFor('usr', contact.userId) : null));
  },

  notificationRead(legacyUserId, at, ctx = {}) {
    mirror('notification_read.upsert', { entity: 'notification_reads', legacyId: legacyUserId, ...ctx },
      (m, db) => m.upsertNotificationRead(db, idFor('usr', legacyUserId), at));
  },
};

/** Wait for in-flight mirrors (tests and graceful shutdown only). */
async function drain(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while ((queue.length > 0 || inflight > 0) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  return queue.length === 0 && inflight === 0;
}

module.exports = Object.assign(api, {
  enabled: ENABLED,
  configure,
  drain,
  journalPath: JOURNAL,
  _stats: () => ({ queued: queue.length, inflight, enabled: ENABLED }),
});
