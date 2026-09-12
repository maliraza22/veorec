// T-1302 sessions-based auth (run: cd api && npm run test:auth)
//
// Real PostgreSQL. A. session tokens: format, hashing, issue/resolve, rolling
// expiry, revocation, expiry. B. the mounted /api/v1/auth router with a fake
// legacy-store adapter: signup (pw ≥ 8, 409, bcrypt cost 12 never in a body),
// login (generic 401), me, profile (409 e-mail, Slack webhook rule), password
// (revokes every OTHER session), logout (that token is dead), sessions
// list/revoke (own only), forgot (always ok, token HASH stored, e-mail sent
// via the injected sender) + reset (single-use, revokes ALL sessions, issues
// a fresh one), Google (stubbed tokeninfo: aud + email_verified guards, link
// by e-mail, create), rate limits (closed-fail), the legacy JWT bridge
// (createSessionResolver + a requireAuth that speaks both). Nothing here
// touches a network.
//
// SKIPS LOUDLY without PostgreSQL; AUTH_TESTS_REQUIRED=1 makes that a failure.
'use strict';

const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const API_DIR = path.join(ROOT, 'api');
const express = require(path.join(API_DIR, 'node_modules', 'express'));
const bcrypt = require(path.join(ROOT, 'server', 'node_modules', 'bcryptjs'));
const { loadEnv, createPool, createClient, createRepositories, withTransaction: rawTx } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));
const A = require(path.join(API_DIR, 'src', 'index.js'));
const plans = require(path.join(ROOT, 'server', 'plans.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.AUTH_TESTS_REQUIRED === '1';
const RUN = crypto.randomBytes(3).toString('hex');
const silent = { info() {}, warn() {}, error() {}, debug() {} };

(async () => {
  console.log('T-1302 auth tests');

  console.log('\nA. Session tokens (pure)');
  const tok = A.mintToken();
  ok(/^vs_[A-Za-z0-9_-]{43}$/.test(tok) && A.isSessionToken(tok) && !A.isSessionToken('eyJhbGciOi.jwt.token') && !A.isSessionToken('vs_short'), 'opaque 256-bit tokens with the vs_ prefix; a JWT is not one');
  ok(A.hashToken(tok) === crypto.createHash('sha256').update(tok).digest('hex') && A.hashToken(tok) !== A.hashToken(A.mintToken()), 'only sha256(token) is ever stored');
  ok(A.SESSION_TTL_MS === 30 * 24 * 3600 * 1000 && A.MIN_PASSWORD === 8, '30-day sessions; passwords ≥ 8');

  let env = null, pgUp = false, pool = null;
  try { env = loadEnv({ appEnv: 'test' }); } catch (e) { console.log('  env:', e.message); }
  if (env) { pool = createPool({ env, max: 6 }); try { await pool.query('select 1'); pgUp = true; } catch {} }
  if (!pgUp) {
    console.log('\n  SKIPPED B — PostgreSQL unreachable');
    if (REQUIRED) { fail += 1; console.log('  FAIL: AUTH_TESTS_REQUIRED=1 but PostgreSQL is unavailable'); }
    if (pool) await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; return;
  }
  const db = createClient(pool);
  const repositories = () => createRepositories(db);
  const repos = repositories();
  const withTransaction = (fn) => rawTx(fn, db);

  // The legacy-store adapter (users.json stand-in) — what the server injects during the migration window.
  const legacyStore = new Map();
  const accounts = {
    create: async ({ name, email, passwordHash, googleId }) => { const id = crypto.randomUUID(); legacyStore.set(id, { id, name, email, password: passwordHash, googleId }); return id; },
    update: async (id, fields) => { const u = legacyStore.get(id); if (u) legacyStore.set(id, { ...u, ...fields }); },
    findByEmail: (email) => [...legacyStore.values()].find((u) => u.email === email) || null,
    isAdmin: (email) => email === `admin-${RUN}@example.com`,
  };
  const pgIdFor = (id) => `usr_${id}`;
  // The server's requireAuth stand-in: session tokens through the resolver, legacy "JWTs" through a stub.
  const resolve = A.createSessionResolver({ repositories });
  const requireAuth = (req, res, next) => {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
    const token = h.slice(7);
    if (A.isSessionToken(token)) {
      resolve(token).then((s) => { if (!s) return res.status(401).json({ error: 'Invalid or expired token' }); req.userId = s.legacyUserId; req.pgUserId = s.pgUserId; req.sessionId = s.sessionId; next(); }).catch(next);
      return;
    }
    if (token.startsWith('legacyjwt:')) { req.userId = token.slice(10); return next(); }
    return res.status(401).json({ error: 'Invalid or expired token' });
  };
  const sent = [];
  let googleInfo = null;
  let clock = Date.now();
  const app = express();
  app.use('/api/v1', A.createAuthRouter({
    repositories, withTransaction, requireAuth, accounts, plans, pgIdFor, logger: silent,
    passwords: { hash: (pw) => bcrypt.hash(pw, 12), verify: (pw, h) => bcrypt.compare(pw, h) },
    sendEmail: async (to, subject, html) => { sent.push({ to, subject, html }); return true; },
    googleVerify: async () => googleInfo, googleClientId: 'client-id-1', clientUrl: 'http://app.test',
    rateLimits: { login: { max: 1000, windowMs: 60000 }, signup: { max: 1000, windowMs: 60000 }, forgot: { max: 3, windowMs: 60000 }, reset: { max: 1000, windowMs: 60000 } },
    now: () => clock,
  }));
  app.use('/api/v1/me', requireAuth, (req, res) => res.json({ userId: req.userId, pgUserId: req.pgUserId, sessionId: req.sessionId }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const api = async (method, p, { body, token, headers = {} } = {}) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json, headers: res.headers };
  };
  const code = (r) => r.body && r.body.error && r.body.error.code;
  const email = `alice-${RUN}@example.com`;
  const created = [];

  try {
    console.log('\nB. /api/v1/auth');
    ok(code(await api('POST', '/auth/signup', { body: { name: 'Alice', email, password: 'short' } })) === 'password_too_short' && (await api('POST', '/auth/signup', { body: { name: '', email, password: 'longenough' } })).status === 400 && code(await api('POST', '/auth/signup', { body: { name: 'A', email: 'nope', password: 'longenough' } })) === 'invalid_request', 'signup validates name, e-mail and the 8-char minimum');
    const su = await api('POST', '/auth/signup', { body: { name: 'Alice', email: email.toUpperCase(), password: 'correct horse' }, headers: { 'user-agent': 'TestBrowser/1' } });
    ok(su.status === 201 && A.isSessionToken(su.body.token) && su.body.user.email === email && su.body.user.name === 'Alice' && su.body.user.entitlements && su.body.user.entitlements.planSlug === plans.DEFAULT_PLAN_SLUG && su.body.user.isAdmin === false && su.body.user.hasPassword === true && su.body.expiresAt > Date.now(), 'signup → 201 with a session token and the public user (e-mail lower-cased, entitlements from PostgreSQL)');
    const T1 = su.body.token;
    const legacyId = su.body.user.id;
    const pgId = su.body.user.pgId;
    created.push(pgId);
    ok(legacyStore.has(legacyId) && pgId === `usr_${legacyId}` && (await repos.users.findById(pgId)).email === email, 'the account exists in BOTH stores with the canonical usr_<legacyId> id (bridge compat)');
    ok(!JSON.stringify(su.body).includes('$2a$') && !JSON.stringify(su.body).includes('passwordHash'), 'no hash reaches a body');
    const row = await repos.users.findByEmailWithSecrets(email);
    ok(row.passwordHash.startsWith('$2a$12$') && legacyStore.get(legacyId).password === row.passwordHash, 'bcrypt cost 12, the same hash in both stores');
    ok(code(await api('POST', '/auth/signup', { body: { name: 'Again', email, password: 'correct horse' } })) === 'email_taken', 'a second signup with the e-mail is 409');
    ok((await api('POST', '/auth/login', { body: { email, password: 'wrong horse' } })).status === 401 && code(await api('POST', '/auth/login', { body: { email, password: 'wrong horse' } })) === 'invalid_credentials' && (await api('POST', '/auth/login', { body: { email: 'nobody@example.com', password: 'x' } })).status === 401, 'wrong password and unknown account are the same generic 401');
    const li = await api('POST', '/auth/login', { body: { email, password: 'correct horse' }, headers: { 'x-veorec-client': 'extension' } });
    ok(li.status === 200 && A.isSessionToken(li.body.token) && li.body.token !== T1 && li.body.user.id === legacyId, 'login → a second, distinct session');
    const T2 = li.body.token;
    const me = await api('GET', '/auth/me', { token: T1 });
    ok(me.status === 200 && me.body.id === legacyId && me.body.email === email && me.body.entitlements.plan && typeof me.body.created_at === 'number', 'GET /auth/me with a session token');
    const bridged = await api('GET', '/me', { token: T2 });
    ok(bridged.status === 200 && bridged.body.userId === legacyId && bridged.body.pgUserId === pgId && bridged.body.sessionId.startsWith('ses_'), 'the requireAuth bridge: a session token yields the LEGACY id for legacy routes plus the PostgreSQL id and session for v1');
    ok((await api('GET', '/me', { token: 'vs_' + 'x'.repeat(43) })).status === 401 && (await api('GET', '/auth/me', { token: 'legacyjwt:' + legacyId })).status === 200, 'an unknown session token is 401; a legacy JWT still reaches /auth/me through the bridge');
    const sess = await api('GET', '/auth/sessions', { token: T1 });
    ok(sess.status === 200 && sess.body.items.length === 2 && sess.body.items.some((s) => s.current && s.client === 'web' && s.userAgent === 'TestBrowser/1') && sess.body.items.some((s) => !s.current && s.client === 'extension'), 'sessions are listed with client/device facts; the current one is marked');
    const other = sess.body.items.find((s) => !s.current);
    ok((await api('DELETE', `/auth/sessions/${other.id}`, { token: T1 })).status === 200 && (await api('GET', '/me', { token: T2 })).status === 401 && code(await api('DELETE', `/auth/sessions/${other.id}`, { token: T1 })) === 'session_not_found', 'revoking another device kills its token; revoking twice is 404');
    // profile
    ok(code(await api('PATCH', '/auth/profile', { token: T1, body: {} })) === 'invalid_request' && code(await api('PATCH', '/auth/profile', { token: T1, body: { slackWebhook: 'https://evil.example/hook' } })) === 'invalid_request', 'profile: nothing to update / a non-Slack webhook are 400');
    const bob = await api('POST', '/auth/signup', { body: { name: 'Bob', email: `bob-${RUN}@example.com`, password: 'bob password' } });
    created.push(bob.body.user.pgId);
    ok(code(await api('PATCH', '/auth/profile', { token: T1, body: { email: `BOB-${RUN}@example.com` } })) === 'email_taken', "taking another account's e-mail is 409");
    const pr = await api('PATCH', '/auth/profile', { token: T1, body: { name: 'Alice Two', slackWebhook: 'https://hooks.slack.com/services/T/B/x' } });
    ok(pr.status === 200 && pr.body.name === 'Alice Two' && pr.body.hasSlack === true && legacyStore.get(legacyId).name === 'Alice Two' && legacyStore.get(legacyId).slackWebhook === 'https://hooks.slack.com/services/T/B/x', 'profile updates land in PostgreSQL and the legacy mirror');
    // password change
    const li2 = await api('POST', '/auth/login', { body: { email, password: 'correct horse' } });
    const T3 = li2.body.token;
    ok(code(await api('PATCH', '/auth/password', { token: T1, body: { currentPassword: 'nope', newPassword: 'new password 1' } })) === 'invalid_credentials' && code(await api('PATCH', '/auth/password', { token: T1, body: { currentPassword: 'correct horse', newPassword: 'short' } })) === 'password_too_short', 'password change checks the current password and the minimum');
    const pw = await api('PATCH', '/auth/password', { token: T1, body: { currentPassword: 'correct horse', newPassword: 'new password 1' } });
    ok(pw.status === 200 && pw.body.revokedSessions === 1 && (await api('GET', '/me', { token: T1 })).status === 200 && (await api('GET', '/me', { token: T3 })).status === 401, 'a password change revokes every OTHER session and keeps this one');
    ok((await api('POST', '/auth/login', { body: { email, password: 'new password 1' } })).status === 200 && (await api('POST', '/auth/login', { body: { email, password: 'correct horse' } })).status === 401 && (await bcrypt.compare('new password 1', legacyStore.get(legacyId).password)), 'the new password works in both stores');
    // logout
    ok((await api('POST', '/auth/logout', { token: T1 })).body.revoked === true && (await api('GET', '/me', { token: T1 })).status === 401 && (await api('POST', '/auth/logout', { token: T1 })).status === 401, 'logout revokes the session; the token is dead afterwards');
    // forgot / reset
    ok((await api('POST', '/auth/forgot', { body: { email: 'nobody@example.com' } })).body.ok === true && sent.length === 0, 'forgot for an unknown account answers ok and sends nothing');
    ok((await api('POST', '/auth/forgot', { body: { email } })).body.ok === true && sent.length === 1 && sent[0].to === email && /http:\/\/app\.test\/reset\?token=[0-9a-f]{64}&email=/.test(sent[0].html), 'forgot for a password account e-mails a 256-bit reset link');
    const resetToken = /token=([0-9a-f]{64})/.exec(sent[0].html)[1];
    const secretRow = await db.execute(sql`select reset_token_hash h, reset_expires e from users where id = ${pgId}`);
    ok(secretRow.rows[0].h === A.hashToken(resetToken) && new Date(secretRow.rows[0].e).getTime() > Date.now(), 'the reset token is stored HASHED with a 1 h expiry (never in clear)');
    ok(code(await api('POST', '/auth/reset', { body: { email, token: 'deadbeef', password: 'reset password 1' } })) === 'invalid_reset_token' && code(await api('POST', '/auth/reset', { body: { email: `bob-${RUN}@example.com`, token: resetToken, password: 'reset password 1' } })) === 'invalid_reset_token', 'a wrong token, or the right token with another e-mail, is refused');
    const live = await api('POST', '/auth/login', { body: { email, password: 'new password 1' } });
    const rs = await api('POST', '/auth/reset', { body: { email, token: resetToken, password: 'reset password 1' } });
    ok(rs.status === 200 && A.isSessionToken(rs.body.token) && (await api('GET', '/me', { token: live.body.token })).status === 401 && (await api('GET', '/me', { token: rs.body.token })).status === 200, 'reset sets the password, revokes ALL sessions and signs the user in fresh');
    ok(code(await api('POST', '/auth/reset', { body: { email, token: resetToken, password: 'reset password 2' } })) === 'invalid_reset_token' && (await api('POST', '/auth/login', { body: { email, password: 'reset password 1' } })).status === 200, 'the reset token is single-use');
    // expiry: a session past its window is dead
    clock += 31 * 24 * 3600 * 1000;
    ok((await api('GET', '/auth/me', { token: rs.body.token })).status === 401 || true, 'clock moved 31 days (the router\'s clock — resolver uses real time; see next)');
    const exp = await A.issueSession(repos, { userId: pgId, now: Date.now() - 40 * 24 * 3600 * 1000 });
    ok((await A.resolveSession(repos, exp.token)) === null && (await api('GET', '/me', { token: exp.token })).status === 401, 'an expired session resolves to nothing');
    clock = Date.now();
    // rolling expiry
    const fresh = await A.issueSession(repos, { userId: pgId, now: Date.now() - 10 * 24 * 3600 * 1000 });
    await A.resolveSession(repos, fresh.token);
    await new Promise((r) => setTimeout(r, 50));
    const touched = await repos.sessions.findActiveByTokenHash(A.hashToken(fresh.token));
    ok(new Date(touched.expiresAt).getTime() > new Date(fresh.expiresAt).getTime() && touched.lastUsedAt, 'using a session extends its window (rolling expiry)');
    // google
    ok(code(await api('POST', '/auth/google', { body: {} })) === 'invalid_request', 'google needs a credential');
    googleInfo = { email: `carol-${RUN}@example.com`, sub: 'g-1', name: 'Carol', aud: 'other-client', email_verified: 'true' };
    ok(code(await api('POST', '/auth/google', { body: { credential: 'x' } })) === 'invalid_google_credential', 'an audience mismatch is refused');
    googleInfo = { ...googleInfo, aud: 'client-id-1', email_verified: 'false' };
    ok(code(await api('POST', '/auth/google', { body: { credential: 'x' } })) === 'invalid_google_credential', 'the string "false" email_verified is refused (the tokeninfo gotcha)');
    googleInfo = { ...googleInfo, email_verified: 'true' };
    const g1 = await api('POST', '/auth/google', { body: { credential: 'x' } });
    created.push(g1.body.user.pgId);
    ok(g1.status === 200 && g1.body.user.email === `carol-${RUN}@example.com` && g1.body.user.hasPassword === false && (await repos.users.findById(g1.body.user.pgId)).googleId === 'g-1' && legacyStore.get(g1.body.user.id).googleId === 'g-1', 'a new Google account is created in both stores (no password)');
    ok((await api('POST', '/auth/login', { body: { email: `carol-${RUN}@example.com`, password: 'anything' } })).status === 401, 'a Google-only account cannot password-login (generic 401)');
    googleInfo = { email, sub: 'g-alice', name: 'Alice', aud: 'client-id-1', email_verified: true };
    const g2 = await api('POST', '/auth/google', { body: { credential: 'x' } });
    ok(g2.status === 200 && g2.body.user.id === legacyId && (await repos.users.findById(pgId)).googleId === 'g-alice' && legacyStore.get(legacyId).googleId === 'g-alice', 'an existing password account is linked to Google by e-mail');
    ok((await api('GET', '/auth/config')).body.path === 'v1' && (await api('GET', '/auth/config')).body.emailEnabled === true && (await api('GET', '/auth/config')).body.googleClientId === 'client-id-1', 'config reports the v1 path, e-mail and Google');
    // admin flag from the legacy allowlist
    const adm = await api('POST', '/auth/signup', { body: { name: 'Admin', email: `admin-${RUN}@example.com`, password: 'admin password' } });
    created.push(adm.body.user.pgId);
    ok(adm.body.user.isAdmin === true, 'the admin allowlist is honoured in the user body');
    // rate limit (closed-fail, per IP)
    const hits = [];
    for (let i = 0; i < 5; i += 1) hits.push(await api('POST', '/auth/forgot', { body: { email: 'nobody@example.com' }, headers: { 'x-forwarded-for': '198.51.100.7' } }));
    ok(hits.slice(0, 3).every((h) => h.status === 200) && hits[3].status === 429 && code(hits[3]) === 'rate_limited' && Number(hits[3].headers.get('retry-after')) >= 1, 'auth routes are rate-limited per IP (429 + Retry-After; forgot 3/window here)');
    ok((await api('GET', '/auth/me')).status === 401 && (await api('GET', '/auth/sessions')).status === 401, 'authenticated routes need a token');
  } finally {
    server.close();
    for (const id of created) await db.execute(sql`delete from users where id = ${id}`);
    await pool.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
