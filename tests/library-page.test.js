// T-803 library pages on v1 (run: cd server && npm run test:library-page)
//
// A. The library gate (V1_LIBRARY) and its block on the authed client-config,
//    with the mirror rule, on a real spawned legacy server. B. The client data
//    layer (client/src/lib/libraryApi.mjs) in node: normalisation, paginated
//    listing, folders/notifications helpers, writes that follow each
//    recording's source. C. Source-level wiring of Dashboard / Folders /
//    NotificationsBell: reads and writes go through the data layer, a v1 card
//    never builds a Cloudinary URL, the hover preview rule, alert() gone.
//
// The spawned-server sections SKIP LOUDLY without PostgreSQL;
// LIBRARY_PAGE_TESTS_REQUIRED=1 makes a skip a failure.
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
const REQUIRED = process.env.LIBRARY_PAGE_TESTS_REQUIRED === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Math.random().toString(36).slice(2, 8);

(async () => {
  console.log('T-803 library page tests');

  console.log('\nA. The library gate (V1_LIBRARY) and the authed client-config');
  const on = { V1_UPLOAD_API: 'true', V1_LIBRARY: 'true' };
  ok(rollout.libraryEnabled(on) === true && rollout.decideLibrary({ env: on }).path === 'v1', 'exact "true" + v1 API on → v1');
  for (const bad of ['TRUE', '1', 'yes', ' true', '', undefined]) ok(rollout.decideLibrary({ env: { V1_UPLOAD_API: 'true', V1_LIBRARY: bad } }).path === 'legacy', `V1_LIBRARY=${JSON.stringify(bad)} → legacy`);
  ok(rollout.decideLibrary({ env: { V1_LIBRARY: 'true' } }).path === 'legacy', 'never opens while the v1 API is off');
  ok(rollout.decideLibrary({ env: on, hasPostgresMirror: false }).decision === 'account_not_migrated' && rollout.decideLibrary({ env: on, hasPostgresMirror: false }).path === 'legacy' && rollout.decideLibrary({ env: on, hasPostgresMirror: true }).path === 'v1', 'an unmirrored account is told legacy under its own reason');
  const body = rollout.clientConfigBody({ path: 'legacy' }, { path: 'legacy' }, { path: 'legacy' }, rollout.decideLibrary({ env: on }));
  ok(body.library.path === 'v1' && body.library.v1Enabled === true && body.upload.path === 'legacy' && body.webUpload.path === 'legacy' && body.watch.path === 'legacy', 'the library block is independent of the other three gates');
  ok(rollout.clientConfigBody({ path: 'legacy' }).library.path === 'legacy' && !('library' in rollout.publicConfigBody(rollout.decideWatch({ env: {} }))), 'omitted → legacy; the PUBLIC config never carries the library decision');
  const lines = [];
  const kpi = createKpi({ info: (o, m) => lines.push(o), warn() {}, error() {}, child() { return this; } });
  kpi.libraryDecision({}, rollout.decideLibrary({ env: on }));
  kpi.libraryDecision({}, rollout.decideLibrary({ env: on, hasPostgresMirror: false }));
  ok(kpi._counters.libraryV1Selected === 1 && kpi._counters.libraryLegacySelected === 1 && kpi._counters.libraryAccountNotMigrated === 1 && lines.some((o) => o.kpi === 'library_decision' && o.library_path === 'v1'), 'KPI counters and the library_decision line');
  kpi._stop();

  console.log('\nB. Client data layer (libraryApi.mjs)');
  const lib = await import(`file:///${path.join(CLIENT_DIR, 'src', 'lib', 'libraryApi.mjs').replace(/\\/g, '/')}`);
  ok(lib.libraryIsV1({ library: { path: 'v1' } }) && !lib.libraryIsV1({ library: { v1Enabled: true } }) && !lib.libraryIsV1(null), 'only an explicit library.path === "v1" counts');
  const n = lib.normalizeSummary({ id: 'rec_1', title: 'T', status: 'processing', thumbnailUrl: 'thumb', posterUrl: 'poster', previewUrl: 'prev', legacyMedia: false, size_bytes: 10, duration: 5, created_at: '2026-09-12T00:00:00.000Z', views: 2, commentCount: 1, privacy: 'unlisted', folder_id: 'fld_1', archived: false, tags: ['a'], description: 'd', cta: { url: 'u' }, animatedThumbnail: true });
  ok(n.source === 'v1' && n.thumbnail === 'thumb' && n.previewUrl === 'prev' && n.filename === null && n.cloudinary === false && n.folder === 'fld_1' && n.created_at === Date.parse('2026-09-12T00:00:00.000Z') && n.views === 2 && n.commentCount === 1 && n.status === 'processing' && n.cta.url === 'u', 'a v1 summary → the card shape (folder, epoch created_at, no filename, no cloudinary flag)');
  ok(lib.normalizeSummary({ id: 'x', posterUrl: 'p' }).thumbnail === 'p' && lib.normalizeSummary({ id: 'x' }).thumbnail === null && lib.normalizeSummary({ id: 'x', legacyMedia: true }).legacyMedia === true, 'thumbnail falls back to the poster, else null; legacyMedia is carried');
  const l = lib.normalizeLegacy({ id: 'y', thumbnail: 'c.jpg', filename: 'https://c/v.webm', cloudinary: true, folder: null });
  ok(l.source === 'legacy' && l.thumbnail === 'c.jpg' && l.cloudinary === true, 'a legacy row is tagged and otherwise untouched');
  const calls = [];
  const mk = (routes) => async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    const u = new URL(url, 'http://x');
    const key = `${init.method || 'GET'} ${u.pathname}`;
    const r = routes[key] || routes['*'];
    const res = typeof r === 'function' ? r(u, init) : r;
    return { ok: res.status < 400, status: res.status, json: async () => res.body };
  };
  // v1 listing: live + archived, paginated by cursor, newest first.
  const pageA = { items: [{ id: 'r1', title: 'A', created_at: '2026-09-12T03:00:00Z' }], nextCursor: 'c1' };
  const pageB = { items: [{ id: 'r2', title: 'B', created_at: '2026-09-12T01:00:00Z' }], nextCursor: null };
  const arch = { items: [{ id: 'r3', title: 'C', created_at: '2026-09-12T02:00:00Z', archived: true }], nextCursor: null };
  let c = lib.createLibraryClient({ API: '', useV1: true, authFetch: mk({ 'GET /api/v1/recordings': (u) => (u.searchParams.get('archived') === 'true' ? { status: 200, body: arch } : (u.searchParams.get('cursor') === 'c1' ? { status: 200, body: pageB } : { status: 200, body: pageA })) }) });
  const all = await c.listRecordings();
  ok(all.map((r) => r.id).join() === 'r1,r3,r2' && all.every((r) => r.source === 'v1') && calls.filter((x) => x.url.includes('/api/v1/recordings')).length === 3 && calls.every((x) => !x.url.includes('/api/recordings?') && x.url.includes('limit=100')), 'v1 listing walks the cursor for live + archived (3 requests, limit 100) and merges newest first');
  calls.length = 0;
  c = lib.createLibraryClient({ API: '', useV1: false, authFetch: mk({ 'GET /api/recordings': { status: 200, body: [{ id: 'L1', title: 'x', created_at: 5 }] }, 'GET /api/folders': { status: 200, body: [{ id: 'f', name: 'F' }] } }) });
  ok((await c.listRecordings())[0].source === 'legacy' && calls[0].url === '/api/recordings' && (await c.listFolders())[0].name === 'F' && calls[1].url === '/api/folders', 'legacy path: exactly the legacy requests, rows tagged legacy');
  calls.length = 0;
  c = lib.createLibraryClient({ API: '', useV1: true, authFetch: mk({ 'GET /api/v1/folders': { status: 200, body: { items: [{ id: 'fld_1', name: 'N', created_at: '2026-09-12T00:00:00Z' }] } }, 'POST /api/v1/folders': (u, init) => (JSON.parse(init.body).name === 'dup' ? { status: 409, body: { error: { code: 'folder_exists', message: 'exists' } } } : { status: 201, body: { id: 'fld_2', name: JSON.parse(init.body).name, created_at: '2026-09-12T00:00:00Z' } }), 'PATCH /api/v1/folders/fld_2': { status: 200, body: { id: 'fld_2', name: 'R', created_at: '2026-09-12T00:00:00Z' } }, 'DELETE /api/v1/folders/fld_2': { status: 200, body: { ok: true } } }) });
  ok((await c.listFolders())[0].created_at === Date.parse('2026-09-12T00:00:00Z') && (await c.createFolder('New')).folder.id === 'fld_2' && (await c.createFolder('dup')).error === 'exists' && (await c.renameFolder('fld_2', 'R')).folder.name === 'R' && (await c.deleteFolder('fld_2')).ok === true, 'v1 folders: {items} unwrapped, nested errors surfaced as messages');
  calls.length = 0;
  c = lib.createLibraryClient({ API: '', useV1: true, authFetch: mk({ 'PATCH /api/v1/recordings/rec_v': { status: 200, body: { title: 'T2' } }, 'PATCH /api/recordings/leg': { status: 200, body: { title: 'L2' } }, 'PATCH /api/v1/recordings/rec_v/meta': { status: 403, body: { error: { code: 'feature_locked', message: 'Pro', upgradeRequired: true } } }, 'PATCH /api/recordings/leg/meta': { status: 200, body: { privacy: 'login' } }, 'DELETE /api/recordings/leg': { status: 200, body: { ok: true } }, 'DELETE /api/v1/recordings/rec_v': { status: 200, body: { ok: true } } }) });
  const v = { id: 'rec_v', source: 'v1' }, lg = { id: 'leg', source: 'legacy' };
  ok((await c.rename(v, 'T2')).title === 'T2' && (await c.rename(lg, 'L2')).title === 'L2' && calls[0].url === '/api/v1/recordings/rec_v' && calls[1].url === '/api/recordings/leg', 'writes follow EACH recording\'s source even on the v1 page (a legacy row the backfill has not reached stays on the legacy API)');
  const gated = await c.patchMeta(v, { password: 'x' });
  ok(gated.error === 'Pro' && gated.code === 'feature_locked' && (await c.patchMeta(lg, { privacy: 'login' })).meta.privacy === 'login', 'a v1 paywall surfaces its code; legacy meta answers as before');
  ok((await c.remove(v)).ok && (await c.remove(lg)).ok, 'delete follows the source');
  c = lib.createLibraryClient({ API: '', useV1: true, authFetch: mk({ 'GET /api/v1/notifications': { status: 200, body: { items: [{ type: 'view', name: 'B', videoId: 'r', videoTitle: 't', at: 1 }], unread: 1, lastReadAt: 0 } }, 'POST /api/v1/notifications/read': { status: 200, body: { lastReadAt: 5 } } }) });
  const nf = await c.notifications();
  ok(nf.items.length === 1 && nf.unread === 1 && (await c.markNotificationsRead()) === true, 'notifications: the same shape the bell renders, read marker posted');

  console.log('\nC. Client wiring (source level)');
  const dash = fs.readFileSync(path.join(CLIENT_DIR, 'src', 'pages', 'Dashboard.jsx'), 'utf8');
  const dashCode = dash.split('\n').filter((x) => !/^\s*(\/\/|\*|\/\*)/.test(x)).join('\n');
  const folders = fs.readFileSync(path.join(CLIENT_DIR, 'src', 'pages', 'Folders.jsx'), 'utf8');
  const bell = fs.readFileSync(path.join(CLIENT_DIR, 'src', 'components', 'NotificationsBell.jsx'), 'utf8');
  const hook = fs.readFileSync(path.join(CLIENT_DIR, 'src', 'hooks', 'useLibraryClient.js'), 'utf8');
  const api = fs.readFileSync(path.join(CLIENT_DIR, 'src', 'lib', 'libraryApi.mjs'), 'utf8');
  ok(/fetchClientConfig\(\{ API, authFetch \}\)/.test(hook) && /libraryIsV1\(cfg\)/.test(hook) && /createLibraryClient\(\{ API, authFetch, useV1 \}\)/.test(hook), 'the hook asks the server (authed client-config) and binds the client to its decision');
  ok(/useLibraryClient\(\)/.test(dash) && /useLibraryClient\(\)/.test(folders) && /useLibraryClient\(\)/.test(bell), 'dashboard, folders and the bell all use the library client');
  ok(/client\.listRecordings\(\), client\.listFolders\(\)/.test(dash) && /client\.listFolders\(\), client\.listRecordings\(\)/.test(folders) && /client\.notifications\(\)/.test(bell) && /client\.markNotificationsRead\(\)/.test(bell), 'reads go through the client');
  ok(!/authFetch\(`\$\{API\}\/api\/recordings`\)/.test(dashCode) && !/authFetch\(`\$\{API\}\/api\/folders`\)/.test(dashCode) && !/`\$\{API\}\/api\/(folders|recordings)`/.test(folders) && !/\/api\/notifications/.test(bell), 'no page builds a list/folders/notifications URL itself');
  ok(/client\.rename\(byId\(id\), title\)/.test(dash) && /client\.patchMeta\(byId\(id\), patch\)/.test(dash) && /client\.remove\(byId\(id\)\)/.test(dash) && /client\.patchMeta\(rec, body\)/.test(dash) && /client\.patchMeta\(rec, \{ folder: folderId \}\)/.test(folders) && /client\.createFolder\(name\)/.test(folders) && /client\.renameFolder\(id, name\)/.test(folders) && /client\.deleteFolder\(f\.id\)/.test(folders), 'writes go through the client (and so follow the recording\'s source)');
  ok(!/\balert\(/.test(dashCode) && !/\balert\(/.test(folders) && /useToast\(\)/.test(dash) && /useToast\(\)/.test(folders), 'alert() is gone from the library pages');
  ok(/const isV1 = r\.source === 'v1'/.test(dash) && /const legacySrc = !isV1 && r\.filename \? \(r\.cloudinary \? r\.filename : `\$\{API\}\/uploads\/\$\{r\.filename\}`\) : null/.test(dash), 'the card builds a media URL ONLY for legacy rows');
  ok(/showPreview && isV1 && r\.previewUrl && \(/.test(dash) && /<img className=\{styles\.previewVid\} src=\{r\.previewUrl\}/.test(dash) && /showPreview && !isV1 && legacySrc && \(/.test(dash), 'hover preview: the WebP preview for v1 rows, the legacy video only for legacy rows');
  ok(/r\.animatedThumbnail !== false/.test(dash), 'the animated-thumbnail setting governs the hover preview');
  ok(/data-status=\{r\.status\}/.test(dash) && /'Processing…'/.test(dash), 'a v1 card shows its pipeline status (processing / failed) honestly');
  ok(!/cloudinary/i.test(api.split('\n').filter((x) => !/^\s*\/\//.test(x)).join('\n').replace(/normalizeLegacy[\s\S]*?\}\);/, '').replace(/cloudinary: false/g, '')), 'the data layer never builds a Cloudinary URL (the legacy row keeps what the legacy API sent)');
  ok(/if \(rec\.source === 'v1'\) \{ setData\(/.test(dash) && /rec && rec\.source === 'v1'\) \{ toast\.info\('Duplicating/.test(dash), 'legacy-only actions (analytics, duplicate) are guarded for v1 rows rather than pointed at routes that do not exist');
  const server = fs.readFileSync(path.join(SERVER_DIR, 'index.js'), 'utf8');
  ok(/createFoldersRouter\(\{ repositories, requireAuth, logger \}\)/.test(server) && /createNotificationsRouter\(\{ repositories, requireAuth, logger \}\)/.test(server) && /kpi\.libraryDecision\(req, library\)/.test(server), 'the server mounts both routers on the v1 flag and reports the library decision');

  console.log('\nD. Spawned legacy server: the library block with the mirror rule');
  let dbUrl = null;
  try { const { loadEnv, createPool } = require(path.join(ROOT, 'db', 'src', 'index.js')); const env = loadEnv({ appEnv: 'test' }); const pool = createPool({ env, max: 1 }); await pool.query('select 1'); dbUrl = env.databaseUrl; await pool.end(); } catch {}
  if (!dbUrl) {
    console.log('  SKIPPED D — PostgreSQL unreachable');
    if (REQUIRED) { fail += 1; console.log('  FAIL: LIBRARY_PAGE_TESTS_REQUIRED=1 but PostgreSQL is unavailable'); }
  } else {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't803-'));
    const PORT = String(3310 + Math.floor(Math.random() * 20));
    const child = spawn(process.execPath, ['index.js'], { cwd: SERVER_DIR, env: { ...process.env, PORT, NODE_ENV: 'production', JWT_SECRET: 't803-jwt-secret-0123456789', DATA_DIR: dataDir, LOG_PRETTY: 'false', SENTRY_DSN: '', V1_UPLOAD_API: 'true', V1_LIBRARY: 'true', PG_DUAL_WRITE: 'true', APP_ENV: 'test', DATABASE_URL_TEST: dbUrl, STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100', STORAGE_BUCKET: 'veorec-media-test', STORAGE_PROVIDER: 'minio', STORAGE_ACCESS_KEY_ID: 'veorec_dev', STORAGE_SECRET_ACCESS_KEY: 'veorec_local_dev_secret', STORAGE_REGION: 'auto', STORAGE_FORCE_PATH_STYLE: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (d) => { out += d.toString(); }); child.stderr.on('data', (d) => { out += d.toString(); });
    try {
      let ready = false;
      for (let i = 0; i < 60 && !ready; i += 1) { try { ready = (await fetch(`http://127.0.0.1:${PORT}/api/plans`)).ok; } catch {} if (!ready) await sleep(250); }
      ok(ready, 'the legacy server boots with V1_LIBRARY=true');
      const L = `http://127.0.0.1:${PORT}`;
      const signup = await (await fetch(`${L}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'T', email: `t803-${RUN}@example.com`, password: 'secret123' }) })).json();
      const call = (p, init = {}) => fetch(`${L}/api/v1${p}`, { ...init, headers: { authorization: `Bearer ${signup.token}`, 'content-type': 'application/json', ...(init.headers || {}) } });
      let cfg = null;
      for (let i = 0; i < 40; i += 1) { cfg = await (await fetch(`${L}/api/client-config`, { headers: { authorization: `Bearer ${signup.token}` } })).json(); if (cfg.library && cfg.library.path === 'v1') break; await sleep(250); }
      ok(cfg.library && cfg.library.path === 'v1', 'once the signup is mirrored, the authed client-config says library v1');
      const created = await (await call('/folders', { method: 'POST', body: JSON.stringify({ name: 'From the mounted server' }) })).json();
      const listed = await (await call('/folders')).json();
      ok(created.id && listed.items.some((f) => f.id === created.id), 'mounted: folders round-trip on PostgreSQL');
      const notif = await (await call('/notifications')).json();
      ok(Array.isArray(notif.items) && notif.unread === 0 && (await call('/notifications/read', { method: 'POST' })).status === 200, 'mounted: notifications answer for a fresh account');
      ok((await fetch(`${L}/api/folders`, { headers: { authorization: `Bearer ${signup.token}` } })).status === 200, 'the legacy /api/folders route is untouched');
      ok(/"kpi":"library_decision"/.test(out) && /"decision":"library_v1_enabled"/.test(out), 'the KPI line is logged');
    } finally { child.kill(); await sleep(300); fs.rmSync(dataDir, { recursive: true, force: true }); }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
