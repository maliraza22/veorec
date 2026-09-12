// /api/v1/auth — sessions-based authentication on PostgreSQL (T-1302, docs/08 §2, docs/17 §1–2).
//
//   POST /auth/signup      {name,email,password} → 201 {token,user}  pw ≥ 8, bcrypt cost 12, rate-limited
//   POST /auth/login       {email,password}      → {token,user}      generic 401 on bad credentials
//   POST /auth/google      {credential}          → {token,user}      server-side tokeninfo (aud + email_verified)
//   POST /auth/logout      ⚿                     → {ok}              revokes THIS session
//   GET  /auth/me          ⚿                     → user              publicUser shape (+ entitlements from PostgreSQL)
//   PATCH /auth/profile    ⚿ {name?,email?,slackWebhook?} → user    email uniqueness 409
//   PATCH /auth/password   ⚿ {currentPassword,newPassword} → {ok}   revokes every OTHER session
//   POST /auth/forgot      {email}               → {ok} always      token HASH stored, 1 h, e-mail via the injected sender
//   POST /auth/reset       {email,token,password}→ {token,user}      single-use; revokes ALL sessions, issues a fresh one
//   GET  /auth/config                            → {googleClientId,emailEnabled,path:'v1'}
//   GET  /auth/sessions    ⚿                     → {items:[…], current}
//   DELETE /auth/sessions/:id ⚿                  → {ok}              revoke another device
//
// Tokens are opaque `vs_…` session tokens (api/src/sessions.js); the legacy
// JWT keeps working everywhere through the requireAuth bridge in server/auth.js.
// BRIDGE COMPAT during the migration window: the legacy routes read `req.userId`
// as the LEGACY id, so every account the v1 router creates also exists in the
// legacy store (the injected `accounts` adapter) and PostgreSQL ids stay
// `usr_<legacyId>` — one identity, two stores, until Phase 14.
'use strict';

const crypto = require('crypto');
const express = require('express');
const { errorHandler, badRequest, notFound, conflict, ApiError } = require('./errors');
// errors.unauthorized() carries a fixed code; auth answers name their reason.
const unauthorized = (code, message) => new ApiError(401, code, message);
const { createRateLimiter, ipOf } = require('./rate-limit');
const { issueSession, resolveSession, hashToken, isSessionToken } = require('./sessions');
const { resolveEntitlement, summaryBody } = require('./entitlements');

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const REASON = 'T-1302 auth: session-based sign-in on PostgreSQL';
const MIN_PASSWORD = 8;
const RESET_TTL_MS = 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLACK_RE = /^https:\/\/hooks\.slack\.com\/services\//;
const DEFAULT_LIMITS = {
  login: { max: 10, windowMs: 15 * 60 * 1000 },
  signup: { max: 15, windowMs: 60 * 60 * 1000 },
  forgot: { max: 5, windowMs: 60 * 60 * 1000 },
  reset: { max: 10, windowMs: 15 * 60 * 1000 },
};

const normEmail = (e) => String(e || '').trim().toLowerCase();

/**
 * @param {object} deps
 * @param {() => object} deps.repositories
 * @param {Function} deps.withTransaction
 * @param {Function} deps.requireAuth                 the server's bridge-aware requireAuth (sets req.userId = legacy id, req.pgUserId, req.sessionId)
 * @param {{ hash(pw): Promise<string>, verify(pw, hash): Promise<boolean> }} deps.passwords   bcrypt cost 12 in the server
 * @param {object} deps.accounts                       the legacy-store adapter during the migration window:
 *        create({name,email,passwordHash,googleId}) → legacyId; update(legacyId, fields); isAdmin(email)
 *        (absent → PostgreSQL only: ids are minted here and req.userId is the PostgreSQL id)
 * @param {(legacyId) => string} [deps.pgIdFor]        canonical mapping (idFor('usr', id))
 * @param {(pgId) => string} [deps.legacyIdFor]        the inverse (strip `usr_`)
 * @param {object} [deps.plans]                        the plan catalog (entitlements in the user body)
 * @param {(to, subject, html) => Promise<boolean>} [deps.sendEmail]
 * @param {(credential) => Promise<{email, sub, name, aud, email_verified}|null>} [deps.googleVerify]
 * @param {string|null} [deps.googleClientId]
 * @param {string} [deps.clientUrl]
 * @param {object} [deps.rateLimits]  per-route overrides {login, signup, forgot, reset}
 * @param {object|null} [deps.rateStore]
 * @param {() => number} [deps.now]
 */
