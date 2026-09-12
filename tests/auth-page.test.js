// T-1302 auth gate + client data layer + bridge (run: cd server && npm run test:auth-page)
//
// A. The auth gate (V1_AUTH) on the PUBLIC config, its KPI. B. server/auth.js:
//    the requireAuth bridge speaks both a legacy JWT and a v1 session token
//    (byte-identical JWT behaviour without a resolver). C. The client data
//    layer (client/src/lib/authApi.mjs) in node with a scripted fetch: gate
//    reading, v1 vs legacy routing, error shapes, logout only revokes a v1
//    token. D. Source wiring: the sign-in pages use the data layer (no page
//    builds an /api/auth URL), AuthContext revokes on logout, the server mounts
//    the router with bcrypt 12 and the legacy-store adapter. E. A spawned
//    legacy server with V1_AUTH=true: signup on v1 → the token works on a
//    LEGACY route and on a v1 route; logout kills it; the legacy login still
//    works; the KPI line.
//
// The spawned-server section SKIPS LOUDLY without PostgreSQL;
// AUTH_PAGE_TESTS_REQUIRED=1 makes a skip a failure.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'server');
const CLIENT_DIR = path.join(ROOT, 'client');
const rollout = require(path.join(SERVER_DIR, 'rollout.js'));
const { createKpi } = require(path.join(SERVER_DIR, 'kpi.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.AUTH_PAGE_TESTS_REQUIRED === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Math.random().toString(36).slice(2, 8);

(async () => {
  console.log('T-1302 auth page tests');

  console.log('\nA. The auth gate (V1_AUTH) on the public config');
  const on = { V1_UPLOAD_API: 'true', V1_AUTH: 'true' };
  ok(rollout.authEnabled(on) === true && rollout.decideAuth({ env: on }).path === 'v1' && rollout.decideAuth({ env: on }).decision === 'auth_v1_enabled', 'exact "true" + v1 API on → v1');
  for (const bad of ['TRUE', '1', 'yes', ' true', '', undefined]) ok(rollout.decideAuth({ env: { V1_UPLOAD_API: 'true', V1_AUTH: bad } }).path === 'legacy', `V1_AUTH=${JSON.stringify(bad)} → legacy`);
  ok(rollout.decideAuth({ env: { V1_AUTH: 'true' } }).path === 'legacy', 'never opens while the v1 API is off');
  const pub = rollout.publicConfigBody(rollout.decideWatch({ env: {} }), rollout.decideAuth({ env: on }));
  ok(pub.auth.path === 'v1' && pub.auth.v1Enabled === true && pub.watch.path === 'legacy' && !('library' in pub) && !('editor' in pub), 'the public config carries the auth block, independent of the watch gate, and nothing per-user');
  ok(rollout.publicConfigBody().auth.path === 'legacy' && !('auth' in rollout.clientConfigBody({ path: 'legacy' })), 'omitted → legacy; the AUTHED config does not carry the auth gate (visitors read the public one)');
  const lines = [];
  const kpi = createKpi({ info: (o) => lines.push(o), warn() {}, error() {}, child() { return this; } });
  kpi.authDecision({}, rollout.decideAuth({ env: on })); kpi.authDecision({}, rollout.decideAuth({ env: {} }));
  ok(kpi._counters.authV1Selected === 1 && kpi._counters.authLegacySelected === 1 && lines.some((o) => o.kpi === 'auth_decision' && o.auth_path === 'v1'), 'KPI counters and the auth_decision line');
  kpi.snapshot(); const snap = lines.find((l) => l.kpi === 'kpi_snapshot');
  ok(snap && snap.cutover && snap.cutover.auth && snap.cutover.auth.v1Selected === 1, 'the snapshot carries the auth gate');
  kpi._stop();

  console.log('\nB. server/auth.js: the requireAuth bridge');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 't1302-jwt-secret-0123456789';
  const auth = require(path.join(SERVER_DIR, 'auth.js'));
  const run = (token) => new Promise((resolve) => {
    const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
    const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ status: this.code, body: b, req }); } };
    auth.requireAuth(req, res, () => resolve({ status: 200, req }));
  });
  const jwt = auth.signToken('legacy-user-1');
  auth.configureSessionAuth({});
  ok((await run(jwt)).req.userId === 'legacy-user-1' && (await run('vs_' + 'a'.repeat(43))).status === 401 && (await run()).status === 401, 'without a resolver: a JWT passes, a session token is just an invalid bearer (legacy behaviour)');
  auth.configureSessionAuth({ resolve: async (t) => (t === 'vs_' + 'a'.repeat(43) ? { legacyUserId: 'legacy-user-2', pgUserId: 'usr_legacy-user-2', sessionId: 'ses_1' } : null) });
  const s = await run('vs_' + 'a'.repeat(43));
  ok(s.status === 200 && s.req.userId === 'legacy-user-2' && s.req.pgUserId === 'usr_legacy-user-2' && s.req.sessionId === 'ses_1' && s.req.authKind === 'session', 'with a resolver: a session token sets the LEGACY id on req.userId plus the PostgreSQL id and session');
  ok((await run('vs_' + 'b'.repeat(43))).status === 401 && (await run(jwt)).req.userId === 'legacy-user-1' && (await run('not-a-token')).status === 401, 'an unknown session is 401; the JWT path is untouched');
  auth.configureSessionAuth({ resolve: async () => { throw new Error('db down'); } });
  ok((await run('vs_' + 'c'.repeat(43))).status === 401, 'a resolver failure is a 401, never a crash');
  auth.configureSessionAuth({});

  console.log('\nC. Client data layer (authApi.mjs)');
  const L = await import(`file:///${path.join(CLIENT_DIR, 'src', 'lib', 'authApi.mjs').replace(/\\/g, '/')}`);
  ok(L.authIsV1({ auth: { path: 'v1' } }) && !L.authIsV1({ auth: { v1Enabled: true } }) && !L.authIsV1(null), 'only an explicit auth.path === "v1" counts');
  ok(L.isSessionToken('vs_abc') && !L.isSessionToken('eyJ.jwt') && !L.isSessionToken(null), 'session tokens are recognised by prefix');
  ok(L.errorOf({ error: { code: 'invalid_credentials', message: 'Invalid email or password' } }).error === 'Invalid email or password' && L.errorOf({ error: 'Legacy text' }).error === 'Legacy text' && L.errorOf(null, 'fb').error === 'fb', 'nested v1 and legacy string errors → one shape');
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: (init.method || 'GET'), body: init.body ? JSON.parse(init.body) : null, auth: init.headers && init.headers.Authorization });
    if (/client-config\/public/.test(url)) return { ok: true, json: async () => ({ auth: { path: 'v1' } }) };
    if (/\/login$/.test(url)) return { ok: false, status: 401, json: async () => ({ error: { code: 'invalid_credentials', message: 'nope' } }) };
    if (/\/logout$/.test(url)) return { ok: true, status: 200, json: async () => ({ ok: true, revoked: true }) };
    return { ok: true, status: 200, json: async () => ({ token: 'vs_' + 'x'.repeat(43), user: { id: 'u' } }) };
  };
  ok(L.authIsV1(await L.fetchAuthConfig({ API: 'http://api', fetchImpl })), 'the gate is read from the public config');
  const v1 = L.createAuthClient({ API: 'http://api', useV1: true, fetchImpl });
  const su = await v1.signup({ name: 'A', email: 'a@x', password: 'longenough' });
  ok(su.token && calls.some((c) => c.url === 'http://api/api/v1/auth/signup' && c.method === 'POST' && c.body.password === 'longenough'), 'v1: signup posts to /api/v1/auth/signup');
  const li = await v1.login({ email: 'a@x', password: 'bad' });
  ok(li.error === 'nope' && li.code === 'invalid_credentials' && li.status === 401, 'v1: a refusal is data with the code');
  ok((await v1.logout('vs_' + 'x'.repeat(43))).revoked === true && calls.some((c) => /\/api\/v1\/auth\/logout$/.test(c.url) && c.auth === 'Bearer vs_' + 'x'.repeat(43)), 'v1: logout revokes the session with the bearer');
  ok((await v1.logout('eyJ.legacy.jwt')).revoked === false && !calls.some((c) => c.auth === 'Bearer eyJ.legacy.jwt'), 'a legacy JWT is never sent to the v1 logout');
  calls.length = 0;
  const legacy = L.createAuthClient({ API: 'http://api', useV1: false, fetchImpl });
  await legacy.signup({ name: 'A', email: 'a@x', password: 'p' }); await legacy.forgot('a@x'); await legacy.google('cred'); await legacy.config();
  ok(calls.every((c) => c.url.startsWith('http://api/api/auth/')) && (await legacy.logout('vs_' + 'x'.repeat(43))).revoked === false, 'legacy: every call goes to /api/auth/* and logout is client-side only');

  console.log('\nD. Wiring');
  const read = (p) => fs.readFileSync(path.join(CLIENT_DIR, 'src', p), 'utf8');
  const pages = { Login: read('pages/Login.jsx'), Signup: read('pages/Signup.jsx'), Forgot: read('pages/Forgot.jsx'), Reset: read('pages/Reset.jsx'), GoogleButton: read('components/GoogleButton.jsx') };
  for (const [name, src] of Object.entries(pages)) ok(/useAuthClient\(\)/.test(src) && !/`\$\{API\}\/api\/auth\//.test(src), `${name} uses the auth data layer and builds no /api/auth URL`);
  ok(/authClient\.login\(form\)/.test(pages.Login) && /authClient\.signup\(form\)/.test(pages.Signup) && /authClient\.forgot\(email\)/.test(pages.Forgot) && /authClient\.reset\(\{ email, token, password \}\)/.test(pages.Reset) && /authClient\.google\(resp\.credential\)/.test(pages.GoogleButton), 'each page calls the matching method');
  const ctx = read('AuthContext.jsx');
  ok(/isSessionToken\(token\)\) createAuthClient\(\{ API, useV1: true \}\)\.logout\(token\)/.test(ctx) && /localStorage\.removeItem\('sr_token'\)/.test(ctx), 'AuthContext revokes a v1 session on logout and still clears the stored token');
  const hook = read('hooks/useAuthClient.js');
  ok(/fetchAuthConfig\(\{ API \}\)/.test(hook) && /createAuthClient\(\{ API, useV1: !!useV1 \}\)/.test(hook), 'the hook binds to the public decision once per page load');
  const server = fs.readFileSync(path.join(SERVER_DIR, 'index.js'), 'utf8');
  ok(/configureSessionAuth\(\{ resolve: createSessionResolver\(\{ repositories \}\) \}\)/.test(server) && /passwords: \{ hash: \(pw\) => bcrypt\.hash\(pw, 12\)/.test(server) && /users\.create\(user\);\s*return user\.id;/.test(server) && /kpi\.authDecision\(req, auth\)/.test(server), 'the server installs the session bridge, mounts the router with bcrypt 12 and the legacy-store adapter, and reports the gate');
  const authSrc = fs.readFileSync(path.join(SERVER_DIR, 'auth.js'), 'utf8');
  ok(/sessionResolver && isSessionToken\(token\)/.test(authSrc) && /const \{ userId \} = verifyToken\(token\);/.test(authSrc), 'auth.js keeps the JWT path and adds the session path in front of it');
  ok(/# V1_AUTH=false/.test(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8')), '.env.example documents V1_AUTH (off by default)');

  console.log('\nE. Spawned legacy server with V1_AUTH=true');
  let dbUrl = null;
  try { const { loadEnv, createPool } = require(path.join(ROOT, 'db', 'src', 'index.js')); const env = loadEnv({ appEnv: 'test' }); const pool = createPool({ env, max: 1 }); await pool.query('select 1'); dbUrl = env.databaseUrl; await pool.end(); } catch {}
  if (!dbUrl) {
    console.log('  SKIPPED E — PostgreSQL unreachable');
    if (REQUIRED) { fail += 1; console.log('  FAIL: AUTH_PAGE_TESTS_REQUIRED=1 but PostgreSQL is unavailable'); }
  } else {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't1302-'));
    const PORT = String(3360 + Math.floor(Math.random() * 20));
    const child = spawn(process.execPath, ['index.js'], { cwd: SERVER_DIR, env: { ...process.env, PORT, NODE_ENV: 'production', JWT_SECRET: 't1302-jwt-secret-0123456789', DATA_DIR: dataDir, LOG_PRETTY: 'false', SENTRY_DSN: '', V1_UPLOAD_API: 'true', V1_AUTH: 'true', PG_DUAL_WRITE: 'true', APP_ENV: 'test', DATABASE_URL_TEST: dbUrl, STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100', STORAGE_BUCKET: 'veorec-media-test', STORAGE_PROVIDER: 'minio', STORAGE_ACCESS_KEY_ID: 'veorec_dev', STORAGE_SECRET_ACCESS_KEY: 'veorec_local_dev_secret', STORAGE_REGION: 'auto', STORAGE_FORCE_PATH_STYLE: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (d) => { out += d.toString(); }); child.stderr.on('data', (d) => { out += d.toString(); });
    try {
      let ready = false;
      for (let i = 0; i < 60 && !ready; i += 1) { try { ready = (await fetch(`http://127.0.0.1:${PORT}/api/plans`)).ok; } catch {} if (!ready) await sleep(250); }
      ok(ready, 'the legacy server boots with V1_AUTH=true');
      const Lx = `http://127.0.0.1:${PORT}`;
      const pub = await (await fetch(`${Lx}/api/client-config/public`)).json();
      ok(pub.auth && pub.auth.path === 'v1', 'the public config says auth v1');
      const email = `t1302-${RUN}@example.com`;
      const su = await (await fetch(`${Lx}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'T', email, password: 'secret12345' }) })).json();
      ok(su.token && su.token.startsWith('vs_') && su.user && su.user.id && su.user.entitlements && su.user.entitlements.planSlug, 'signup on v1 → a session token and the public user');
      const legacyMe = await fetch(`${Lx}/api/auth/me`, { headers: { authorization: `Bearer ${su.token}` } });
      const legacyBody = await legacyMe.json();
      ok(legacyMe.status === 200 && legacyBody.id === su.user.id && legacyBody.email === email, 'the session token works on a LEGACY route (the bridge: req.userId = the legacy id)');
      const v1Usage = await fetch(`${Lx}/api/v1/me/usage`, { headers: { authorization: `Bearer ${su.token}` } });
      ok(v1Usage.status === 200, 'and on a v1 route (the identity bridge finds the mirrored row)');
      const cfg = await (await fetch(`${Lx}/api/client-config`, { headers: { authorization: `Bearer ${su.token}` } })).json();
      ok(cfg && cfg.upload && cfg.editor, 'the authed client-config answers for a session token');
      const legacyLogin = await (await fetch(`${Lx}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret12345' }) })).json();
      ok(legacyLogin.token && !legacyLogin.token.startsWith('vs_') && legacyLogin.user.id === su.user.id, 'the LEGACY login still works for the same account (one identity, two stores)');
      ok((await fetch(`${Lx}/api/v1/auth/me`, { headers: { authorization: `Bearer ${legacyLogin.token}` } })).status === 200, 'a legacy JWT reaches the v1 auth routes too');
      const lo = await (await fetch(`${Lx}/api/v1/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${su.token}` } })).json();
      ok(lo.revoked === true && (await fetch(`${Lx}/api/auth/me`, { headers: { authorization: `Bearer ${su.token}` } })).status === 401, 'logout revokes the session everywhere — the token is dead on the legacy route as well');
      ok(/"kpi":"auth_decision"/.test(out) && /"decision":"auth_v1_enabled"/.test(out), 'the KPI line is logged');
    } finally { child.kill(); await sleep(300); fs.rmSync(dataDir, { recursive: true, force: true }); }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
