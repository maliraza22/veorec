// T-901 /api/v1 sharing (run: cd api && npm run test:sharing)
//
// Real PostgreSQL. Managed share links (create with the token shown once, list
// without it, revoke idempotently, owner matrix, validation, the Pro gate on
// link passwords) proven end-to-end against the T-801 watch router (a link
// opens a login-only recording, a revoked one is link_expired, a link password
// unlocks), and the Slack share against a local fake webhook.
//
// SKIPS LOUDLY without PostgreSQL; SHARING_TESTS_REQUIRED=1 makes that a failure.
'use strict';

const path = require('path');
const crypto = require('crypto');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const API_DIR = path.join(ROOT, 'api');
const express = require(path.join(API_DIR, 'node_modules', 'express'));
const { loadEnv, createPool, createClient, createRepositories } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));
const storagePkg = require(path.join(ROOT, 'storage', 'src', 'index.js'));
const { createSharingRouter, createWatchRouter } = require(path.join(API_DIR, 'src', 'index.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.SHARING_TESTS_REQUIRED === '1';
const RUN = crypto.randomBytes(3).toString('hex');
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

(async () => {
  console.log('T-901 sharing endpoint tests');
  let env = null, pgUp = false, pool = null;
  try { env = loadEnv({ appEnv: 'test' }); } catch (e) { console.log('  env:', e.message); }
  if (env) { pool = createPool({ env, max: 6 }); try { await pool.query('select 1'); pgUp = true; } catch {} }
  if (!pgUp) {
    console.log('\n  SKIPPED — PostgreSQL unreachable');
    if (REQUIRED) { fail += 1; console.log('  FAIL: SHARING_TESTS_REQUIRED=1 but PostgreSQL is unavailable'); }
    if (pool) await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; return;
  }
  const db = createClient(pool);
  const repositories = () => createRepositories(db);
  const repos = repositories();
  const legacy = { alice: `a${RUN}`, bob: `b${RUN}` };
  const pg = (u) => `usr_${legacy[u]}`;
  for (const u of ['alice', 'bob']) await db.execute(sql`INSERT INTO users (id,email,name,password_hash) VALUES (${pg(u)}, ${`${u}-t901-${RUN}@example.com`}, ${u}, 'x')`);
  const rid = (k) => `rec_t901_${k}_${RUN}`;
  const mkRec = async (k, owner = 'alice', privacy = 'login') => { await db.execute(sql`INSERT INTO recordings (id,user_id,title,status,source_kind,privacy) VALUES (${rid(k)}, ${pg(owner)}, ${`Share ${k}`}, 'ready', 'extension', ${privacy})`); return rid(k); };

  // A fake Slack webhook that records what it receives and answers as told.
  const slackHits = [];
  let slackStatus = 200;
  const hook = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { slackHits.push({ url: req.url, body: JSON.parse(b || '{}') }); res.writeHead(slackStatus); res.end(); }); });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const hookBase = `http://127.0.0.1:${hook.address().port}`;
  // The router insists on hooks.slack.com; the fake rewrites that host.
  const slack = { async post(url, body) { const r = await fetch(url.replace('https://hooks.slack.com', hookBase), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { ok: r.ok, status: r.status }; } };

  let currentUser = null, features = { passwordProtection: true, slackEnabled: true };
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => { if (!currentUser) return res.status(401).json({ error: { code: 'unauthorized', message: 'no' } }); req.userId = currentUser; req.id = 'req_test'; next(); };
  app.use('/api/v1', createSharingRouter({ repositories, requireAuth, entitlements: { isFeatureEnabled: async (f) => !!features[f] }, slack, clientBase: 'https://app.example.test/', logger: silent }));
  app.use('/api/v1', createWatchRouter({ repositories, storage: { async getSignedDownloadUrl(k) { return `signed://${k}`; }, async getObjectBuffer() { throw Object.assign(new Error('nf'), { code: 'object_not_found' }); } }, keys: storagePkg.keys, accessSecret: 'sharing-test-secret-0123456789', logger: silent, viewer: async (req) => (req.get('x-viewer') ? { id: pg(req.get('x-viewer')) } : null) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const api = async (method, p, { as, body, headers = {} } = {}) => {
    if (as !== undefined) currentUser = as;
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const code = (r) => r.body && r.body.error && r.body.error.code;

  try {
    console.log('\nA. Create / list / revoke with the owner matrix');
    const A = await mkRec('a');
    ok((await api('GET', `/recordings/${A}/share-links`, { as: null })).status === 401, 'unauthenticated → 401');
    ok((await api('GET', `/recordings/${A}/share-links`, { as: legacy.bob })).status === 404 && (await api('POST', `/recordings/${A}/share-links`, { as: legacy.bob, body: {} })).status === 404, 'another user\'s recording → 404 (indistinguishable from missing)');
    const empty = await api('GET', `/recordings/${A}/share-links`, { as: legacy.alice });
    ok(empty.status === 200 && empty.body.items.length === 0 && empty.body.url === `https://app.example.test/watch/${A}`, 'the owner lists (empty) and gets the plain watch URL');
    const c1 = await api('POST', `/recordings/${A}/share-links`, { as: legacy.alice, body: { label: '  sent to client X  ' } });
    ok(c1.status === 201 && c1.body.id.startsWith('shl_') && c1.body.label === 'sent to client X' && typeof c1.body.token === 'string' && c1.body.token.length >= 22 && c1.body.url === `https://app.example.test/watch/${A}?s=${encodeURIComponent(c1.body.token)}` && c1.body.hasPassword === false, 'POST → 201 with the token shown once and the ?s= URL');
    const rows = await repos.shareLinks.list({ userId: pg('alice') }, A);
    ok(rows.length === 1 && rows[0].tokenHash === sha256(c1.body.token) && !JSON.stringify(rows[0]).includes(c1.body.token), 'only the token HASH is stored');
    const listed = await api('GET', `/recordings/${A}/share-links`, { as: legacy.alice });
    ok(listed.body.items.length === 1 && !('token' in listed.body.items[0]) && !('tokenHash' in listed.body.items[0]) && listed.body.items[0].viewCount === 0, 'the list never re-shows the token or its hash');
    ok(code(await api('POST', `/recordings/${A}/share-links`, { as: legacy.alice, body: { expiresAt: 'yesterday' } })) === 'invalid_request' && code(await api('POST', `/recordings/${A}/share-links`, { as: legacy.alice, body: { expiresAt: new Date(Date.now() - 1000).toISOString() } })) === 'invalid_request', 'expiresAt must be a future ISO timestamp');
    ok(code(await api('POST', `/recordings/${A}/share-links`, { as: legacy.alice, body: { maxViews: 0 } })) === 'invalid_request' && code(await api('POST', `/recordings/${A}/share-links`, { as: legacy.alice, body: { maxViews: 1.5 } })) === 'invalid_request' && code(await api('POST', `/recordings/${A}/share-links`, { as: legacy.alice, body: { label: 5 } })) === 'invalid_request', 'maxViews must be a positive integer; label a string');
    ok(code(await api('POST', `/recordings/${A}/share-links`, { as: legacy.alice, body: { password: 'abc' } })) === 'invalid_request', 'a link password needs 4+ characters');
    features.passwordProtection = false;
    const gated = await api('POST', `/recordings/${A}/share-links`, { as: legacy.alice, body: { password: 'secret' } });
    ok(gated.status === 403 && code(gated) === 'feature_locked' && gated.body.error.upgradeRequired === true, 'a link password is a Pro paywall (403 feature_locked + upgradeRequired), never silently dropped');
    features.passwordProtection = true;
    const c2 = await api('POST', `/recordings/${A}/share-links`, { as: legacy.alice, body: { password: 'secret', maxViews: 2, expiresAt: new Date(Date.now() + 3600000).toISOString() } });
    ok(c2.status === 201 && c2.body.hasPassword === true && c2.body.maxViews === 2 && c2.body.expiresAt, 'a protected, capped, expiring link');
    ok((await api('DELETE', `/share-links/${c1.body.id}`, { as: legacy.bob })).status === 404, 'a non-owner cannot revoke (404)');
    const rv = await api('DELETE', `/share-links/${c1.body.id}`, { as: legacy.alice });
    ok(rv.status === 200 && rv.body.revoked === true && rv.body.revokedAt && (await api('DELETE', `/share-links/${c1.body.id}`, { as: legacy.alice })).status === 200, 'the owner revokes; a repeat is idempotent');
    ok((await api('DELETE', '/share-links/shl_nope', { as: legacy.alice })).status === 404, 'an unknown link → 404');

    console.log('\nB. The links against the watch router (T-801 resolution)');
    ok((await api('GET', `/watch/${A}`, { as: null })).status === 401, 'the recording is login-only: anonymous → 401');
    ok(code(await api('GET', `/watch/${A}?s=${c1.body.token}`)) === 'link_expired', 'the revoked link is dead (403 link_expired)');
    const c3 = await api('POST', `/recordings/${A}/share-links`, { as: legacy.alice, body: { label: 'live' } });
    const viaLink = await api('GET', `/watch/${A}?s=${c3.body.token}`, { as: null });
    ok(viaLink.status === 200 && viaLink.body.viewer.via === 'share', 'a live link opens the login-only recording anonymously');
    ok((await api('GET', `/recordings/${A}/share-links`, { as: legacy.alice })).body.items.find((l) => l.id === c3.body.id).viewCount === 1, 'the owner sees the view count move');
    const gate = await api('GET', `/watch/${A}?s=${c2.body.token}`, { as: null });
    ok(gate.status === 200 && gate.body.requiresPassword === true, 'the protected link gates on its own password');
    const un = await api('POST', `/watch/${A}/unlock?s=${c2.body.token}`, { as: null, body: { password: 'secret' } });
    ok(un.status === 200 && un.body.accessToken && un.body.viewer.via === 'share', 'the link password unlocks it');
    ok((await api('GET', `/watch/${A}?s=${c2.body.token}`, { as: null, headers: { 'x-watch-access': un.body.accessToken } })).status === 200 && code(await api('GET', `/watch/${A}?s=${c2.body.token}`, { as: null, headers: { 'x-watch-access': un.body.accessToken } })) === 'link_expired', 'max views 2: the third watch through the link is refused');

    console.log('\nC. Share to Slack');
    const S = await mkRec('s', 'alice', 'unlisted');
    features.slackEnabled = false;
    const locked = await api('POST', `/recordings/${S}/share/slack`, { as: legacy.alice });
    ok(locked.status === 403 && code(locked) === 'feature_locked' && locked.body.error.upgradeRequired === true && locked.body.error.details.feature === 'slack', 'Slack is a Pro paywall');
    features.slackEnabled = true;
    const noHook = await api('POST', `/recordings/${S}/share/slack`, { as: legacy.alice });
    ok(noHook.status === 400 && code(noHook) === 'needs_webhook' && noHook.body.error.meta.needsWebhook === true, 'no webhook on the account → 400 needs_webhook');
    await db.execute(sql`update users set slack_webhook = 'https://example.com/not-slack' where id = ${pg('alice')}`);
    ok(code(await api('POST', `/recordings/${S}/share/slack`, { as: legacy.alice })) === 'needs_webhook', 'a webhook off hooks.slack.com is refused (never posts elsewhere)');
    await db.execute(sql`update users set slack_webhook = 'https://hooks.slack.com/services/T/B/x' where id = ${pg('alice')}`);
    const sent = await api('POST', `/recordings/${S}/share/slack`, { as: legacy.alice });
    ok(sent.status === 200 && sent.body.ok === true && slackHits.length === 1 && slackHits[0].url === '/services/T/B/x' && slackHits[0].body.text.includes('Share s') && slackHits[0].body.text.includes(`https://app.example.test/watch/${S}`), 'the message carries the title and the watch URL, nothing else');
    ok((await api('POST', `/recordings/${S}/share/slack`, { as: legacy.bob })).status === 404 && slackHits.length === 1, 'a non-owner cannot share it (404, nothing posted)');
    slackStatus = 500;
    const rejected = await api('POST', `/recordings/${S}/share/slack`, { as: legacy.alice });
    ok(rejected.status === 502 && code(rejected) === 'slack_rejected', 'Slack answering non-2xx → 502 slack_rejected');
    await db.execute(sql`update users set slack_webhook = 'https://hooks.slack.com/services/unreachable' where id = ${pg('alice')}`);
    const dead = { async post() { throw new Error('ECONNREFUSED'); } };
    const app2 = express(); app2.use(express.json());
    app2.use('/api/v1', createSharingRouter({ repositories, requireAuth, entitlements: { isFeatureEnabled: async () => true }, slack: dead, logger: silent }));
    const s2 = app2.listen(0, '127.0.0.1'); await new Promise((r) => s2.once('listening', r));
    try {
      currentUser = legacy.alice;
      const r2 = await fetch(`http://127.0.0.1:${s2.address().port}/api/v1/recordings/${S}/share/slack`, { method: 'POST' });
      ok(r2.status === 502 && (await r2.json()).error.code === 'slack_unreachable', 'an unreachable webhook → 502 slack_unreachable');
    } finally { s2.close(); }
  } finally {
    server.close(); hook.close();
    await db.execute(sql`delete from users where id in (${pg('alice')}, ${pg('bob')})`).catch(() => {});
    await pool.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