function createAuthRouter({ repositories, withTransaction, requireAuth, passwords, accounts = null, pgIdFor = (id) => `usr_${id}`, legacyIdFor = (id) => String(id).replace(/^usr_/, ''), plans = null, sendEmail = null, googleVerify = null, googleClientId = null, clientUrl = 'https://veorec.com', rateLimits = {}, rateStore = null, now = () => Date.now(), logger = console }) {
  if (!passwords || typeof passwords.hash !== 'function' || typeof passwords.verify !== 'function') throw new Error('createAuthRouter: passwords.hash/verify are required');
  const limits = { ...DEFAULT_LIMITS, ...rateLimits };
  const lim = (k) => createRateLimiter({ ...limits[k], keyOf: ipOf, name: 'rate_limited', scope: `auth_${k}`, store: rateStore, policy: 'closed', now, logger });
  const limiter = { login: lim('login'), signup: lim('signup'), forgot: lim('forgot'), reset: lim('reset') };
  const router = express.Router();
  router.use('/auth', express.json({ limit: '64kb' }));

  /** The public user body (the legacy publicUser shape, entitlements from PostgreSQL). */
  async function userBody(repos, user) {
    const legacyId = legacyIdFor(user.id);
    const subscription = plans ? await repos.subscriptions.getForUser({ userId: user.id }) : null;
    const ent = plans ? summaryBody(resolveEntitlement({ user, subscription, plans, now: now() }), plans) : null;
    return {
      id: legacyId, pgId: user.id,
      name: user.name, email: user.email,
      plan: ent ? ent.planSlug : undefined,
      entitlements: ent,
      isAdmin: !!user.isAdmin || !!(accounts && typeof accounts.isAdmin === 'function' && accounts.isAdmin(user.email)),
      hasSlack: !!user.slackWebhook,
      hasPassword: user.hasPassword !== false,
      created_at: user.createdAt ? new Date(user.createdAt).getTime() : null,
    };
  }

  /** Ensure the PostgreSQL row for a (possibly just-created) legacy account exists; returns the public row. */
  async function ensurePgUser(repos, { legacyId, name, email, passwordHash = null, googleId = null }) {
    const id = pgIdFor(legacyId);
    const existing = await repos.users.findById(id);
    if (existing) return existing;
    try { return await repos.users.create({ id, name, email, passwordHash, googleId }); }
    catch (e) {
      // The dual-write mirror may have landed first — that row is ours.
      const again = await repos.users.findById(id);
      if (again) return again;
      throw e;
    }
  }

  async function createAccount(repos, { name, email, passwordHash = null, googleId = null }) {
    let legacyId;
    if (accounts && typeof accounts.create === 'function') legacyId = await accounts.create({ name, email, passwordHash, googleId });
    else legacyId = crypto.randomUUID();
    return ensurePgUser(repos, { legacyId, name, email, passwordHash, googleId });
  }

  async function mirrorUpdate(user, fields) {
    if (!accounts || typeof accounts.update !== 'function') return;
    try { await accounts.update(legacyIdFor(user.id), fields); }
    catch (e) { logger.warn({ err: e && e.message, user_id: user.id }, 'T-1302: legacy mirror update failed'); }
  }

  async function signIn(req, res, repos, user, { status = 200 } = {}) {
    const { token, expiresAt } = await issueSession(repos, { userId: user.id, client: req.get('x-veorec-client') === 'extension' ? 'extension' : 'web', userAgent: req.get('user-agent') || null, ip: ipOf(req) === 'unknown' ? null : ipOf(req), now: now() });
    res.set('Cache-Control', 'no-store');
    return res.status(status).json({ token, expiresAt: new Date(expiresAt).getTime(), user: await userBody(repos, user) });
  }

  // ── POST /auth/signup ──────────────────────────────────────────────────
  router.post('/auth/signup', limiter.signup.middleware, asyncRoute(async (req, res) => {
    const { name, email, password } = req.body || {};
    const cleanName = typeof name === 'string' ? name.trim().slice(0, 200) : '';
    const cleanEmail = normEmail(email);
    if (!cleanName || !cleanEmail || typeof password !== 'string') throw badRequest('invalid_request', 'Name, email and password are required.');
    if (!EMAIL_RE.test(cleanEmail)) throw badRequest('invalid_request', 'That does not look like an e-mail address.');
    if (password.length < MIN_PASSWORD) throw badRequest('password_too_short', `Password must be at least ${MIN_PASSWORD} characters.`);
    const repos = repositories();
    if (await repos.users.findByEmail(cleanEmail)) throw conflict('email_taken', 'Email already registered');
    if (accounts && typeof accounts.findByEmail === 'function' && accounts.findByEmail(cleanEmail)) throw conflict('email_taken', 'Email already registered');
    const passwordHash = await passwords.hash(password);
    const user = await createAccount(repos, { name: cleanName, email: cleanEmail, passwordHash });
    logger.info({ user_id: user.id }, 'T-1302: account created');
    return signIn(req, res, repos, user, { status: 201 });
  }));

  // ── POST /auth/login ───────────────────────────────────────────────────
  router.post('/auth/login', limiter.login.middleware, asyncRoute(async (req, res) => {
    const { email, password } = req.body || {};
    const cleanEmail = normEmail(email);
    if (!cleanEmail || typeof password !== 'string' || !password) throw badRequest('invalid_request', 'Email and password are required.');
    const repos = repositories();
    const row = await repos.users.findByEmailWithSecrets(cleanEmail);
    // One generic answer for "no such account", "google-only" and "wrong password".
    const okPw = row && row.passwordHash ? await passwords.verify(password, row.passwordHash) : false;
    if (!okPw) throw unauthorized('invalid_credentials', 'Invalid email or password');
    const user = await repos.users.findById(row.id);
    return signIn(req, res, repos, user);
  }));

  // ── POST /auth/google ──────────────────────────────────────────────────
  router.post('/auth/google', limiter.login.middleware, asyncRoute(async (req, res) => {
    const credential = req.body && req.body.credential;
    if (!credential || typeof credential !== 'string') throw badRequest('invalid_request', 'Missing Google credential');
    if (typeof googleVerify !== 'function') throw new ApiError(501, 'google_unconfigured', 'Google sign-in is not available on this server.');
    const info = await googleVerify(credential);
    if (!info || !info.email) throw unauthorized('invalid_google_credential', 'Invalid Google sign-in');
    if (googleClientId && info.aud !== googleClientId) throw unauthorized('invalid_google_credential', 'Google token audience mismatch');
    // tokeninfo answers a STRING ("true"/"false") — guard both forms.
    if (info.email_verified === 'false' || info.email_verified === false) throw unauthorized('invalid_google_credential', 'Google email not verified');
    const cleanEmail = normEmail(info.email);
    const repos = repositories();
    let user = await repos.users.findByEmail(cleanEmail);
    if (!user) user = await createAccount(repos, { name: (info.name && String(info.name).trim().slice(0, 200)) || cleanEmail.split('@')[0], email: cleanEmail, googleId: info.sub || null });
    else if (!user.googleId && info.sub) { user = await repos.users.linkGoogleAccount(user.id, info.sub); await mirrorUpdate(user, { googleId: info.sub }); }
    return signIn(req, res, repos, user);
  }));

  // ── GET /auth/config ───────────────────────────────────────────────────
  router.get('/auth/config', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ googleClientId: googleClientId || null, emailEnabled: typeof sendEmail === 'function', path: 'v1', minPasswordLength: MIN_PASSWORD });
  });

  // ── POST /auth/forgot ──────────────────────────────────────────────────
  router.post('/auth/forgot', limiter.forgot.middleware, asyncRoute(async (req, res) => {
    const cleanEmail = normEmail(req.body && req.body.email);
    const repos = repositories();
    const row = cleanEmail ? await repos.users.findByEmailWithSecrets(cleanEmail) : null;
    // Only password accounts can reset; always answer ok (never reveal who exists).
    if (row && row.passwordHash) {
      const token = crypto.randomBytes(32).toString('hex');
      await repos.users.setResetToken(row.id, { tokenHash: hashToken(token), expiresAt: new Date(now() + RESET_TTL_MS) });
      const link = `${clientUrl}/reset?token=${token}&email=${encodeURIComponent(cleanEmail)}`;
      if (typeof sendEmail === 'function') {
        await sendEmail(cleanEmail, 'Reset your VeoRec password',
          `<div style="font-family:sans-serif"><h2>Reset your password</h2><p>Click the button below to set a new password. This link expires in 1 hour.</p><p><a href="${link}" style="display:inline-block;background:#5b5bf6;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Reset password</a></p><p>If you did not ask for this, ignore this e-mail.</p></div>`).catch(() => false);
      } else logger.warn({ user_id: row.id }, 'T-1302: reset requested but no e-mail sender is configured');
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true });
  }));

  // ── POST /auth/reset ───────────────────────────────────────────────────
  router.post('/auth/reset', limiter.reset.middleware, asyncRoute(async (req, res) => {
    const { email, token, password } = req.body || {};
    const cleanEmail = normEmail(email);
    if (!cleanEmail || typeof token !== 'string' || !token || typeof password !== 'string') throw badRequest('invalid_request', 'Missing fields');
    if (password.length < MIN_PASSWORD) throw badRequest('password_too_short', `Password must be at least ${MIN_PASSWORD} characters.`);
    const repos = repositories();
    const user = await repos.users.findByActiveResetToken(hashToken(token), new Date(now()));
    if (!user || normEmail(user.email) !== cleanEmail) throw badRequest('invalid_reset_token', 'Invalid or expired reset link');
    const passwordHash = await passwords.hash(password);
    const scope = { userId: user.id };
    await withTransaction(async (tx) => {
      await tx.users.setPasswordHash(scope, passwordHash);        // also clears the token: single-use
      await tx.sessions.revokeAllForUser(scope);                   // every existing session dies
    });
    await mirrorUpdate(user, { password: passwordHash, resetToken: null, resetExpires: null });
    return signIn(req, res, repos, await repos.users.findById(user.id));
  }));

  // ── authenticated routes ───────────────────────────────────────────────
  router.use(['/auth/me', '/auth/logout', '/auth/profile', '/auth/password', '/auth/sessions'], requireAuth, asyncRoute(async (req, res, next) => {
    // The bridge-aware requireAuth already set req.pgUserId for session tokens; a
    // legacy JWT arrives with only the legacy id.
    if (!req.pgUserId) req.pgUserId = pgIdFor(req.userId);
    const repos = repositories();
    const user = await repos.users.findById(req.pgUserId);
    if (!user) throw new ApiError(503, 'account_not_migrated', 'This account is not on the new stack yet.');
    req.authUser = user;
    next();
  }));

  router.get('/auth/me', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.json(await userBody(repositories(), req.authUser));
  }));

  router.post('/auth/logout', asyncRoute(async (req, res) => {
    const repos = repositories();
    if (req.sessionId) { try { await repos.sessions.revoke({ userId: req.pgUserId }, req.sessionId); } catch { /* already gone */ } }
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, revoked: !!req.sessionId });
  }));

  router.patch('/auth/profile', asyncRoute(async (req, res) => {
    const { name, email, slackWebhook } = req.body || {};
    const fields = {};
    if (typeof name === 'string' && name.trim()) fields.name = name.trim().slice(0, 200);
    if (typeof email === 'string' && email.trim()) {
      const lower = normEmail(email);
      if (!EMAIL_RE.test(lower)) throw badRequest('invalid_request', 'That does not look like an e-mail address.');
      const repos = repositories();
      const existing = await repos.users.findByEmail(lower);
      if (existing && existing.id !== req.pgUserId) throw conflict('email_taken', 'Email already in use');
      if (accounts && typeof accounts.findByEmail === 'function') { const l = accounts.findByEmail(lower); if (l && l.id !== legacyIdFor(req.pgUserId)) throw conflict('email_taken', 'Email already in use'); }
      fields.email = lower;
    }
    if (typeof slackWebhook === 'string') {
      const w = slackWebhook.trim();
      if (w === '') fields.slackWebhook = null;
      else if (SLACK_RE.test(w)) fields.slackWebhook = w.slice(0, 300);
      else throw badRequest('invalid_request', 'That doesn’t look like a Slack incoming-webhook URL (https://hooks.slack.com/services/…).');
    }
    if (!Object.keys(fields).length) throw badRequest('invalid_request', 'Nothing to update');
    const repos = repositories();
    const updated = await repos.users.updateSelf({ userId: req.pgUserId }, fields);
    await mirrorUpdate(updated, fields);
    res.set('Cache-Control', 'no-store');
    return res.json(await userBody(repos, updated));
  }));

  router.patch('/auth/password', asyncRoute(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || !currentPassword || !newPassword) throw badRequest('invalid_request', 'Current and new password required');
    if (newPassword.length < MIN_PASSWORD) throw badRequest('password_too_short', `New password must be at least ${MIN_PASSWORD} characters.`);
    const repos = repositories();
    const row = await repos.users.findByEmailWithSecrets(req.authUser.email);
    if (!row || !row.passwordHash || !(await passwords.verify(currentPassword, row.passwordHash))) throw unauthorized('invalid_credentials', 'Current password is incorrect');
    const passwordHash = await passwords.hash(newPassword);
    const scope = { userId: req.pgUserId };
    const revoked = await withTransaction(async (tx) => {
      await tx.users.setPasswordHash(scope, passwordHash);
      return tx.sessions.revokeAllForUser(scope, { exceptSessionId: req.sessionId || null });
    });
    await mirrorUpdate(req.authUser, { password: passwordHash });
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, success: true, revokedSessions: revoked });
  }));

  router.get('/auth/sessions', asyncRoute(async (req, res) => {
    const rows = await repositories().sessions.listForUser({ userId: req.pgUserId });
    res.set('Cache-Control', 'no-store');
    return res.json({
      current: req.sessionId || null,
      items: rows.map((s) => ({ id: s.id, client: s.client, userAgent: s.userAgent, ip: s.ip || null, createdAt: s.createdAt ? new Date(s.createdAt).getTime() : null, lastUsedAt: s.lastUsedAt ? new Date(s.lastUsedAt).getTime() : null, expiresAt: s.expiresAt ? new Date(s.expiresAt).getTime() : null, current: s.id === req.sessionId })),
    });
  }));

  router.delete('/auth/sessions/:id', asyncRoute(async (req, res) => {
    try { await repositories().sessions.revoke({ userId: req.pgUserId }, req.params.id); }
    catch (e) { if (e && e.name === 'NotFoundError') throw notFound('session_not_found', 'Session not found'); throw e; }
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true });
  }));

  router.use(errorHandler(logger));
  return router;
}

/**
 * The server's requireAuth bridge for session tokens: resolve `vs_…` bearers
 * to `{ legacyUserId, pgUserId, sessionId }` (null = not a live session).
 */
function createSessionResolver({ repositories, legacyIdFor = (id) => String(id).replace(/^usr_/, ''), now = () => Date.now() }) {
  return async function resolve(token) {
    if (!isSessionToken(token)) return null;
    const row = await resolveSession(repositories(), token, { now: now() });
    if (!row) return null;
    return { legacyUserId: legacyIdFor(row.userId), pgUserId: row.userId, sessionId: row.id };
  };
}

module.exports = { createAuthRouter, createSessionResolver, MIN_PASSWORD, RESET_TTL_MS, DEFAULT_LIMITS };
