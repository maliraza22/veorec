// Users — the identity root (docs/07 §2).
//
// A user is not "owned" by another user, so lookups take an id/email rather
// than a Scope. Mutations DO take a Scope and enforce `id = scope.userId`, so a
// signed-in user can only ever modify themselves; admin paths are named
// explicitly and require a stated reason.
//
// Secrets (password/reset hashes) are excluded from every default projection —
// only the explicitly named *WithSecrets reads return them, so a hash cannot
// reach a response body by accident.
'use strict';

const { and, eq, isNull, gt, desc, or, ilike, sql } = require('drizzle-orm');
const { users } = require('../schema');
const { newId } = require('../ids');
const { exec, NotFoundError } = require('./errors');
const { requireScope, requireSystemReason } = require('./scope');

const PUBLIC_COLUMNS = {
  id: users.id, email: users.email, name: users.name, isAdmin: users.isAdmin,
  googleId: users.googleId, manualPlan: users.manualPlan, manualPlanExpires: users.manualPlanExpires,
  slackWebhook: users.slackWebhook, paddleCustomerId: users.paddleCustomerId,
  createdAt: users.createdAt, updatedAt: users.updatedAt, deletedAt: users.deletedAt,
  hasPassword: sql`(${users.passwordHash} IS NOT NULL)`.as('has_password'),
};

// Fields a user may change about themselves.
const SELF_UPDATABLE = ['name', 'email', 'slackWebhook'];
// Fields an admin may change about anyone.
const ADMIN_UPDATABLE = [...SELF_UPDATABLE, 'isAdmin', 'manualPlan', 'manualPlanExpires', 'paddleCustomerId'];

const pick = (patch, allowed) => Object.fromEntries(
  Object.entries(patch || {}).filter(([k, v]) => allowed.includes(k) && v !== undefined)
);

module.exports = function usersRepo(db) {
  const liveUser = (extra) => and(isNull(users.deletedAt), extra);

  return {
    async create(data) {
      const row = {
        id: data.id || newId('user'),
        email: data.email,
        name: data.name,
        passwordHash: data.passwordHash ?? null,
        googleId: data.googleId ?? null,
        isAdmin: data.isAdmin ?? false,
      };
      const [created] = await exec('user', () => db.insert(users).values(row).returning(PUBLIC_COLUMNS));
      return created;
    },

    /** Identity lookup (not owned data). Excludes soft-deleted accounts. */
    async findById(id) {
      const [row] = await exec('user', () =>
        db.select(PUBLIC_COLUMNS).from(users).where(liveUser(eq(users.id, id))).limit(1));
      return row || null;
    },

    /** citext column → case-insensitive match without lower() gymnastics. */
    async findByEmail(email) {
      const [row] = await exec('user', () =>
        db.select(PUBLIC_COLUMNS).from(users).where(liveUser(eq(users.email, email))).limit(1));
      return row || null;
    },

    async findByGoogleId(googleId) {
      const [row] = await exec('user', () =>
        db.select(PUBLIC_COLUMNS).from(users).where(liveUser(eq(users.googleId, googleId))).limit(1));
      return row || null;
    },

    /** Sign-in path only — returns the password hash for verification. */
    async findByEmailWithSecrets(email) {
      const [row] = await exec('user', () =>
        db.select().from(users).where(liveUser(eq(users.email, email))).limit(1));
      return row || null;
    },

    /** Password-reset redemption: matches an unexpired token hash. */
    async findByActiveResetToken(tokenHash, now = new Date()) {
      const [row] = await exec('user', () => db.select(PUBLIC_COLUMNS).from(users)
        .where(liveUser(and(eq(users.resetTokenHash, tokenHash), gt(users.resetExpires, now)))).limit(1));
      return row || null;
    },

    /** A user may only update themselves; `scope.userId` IS the target row. */
    async updateSelf(scope, patch) {
      const { userId } = requireScope(scope);
      const values = pick(patch, SELF_UPDATABLE);
      if (Object.keys(values).length === 0) return this.findById(userId);
      const [row] = await exec('user', () => db.update(users).set(values)
        .where(liveUser(eq(users.id, userId))).returning(PUBLIC_COLUMNS));
      if (!row) throw new NotFoundError('user');
      return row;
    },

    async setPasswordHash(scope, passwordHash) {
      const { userId } = requireScope(scope);
      const [row] = await exec('user', () => db.update(users)
        .set({ passwordHash, resetTokenHash: null, resetExpires: null })
        .where(liveUser(eq(users.id, userId))).returning(PUBLIC_COLUMNS));
      if (!row) throw new NotFoundError('user');
      return row;
    },

    /** Unauthenticated flow (forgot-password): keyed by user id, token hashed. */
    async setResetToken(userId, { tokenHash, expiresAt }) {
      const [row] = await exec('user', () => db.update(users)
        .set({ resetTokenHash: tokenHash, resetExpires: expiresAt })
        .where(liveUser(eq(users.id, userId))).returning(PUBLIC_COLUMNS));
      if (!row) throw new NotFoundError('user');
      return row;
    },

    async linkGoogleAccount(userId, googleId) {
      const [row] = await exec('user', () => db.update(users).set({ googleId })
        .where(liveUser(eq(users.id, userId))).returning(PUBLIC_COLUMNS));
      if (!row) throw new NotFoundError('user');
      return row;
    },

    /** Soft delete: frees the email (partial unique index) and hides the row. */
    async softDelete(scope) {
      const { userId } = requireScope(scope);
      const [row] = await exec('user', () => db.update(users).set({ deletedAt: new Date() })
        .where(liveUser(eq(users.id, userId))).returning(PUBLIC_COLUMNS));
      if (!row) throw new NotFoundError('user');
      return row;
    },

    // ── Admin surface — deliberately named, reason required ─────────────────
    async updateAsAdmin(userId, patch, reason) {
      requireSystemReason(reason);
      const values = pick(patch, ADMIN_UPDATABLE);
      if (Object.keys(values).length === 0) return this.findById(userId);
      const [row] = await exec('user', () => db.update(users).set(values)
        .where(liveUser(eq(users.id, userId))).returning(PUBLIC_COLUMNS));
      if (!row) throw new NotFoundError('user');
      return row;
    },

    async listAsAdmin({ q = '', limit = 50 } = {}, reason) {
      requireSystemReason(reason);
      const filter = q
        ? and(isNull(users.deletedAt), or(ilike(users.name, `%${q}%`), ilike(sql`${users.email}::text`, `%${q}%`)))
        : isNull(users.deletedAt);
      return exec('user', () => db.select(PUBLIC_COLUMNS).from(users).where(filter)
        .orderBy(desc(users.createdAt)).limit(Math.min(limit, 200)));
    },
  };
};
