// Upload sessions, parts and quota reservations (docs/07 §3/§9, docs/06).
//
// Data access only. The upload PROTOCOL (presigning, part PUTs, completion) is
// T-301, and the atomic quota algorithm is T-306 — this layer provides the rows
// and the transactional primitives those tasks compose, so neither will need to
// reach around the repository layer.
'use strict';

const { and, eq, lt, inArray, sql } = require('drizzle-orm');
const { uploadSessions, uploadParts, storageReservations } = require('../schema');
const { newId } = require('../ids');
const { exec, NotFoundError } = require('./errors');
const { requireScope, requireSystemReason } = require('./scope');

const OPEN_SESSION_STATUSES = ['pending', 'active'];

module.exports = function uploadsRepo(db) {
  const ownedSession = (userId, extra) => and(eq(uploadSessions.userId, userId), extra);

  return {
    /**
     * Create an upload session. `byteCeiling` is the server-computed hard cap
     * for this recording (docs/16 §4.3a) — callers pass a value they derived
     * from the plan and the user's remaining quota; this layer stores it.
     */
    async createSession(scope, data) {
      const { userId } = requireScope(scope);
      const [row] = await exec('upload_session', () => db.insert(uploadSessions).values({
        id: data.id || newId('uploadSession'),
        recordingId: data.recordingId,
        userId,
        storageKey: data.storageKey,
        storageUploadId: data.storageUploadId ?? null,
        mode: data.mode || 'multipart',
        partSize: data.partSize,
        byteCeiling: data.byteCeiling,
        clientMime: data.clientMime ?? null,
        idempotencyKey: data.idempotencyKey,
        expiresAt: data.expiresAt,
      }).returning());
      return row;
    },

    async getSession(scope, id) {
      const { userId } = requireScope(scope);
      const [row] = await exec('upload_session', () => db.select().from(uploadSessions)
        .where(ownedSession(userId, eq(uploadSessions.id, id))).limit(1));
      return row || null;
    },

    /** Idempotent creation support: same key ⇒ same session (docs/06 §3). */
    async findByIdempotencyKey(scope, idempotencyKey) {
      const { userId } = requireScope(scope);
      const [row] = await exec('upload_session', () => db.select().from(uploadSessions)
        .where(ownedSession(userId, eq(uploadSessions.idempotencyKey, idempotencyKey))).limit(1));
      return row || null;
    },

    async findOpenForRecording(scope, recordingId) {
      const { userId } = requireScope(scope);
      const [row] = await exec('upload_session', () => db.select().from(uploadSessions)
        .where(ownedSession(userId, and(
          eq(uploadSessions.recordingId, recordingId),
          inArray(uploadSessions.status, OPEN_SESSION_STATUSES),
        ))).limit(1));
      return row || null;
    },

    async setSessionStatus(scope, id, status, { completedAt, storageUploadId } = {}) {
      const { userId } = requireScope(scope);
      const values = { status };
      if (completedAt !== undefined) values.completedAt = completedAt;
      if (storageUploadId !== undefined) values.storageUploadId = storageUploadId;
      const [row] = await exec('upload_session', () => db.update(uploadSessions).set(values)
        .where(ownedSession(userId, eq(uploadSessions.id, id))).returning());
      if (!row) throw new NotFoundError('upload_session');
      return row;
    },

    // ── Parts ───────────────────────────────────────────────────────────────
    /** Idempotent: re-recording the same part number updates it in place. */
    async recordPart(scope, sessionId, { partNumber, size, etag = null, crc32c = null, status = 'uploaded' }) {
      const session = await this.getSession(scope, sessionId);
      if (!session) throw new NotFoundError('upload_session');
      const [row] = await exec('upload_part', () => db.insert(uploadParts).values({
        uploadSessionId: sessionId, partNumber, size, etag, crc32c, status,
        uploadedAt: status === 'uploaded' ? new Date() : null,
      }).onConflictDoUpdate({
        target: [uploadParts.uploadSessionId, uploadParts.partNumber],
        set: { size, etag, crc32c, status, uploadedAt: new Date() },
      }).returning());
      return row;
    },

    async listParts(scope, sessionId) {
      const session = await this.getSession(scope, sessionId);
      if (!session) throw new NotFoundError('upload_session');
      return exec('upload_part', () => db.select().from(uploadParts)
        .where(eq(uploadParts.uploadSessionId, sessionId)).orderBy(uploadParts.partNumber));
    },

    async sumPartBytes(scope, sessionId) {
      const parts = await this.listParts(scope, sessionId);
      return parts.filter((p) => p.status === 'uploaded').reduce((n, p) => n + Number(p.size || 0), 0);
    },

    // ── Reservations (rows only; the guarded UPDATE lives in usage repo) ─────
    async createReservation(scope, data) {
      const { userId } = requireScope(scope);
      const [row] = await exec('storage_reservation', () => db.insert(storageReservations).values({
        id: data.id || newId('reservation'),
        userId,
        uploadSessionId: data.uploadSessionId ?? null,
        renderJobId: data.renderJobId ?? null,
        reservedBytes: data.reservedBytes,
        reservedSlots: data.reservedSlots ?? 1,
        expiresAt: data.expiresAt,
      }).returning());
      return row;
    },

    async findReservationBySession(scope, uploadSessionId) {
      const { userId } = requireScope(scope);
      const [row] = await exec('storage_reservation', () => db.select().from(storageReservations)
        .where(and(eq(storageReservations.userId, userId),
          eq(storageReservations.uploadSessionId, uploadSessionId))).limit(1));
      return row || null;
    },

    /** T-1202: the copy render's reservation (docs/16 §4.3 — the same mechanism as an upload). */
    async findReservationByRenderJob(scope, renderJobId) {
      const { userId } = requireScope(scope);
      const [row] = await exec('storage_reservation', () => db.select().from(storageReservations)
        .where(and(eq(storageReservations.userId, userId),
          eq(storageReservations.renderJobId, renderJobId))).limit(1));
      return row || null;
    },

    /** Terminal transition: 'reconciled' | 'released' | 'expired'. */
    async settleReservation(scope, id, status, { reconciledBytes = null } = {}) {
      const { userId } = requireScope(scope);
      const [row] = await exec('storage_reservation', () => db.update(storageReservations)
        .set({ status, reconciledBytes })
        .where(and(eq(storageReservations.id, id), eq(storageReservations.userId, userId),
          eq(storageReservations.status, 'held')))
        .returning());
      if (!row) throw new NotFoundError('storage_reservation');
      return row;
    },

    // ── Maintenance (upload_expiry job, docs/10 §3) ──────────────────────────
    async listExpiredSessionsSystem({ before = new Date(), limit = 100 } = {}, reason) {
      requireSystemReason(reason);
      return exec('upload_session', () => db.select().from(uploadSessions)
        .where(and(inArray(uploadSessions.status, OPEN_SESSION_STATUSES), lt(uploadSessions.expiresAt, before)))
        .limit(limit));
    },

    async listHeldReservationsSystem({ before = new Date(), limit = 100 } = {}, reason) {
      requireSystemReason(reason);
      return exec('storage_reservation', () => db.select().from(storageReservations)
        .where(and(eq(storageReservations.status, 'held'), lt(storageReservations.expiresAt, before)))
        .limit(limit));
    },

    async expireSessionSystem(id, reason) {
      requireSystemReason(reason);
      const [row] = await exec('upload_session', () => db.update(uploadSessions)
        .set({ status: 'expired' })
        .where(and(eq(uploadSessions.id, id), inArray(uploadSessions.status, OPEN_SESSION_STATUSES)))
        .returning());
      return row || null;
    },

    async settleReservationSystem(id, status, reason, { reconciledBytes = null } = {}) {
      requireSystemReason(reason);
      const [row] = await exec('storage_reservation', () => db.update(storageReservations)
        .set({ status, reconciledBytes })
        .where(and(eq(storageReservations.id, id), eq(storageReservations.status, 'held')))
        .returning());
      return row || null;
    },
  };
};
