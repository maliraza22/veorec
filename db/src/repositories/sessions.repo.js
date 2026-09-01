// Auth sessions — revocable, opaque-token sessions (docs/17 §2).
// Only the sha256 hash of a token is ever stored or matched.
'use strict';

const { and, eq, isNull, gt, ne, lt, or } = require('drizzle-orm');
const { sessions } = require('../schema');
const { newId } = require('../ids');
const { exec, NotFoundError } = require('./errors');
const { requireScope, requireSystemReason } = require('./scope');

module.exports = function sessionsRepo(db) {
  return {
    async create({ userId, tokenHash, client, userAgent = null, ip = null, expiresAt }) {
      const [row] = await exec('session', () => db.insert(sessions).values({
        id: newId('session'), userId, tokenHash, client, userAgent, ip, expiresAt,
      }).returning());
      return row;
    },

    /** Authentication lookup: live sessions only (not revoked, not expired). */
    async findActiveByTokenHash(tokenHash, now = new Date()) {
      const [row] = await exec('session', () => db.select().from(sessions)
        .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
        .limit(1));
      return row || null;
    },

    /** Rolling expiry + last-seen bookkeeping. */
    async touch(sessionId, { lastUsedAt = new Date(), expiresAt } = {}) {
      const values = { lastUsedAt };
      if (expiresAt) values.expiresAt = expiresAt;
      const [row] = await exec('session', () => db.update(sessions).set(values)
        .where(eq(sessions.id, sessionId)).returning());
      return row || null;
    },

    async listForUser(scope) {
      const { userId } = requireScope(scope);
      return exec('session', () => db.select().from(sessions)
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt))));
    },

    /** Sign-out. Scoped: a user can only revoke their own sessions. */
    async revoke(scope, sessionId) {
      const { userId } = requireScope(scope);
      const [row] = await exec('session', () => db.update(sessions).set({ revokedAt: new Date() })
        .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
        .returning());
      if (!row) throw new NotFoundError('session');
      return row;
    },

    /** Password change / "sign out everywhere" — optionally keep the current one. */
    async revokeAllForUser(scope, { exceptSessionId = null } = {}) {
      const { userId } = requireScope(scope);
      const where = exceptSessionId
        ? and(eq(sessions.userId, userId), isNull(sessions.revokedAt), ne(sessions.id, exceptSessionId))
        : and(eq(sessions.userId, userId), isNull(sessions.revokedAt));
      const rows = await exec('session', () => db.update(sessions).set({ revokedAt: new Date() })
        .where(where).returning({ id: sessions.id }));
      return rows.length;
    },

    /** Maintenance job: drop expired/revoked rows (docs/10 §3 cleanup). */
    async deleteExpiredSystem(reason, now = new Date()) {
      requireSystemReason(reason);
      const rows = await exec('session', () => db.delete(sessions)
        .where(or(lt(sessions.expiresAt, now), lt(sessions.revokedAt, now)))
        .returning({ id: sessions.id }));
      return rows.length;
    },
  };
};
