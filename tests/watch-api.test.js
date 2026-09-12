// T-801 /api/v1 watch endpoints (run: cd api && npm run test:watch)
//
// The privacy × endpoint matrix from docs/12, signed media URLs with the TTL
// policy of docs/12 §5, the download disposition, the HLS playlist rewrite
// proxy, the transcript with real statuses, the lead gate, the unlock limiter,
// and the legacy-server mount. Sections B–H need real PostgreSQL; media
// sections need MinIO (objects are really fetched through the minted URLs).
//
// SKIPS LOUDLY without infrastructure; WATCH_TESTS_REQUIRED=1 makes that a failure.
'use strict';

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const API_DIR = path.join(ROOT, 'api');
const SERVER_DIR = path.join(ROOT, 'server');
const express = require(path.join(API_DIR, 'node_modules', 'express'));
const bcrypt = require(path.join(SERVER_DIR, 'node_modules', 'bcryptjs'));
const { loadEnv, createPool, createClient, createRepositories, withTransaction: rawTx } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));
const storagePkg = require(path.join(ROOT, 'storage', 'src', 'index.js'));
const { createWatchRouter, authz, createRateLimiter } = require(path.join(API_DIR, 'src', 'index.js'));
const { rewritePlaylist, safeFilename, HLS_FILE_RE } = require(path.join(API_DIR, 'src', 'watch.router.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.WATCH_TESTS_REQUIRED === '1';
const MINIO = process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100';
const RUN = crypto.randomBytes(3).toString('hex');
const REASON = 'T-801 watch api test';
const SECRET = 'watch-test-secret-0123456789';
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const near = (a, b, tol) => Math.abs(a - b) <= tol;

(async () => {
  console.log('T-801 /api/v1 watch endpoint tests');

  // ── A. Pure: tokens, the matrix, TTLs, gates, verifier, rewrite ──────────
  console.log('\nA. Authorisation matrix and helpers (pure)');
  {
    let t = 1_800_000_000_000; const now = () => t;
    const tok = authz.signAccess(SECRET, { rec: 'rec_1', grants: ['password'] }, now);
    const v = authz.verifyAccess(SECRET, tok, { rec: 'rec_1', now });
    ok(v && v.grants.includes('password') && v.exp === Math.floor(t / 1000) + authz.ACCESS_TOKEN_TTL_SECONDS, 'access token round-trips with its grants and a 24 h expiry');
    ok(authz.verifyAccess(SECRET, tok, { rec: 'rec_2', now }) === null, 'a token is bound to one recording');
    ok(authz.verifyAccess('other-secret-0123456789', tok, { rec: 'rec_1', now }) === null && authz.verifyAccess(SECRET, tok.slice(0, -2) + 'AA', { rec: 'rec_1', now }) === null, 'a wrong secret or a tampered signature is rejected');
    const body = Buffer.from(JSON.stringify({ rec: 'rec_1', g: ['password', 'lead'], exp: 9e9 })).toString('base64url');
    ok(authz.verifyAccess(SECRET, `${body}.${tok.split('.')[1]}`, { rec: 'rec_1', now }) === null, 'a forged payload with a reused signature is rejected');
    ok(authz.verifyAccess(SECRET, tok, { rec: 'rec_1', now: () => t + (authz.ACCESS_TOKEN_TTL_SECONDS + 1) * 1000 }) === null, 'an expired token is rejected');
    ok(authz.verifyAccess(SECRET, 'garbage', { now }) === null && authz.verifyAccess(SECRET, '', { now }) === null && authz.verifyAccess(SECRET, null, { now }) === null, 'malformed tokens are rejected, never thrown');

    const rec = (privacy, extra = {}) => ({ id: 'rec_x', userId: 'usr_owner', privacy, passwordHash: privacy === 'password' ? 'h' : null, deletedAt: null, workspaceId: privacy === 'workspace' ? 'ws_1' : null, audience: {}, ...extra });
    const R = (o) => authz.resolveWatchAccess({ now, ...o });
    const owner = { id: 'usr_owner' }, admin = { id: 'usr_adm', isAdmin: true }, bob = { id: 'usr_bob' };
    ok(R({ recording: rec('public') }).via === 'public' && R({ recording: rec('unlisted') }).via === 'unlisted', 'public/unlisted: anonymous may watch');
    ok(R({ recording: rec('login') }).reason === 'login_required' && R({ recording: rec('login'), viewer: bob }).via === 'login', 'login: any signed-in user, anonymous → login_required');
    ok(R({ recording: rec('password') }).reason === 'password_required' && R({ recording: rec('password'), access: { grants: ['password'] } }).via === 'password', 'password: needs the password grant');
    ok(R({ recording: rec('password', { passwordHash: null }) }).ok === true, 'password privacy without a stored hash behaves as unlisted (nothing to unlock)');
    ok(R({ recording: rec('workspace') }).reason === 'login_required' && R({ recording: rec('workspace'), viewer: bob }).reason === 'not_found' && R({ recording: rec('workspace'), viewer: bob, workspaceRole: 'member' }).via === 'workspace', 'workspace: anonymous → login, non-member → not_found (no existence leak), member → ok');
    for (const p of ['public', 'unlisted', 'login', 'password', 'workspace']) {
      ok(R({ recording: rec(p), viewer: owner }).via === 'owner' && R({ recording: rec(p), viewer: admin }).via === 'admin', `${p}: the owner and an admin always may (isOwner/isAdmin flagged)`);
    }
    ok(R({ recording: rec('public', { deletedAt: new Date() }) }).reason === 'not_found' && R({ recording: null }).reason === 'not_found', 'a deleted or missing recording is not_found for everyone');
    const link = (o = {}) => ({ id: 'shl_1', recordingId: 'rec_x', tokenHash: 'x', passwordHash: null, expiresAt: null, maxViews: null, viewCount: 0, revokedAt: null, ...o });
    ok(R({ recording: rec('login'), shareTokenPresented: true, shareLink: link() }).via === 'share' && R({ recording: rec('password'), shareTokenPresented: true, shareLink: link() }).via === 'share', 'a live share link satisfies login/password privacy');
    ok(R({ recording: rec('public'), shareTokenPresented: true, shareLink: link({ revokedAt: new Date() }) }).reason === 'link_expired', 'a revoked link is link_expired EVEN on a public recording (no fallback)');
    ok(R({ recording: rec('public'), shareTokenPresented: true, shareLink: link({ expiresAt: new Date(t - 1) }) }).reason === 'link_expired' && R({ recording: rec('public'), shareTokenPresented: true, shareLink: link({ expiresAt: new Date(t + 60000) }) }).ok, 'expiry is checked against the clock');
    ok(R({ recording: rec('public'), shareTokenPresented: true, shareLink: link({ maxViews: 3, viewCount: 3 }) }).reason === 'link_expired' && R({ recording: rec('public'), shareTokenPresented: true, shareLink: link({ maxViews: 3, viewCount: 2 }) }).ok, 'max views exhausted → link_expired');
    ok(R({ recording: rec('public'), shareTokenPresented: true, shareLink: null }).reason === 'link_expired' && R({ recording: rec('public'), shareTokenPresented: true, shareLink: link({ recordingId: 'rec_other' }) }).reason === 'link_expired', 'an unknown token or another recording\'s link is a dead link');
    ok(R({ recording: rec('login'), shareTokenPresented: true, shareLink: link({ passwordHash: 'h' }) }).reason === 'password_required' && R({ recording: rec('login'), shareTokenPresented: true, shareLink: link({ passwordHash: 'h' }), access: { grants: ['share:shl_1'] } }).via === 'share' && R({ recording: rec('login'), shareTokenPresented: true, shareLink: link({ passwordHash: 'h' }), access: { grants: ['share:shl_9'] } }).reason === 'password_required', 'a link password needs the grant for THAT link');
    ok(R({ recording: rec('login'), viewer: owner, shareTokenPresented: true, shareLink: link({ revokedAt: new Date() }) }).via === 'owner', 'the owner is never locked out by a dead link');
    ok(authz.mediaTtlSeconds(rec('public'), 'public') === 24 * 3600 && authz.mediaTtlSeconds(rec('unlisted'), 'unlisted') === 600 && authz.mediaTtlSeconds(rec('login'), 'owner') === 600 && authz.mediaTtlSeconds(rec('public'), 'share') === 600, 'TTL policy: public 24 h, everything else (incl. share-link access) 10 min');
    const d = { isOwner: false, isAdmin: false };
    ok(authz.leadGateSatisfied(rec('public'), d, null) && !authz.leadGateSatisfied(rec('public', { audience: { requireEmail: true } }), d, null) && authz.leadGateSatisfied(rec('public', { audience: { requireEmail: true } }), d, { grants: ['lead'] }) && authz.leadGateSatisfied(rec('public', { audience: { requireEmail: true } }), { isOwner: true }, null), 'lead gate: requireEmail needs a lead grant unless owner/admin');
    const verify = authz.createPasswordVerifier({ bcryptCompare: (p, h) => bcrypt.compare(p, h) });
    const bh = bcrypt.hashSync('legacy-pw', 4);
    ok(await verify('open', sha256('open')) && !(await verify('nope', sha256('open'))) && await verify('legacy-pw', bh) && !(await verify('x', bh)) && !(await verify('open', '')) && !(await verify(null, sha256('open'))), 'the verifier accepts sha256 (v1) and bcrypt (legacy) hashes, constant-time for sha256');
    ok(!(await authz.createPasswordVerifier()('legacy-pw', bh)), 'without a bcrypt implementation a bcrypt hash never verifies (fails closed)');
    ok(HLS_FILE_RE.test('720p_seg_00001.m4s') && !HLS_FILE_RE.test('../x.m3u8') && !HLS_FILE_RE.test('a/b.m3u8') && !HLS_FILE_RE.test('.hidden'), 'playlist/segment names are validated against the key contract');
    const master = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1x1,CODECS="avc1"\n720p_index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\n480p_index.m3u8\n';
    const rw = await rewritePlaylist(master, { playlistUrl: (n) => `P/${n}?a=T`, segmentUrl: async (n) => `S/${n}` });
    ok(rw.split('\n')[3] === 'P/720p_index.m3u8?a=T' && rw.split('\n')[5] === 'P/480p_index.m3u8?a=T' && rw.includes('#EXT-X-STREAM-INF:BANDWIDTH=1'), 'master: variant playlists point back at the proxy, tags untouched');
    const variant = '#EXTM3U\n#EXT-X-MAP:URI="720p_init.mp4"\n#EXTINF:4.000,\n720p_seg_00001.m4s\n#EXTINF:2.0,\nhttps://cdn.example/abs.m4s\n#EXT-X-ENDLIST\n';
    const rv = await rewritePlaylist(variant, { playlistUrl: (n) => `P/${n}`, segmentUrl: async (n) => `S/${n}` });
    ok(rv.includes('#EXT-X-MAP:URI="S/720p_init.mp4"') && rv.includes('\nS/720p_seg_00001.m4s\n') && rv.includes('https://cdn.example/abs.m4s') && rv.includes('#EXT-X-ENDLIST'), 'variant: init + segments become storage URLs, absolute URIs are left alone');
    let threw = false; try { await rewritePlaylist('#EXTM3U\n../../etc/passwd\n', { playlistUrl: (n) => n, segmentUrl: async (n) => n }); } catch (e) { threw = e.code === 'internal_error'; }
    ok(threw, 'a playlist referencing an unexpected path is refused rather than resolved');
    ok(safeFilename('My video: "final" (v2)') === 'My video final v2' && safeFilename('') === 'video' && safeFilename('x'.repeat(200)).length === 80, 'download filenames are sanitised');
    let c = 0; const lim = createRateLimiter({ max: 2, windowMs: 1000, keyOf: (r) => r.ip, now: () => c });
    const rr = await lim.hit('1.1.1.1'); const r2 = await lim.hit('1.1.1.1'); const r3 = await lim.hit('1.1.1.1'); const other = await lim.hit('2.2.2.2');
    ok(rr.allowed && r2.allowed && !r3.allowed && r3.retryAfterSec === 1 && other.allowed, 'fixed-window limiter: max per key per window, Retry-After in seconds');
    c = 1001; ok((await lim.hit('1.1.1.1')).allowed, 'a new window resets the key');
  }

  // ── infrastructure ──────────────────────────────────────────────────────
  let env = null, pgUp = false, pool = null;
  try { env = loadEnv({ appEnv: 'test' }); } catch (e) { console.log('  env:', e.message); }
  if (env) { pool = createPool({ env, max: 6 }); try { await pool.query('select 1'); pgUp = true; } catch {} }
  if (!pgUp) {
    console.log('\n  SKIPPED B–H — PostgreSQL unreachable');
    if (REQUIRED) { fail += 1; console.log('  FAIL: WATCH_TESTS_REQUIRED=1 but PostgreSQL is unavailable'); }
    if (pool) await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; return;
  }
  let storageUp = false;
  try { storageUp = (await fetch(`${MINIO}/minio/health/live`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
  if (!storageUp) { console.log(`  no object storage at ${MINIO} — media sections will be SKIPPED`); if (REQUIRED) { fail += 1; console.log('  FAIL: WATCH_TESTS_REQUIRED=1 but MinIO is unavailable'); } }
  const provider = storageUp ? storagePkg.createStorageProvider({ appEnv: 'test' }) : {
    async getSignedDownloadUrl(key, o) { return `signed://${key}?ttl=${o.expiresIn}`; },
    async getObjectBuffer() { const e = new Error('nf'); e.code = 'object_not_found'; throw e; },
    async putObject() {}, async deleteObjects() {},
  };
  const keys = storagePkg.keys;
  const db = createClient(pool);
  const repositories = () => createRepositories(db);
  const repos = repositories();
  const legacy = { alice: `a${RUN}`, bob: `b${RUN}`, carol: `c${RUN}` };
  const pg = (u) => `usr_${legacy[u]}`;
  for (const u of ['alice', 'bob', 'carol']) await db.execute(sql`INSERT INTO users (id,email,name,password_hash,is_admin) VALUES (${pg(u)}, ${`${u}-${RUN}@example.com`}, ${u === 'alice' ? 'Alice Author' : u}, 'x', ${u === 'carol'})`);
  const WS = `ws_t801_${RUN}`;
  await db.execute(sql`INSERT INTO workspaces (id,name,owner_user_id) VALUES (${WS}, 'Team', ${pg('alice')})`);
  await db.execute(sql`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (${WS}, ${pg('alice')}, 'owner'), (${WS}, ${pg('bob')}, 'member')`);
  const rid = (k) => `rec_t801_${k}_${RUN}`;
  const mkRec = async (k, { privacy = 'unlisted', status = 'ready', passwordHash = null, audience = {}, workspaceId = null, title = 'My Video: "final" (v2)', removeBranding = false, deleted = false, failureCode = null } = {}) => {
    await db.execute(sql`INSERT INTO recordings (id,user_id,title,status,failure_code,source_kind,privacy,password_hash,audience,workspace_id,remove_branding,duration,width,height,chapters,deleted_at) VALUES (${rid(k)}, ${pg('alice')}, ${title}, ${status}, ${failureCode}, 'extension', ${privacy}, ${passwordHash}, ${JSON.stringify(audience)}::jsonb, ${workspaceId}, ${removeBranding}, 12.5, 1280, 720, ${JSON.stringify([{ t: 0, title: 'Intro' }])}::jsonb, ${deleted ? new Date() : null})`);
    return rid(k);
  };
  const uploaded = [];
  const put = async (key, body, contentType) => { await provider.putObject(key, body, { contentType }); uploaded.push(key); };
  const MP4 = crypto.randomBytes(4096), POSTER = crypto.randomBytes(512), INIT = Buffer.from('init-' + RUN), SEG1 = crypto.randomBytes(1024), SEG2 = crypto.randomBytes(1024);
  const VTT = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello\n';
  /** A ready media set: mp4 + poster + captions + a one-rendition HLS package. */
  const seedMedia = async (recId, { hls = true } = {}) => {
    const asset = (id, kind, variant, storageKey, container = null) => db.execute(sql`INSERT INTO video_assets (id,recording_id,kind,variant,storage_key,status,size_bytes,counts_toward_quota,container) VALUES (${id}, ${recId}, ${kind}, ${variant}, ${storageKey}, 'ready', 1000, false, ${container})`);
    const mp4Id = `ast_mp4_${recId.slice(-9)}`; const mp4Key = keys.derivedVideo(recId, mp4Id);
    await db.execute(sql`INSERT INTO video_assets (id,recording_id,kind,variant,storage_key,status,size_bytes,counts_toward_quota,container) VALUES (${mp4Id}, ${recId}, 'mp4', 'main', ${mp4Key}, 'ready', ${MP4.length}, false, 'mp4')`);
    await put(mp4Key, MP4, 'video/mp4');
    const posterId = `ast_pos_${recId.slice(-9)}`; const posterKey = keys.image(recId, posterId, 'poster');
    await asset(posterId, 'poster', null, posterKey, 'jpg');
    await put(posterKey, POSTER, 'image/jpeg');
    const capId = `ast_cap_${recId.slice(-9)}`; const capKey = keys.captions(recId, capId);
    await asset(capId, 'captions_vtt', null, capKey, 'vtt'); await put(capKey, Buffer.from(VTT), 'text/vtt');
    let hlsId = null;
    if (hls) {
      hlsId = `ast_hls_${recId.slice(-9)}`; const masterKey = keys.hlsMaster(recId, hlsId);
      await db.execute(sql`INSERT INTO video_assets (id,recording_id,kind,variant,storage_key,status,size_bytes,counts_toward_quota,container) VALUES (${hlsId}, ${recId}, 'hls', '240p', ${masterKey}, 'ready', 4000, false, 'hls')`);
      await put(masterKey, Buffer.from('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=426x240,CODECS="avc1.42c015,mp4a.40.2"\n240p_index.m3u8\n'), 'application/vnd.apple.mpegurl');
      await put(keys.hlsSegment(recId, hlsId, '240p_index.m3u8'), Buffer.from('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="240p_init.mp4"\n#EXTINF:4.000,\n240p_seg_00001.m4s\n#EXTINF:4.000,\n240p_seg_00002.m4s\n#EXT-X-ENDLIST\n'), 'application/vnd.apple.mpegurl');
      await put(keys.hlsSegment(recId, hlsId, '240p_init.mp4'), INIT, 'video/mp4');
      await put(keys.hlsSegment(recId, hlsId, '240p_seg_00001.m4s'), SEG1, 'video/iso.segment');
      await put(keys.hlsSegment(recId, hlsId, '240p_seg_00002.m4s'), SEG2, 'video/iso.segment');
    }
    return { mp4Key, posterKey, capKey, hlsId };
  };

  // The router under test: viewer from an x-viewer header, adjustable clock,
  // a tight unlock limiter so the limit is provable.
  let clock = Date.now(); const now = () => clock;
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createWatchRouter({
    repositories, storage: provider, keys, accessSecret: SECRET, logger: silent, now,
    viewer: async (req) => { const u = req.get('x-viewer'); if (!u) return null; if (u === 'unmigrated') return { id: 'usr_nobody', isAdmin: false }; return { id: pg(u), isAdmin: u === 'carol' }; },
    verifyPassword: authz.createPasswordVerifier({ bcryptCompare: (p, h) => bcrypt.compare(p, h) }),
    configured: () => true,
    rateLimits: { unlock: { max: 3, windowMs: 60 * 1000 }, watch: { max: 5000, windowMs: 60 * 1000 } },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const api = async (method, p, { as, body, access, ip, headers = {} } = {}) => {
    const h = { 'content-type': 'application/json', ...(as ? { 'x-viewer': as } : {}), ...(access ? { 'x-watch-access': access } : {}), ...(ip ? { 'x-forwarded-for': ip } : {}), ...headers };
    const res = await fetch(base + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    let json = null, text = null; const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) { try { json = await res.json(); } catch {} } else text = await res.text();
    return { status: res.status, body: json, text, headers: res.headers };
  };
  const code = (r) => r.body && r.body.error && r.body.error.code;

  try {
    // ── B. GET /watch/:id — the matrix against real rows ──────────────────
    console.log('\nB. GET /watch/:id privacy matrix');
    const PUB = await mkRec('pub', { privacy: 'public' });
    const UNL = await mkRec('unl', { privacy: 'unlisted' });
    const LOG = await mkRec('log', { privacy: 'login' });
    const PWD = await mkRec('pwd', { privacy: 'password', passwordHash: sha256('open-sesame') });
    const PWB = await mkRec('pwb', { privacy: 'password', passwordHash: bcrypt.hashSync('legacy-pw', 4) });
    const WSR = await mkRec('ws', { privacy: 'workspace', workspaceId: WS });
    const DEL = await mkRec('del', { privacy: 'public', deleted: true });
    const FAILED = await mkRec('failed', { privacy: 'unlisted', status: 'failed', failureCode: 'probe_invalid' });
    const anon = await api('GET', `/watch/${PUB}`);
    ok(anon.status === 200 && anon.body.id === PUB && anon.body.author.name === 'Alice Author' && anon.body.branding === true && anon.body.privacy === 'public' && anon.body.status === 'ready' && anon.body.chapters.length === 1 && anon.body.duration === 12.5 && anon.body.viewer.isOwner === false && anon.body.viewer.via === 'public', 'public: anonymous gets the WatchPayload (author, branding, chapters, status)');
    ok(!('mp4Url' in anon.body) && !JSON.stringify(anon.body).includes('storageKey') && !JSON.stringify(anon.body).includes('password_hash') && !JSON.stringify(anon.body).includes('passwordHash'), 'the payload carries no media URLs, keys or hashes');
    ok(anon.headers.get('cache-control') === 'no-store', 'watch responses are no-store');
    ok((await api('GET', `/watch/${UNL}`)).status === 200, 'unlisted: anyone with the link');
    const login = await api('GET', `/watch/${LOG}`);
    ok(login.status === 401 && code(login) === 'login_required' && login.body.error.meta.title === 'My Video: "final" (v2)', 'login: anonymous → 401 login_required (with the title for the gate UI)');
    ok((await api('GET', `/watch/${LOG}`, { as: 'bob' })).status === 200 && (await api('GET', `/watch/${LOG}`, { as: 'bob' })).body.viewer.via === 'login', 'login: any signed-in user may watch');
    const gate = await api('GET', `/watch/${PWD}`);
    ok(gate.status === 200 && gate.body.requiresPassword === true && gate.body.title && !gate.body.author, 'password: the 200 gate reveals only the title');
    const own = await api('GET', `/watch/${PWD}`, { as: 'alice' });
    ok(own.status === 200 && own.body.viewer.isOwner === true && !own.body.requiresPassword, 'password: the owner is not gated');
    const adm = await api('GET', `/watch/${LOG}`, { as: 'carol' });
    ok(adm.status === 200 && adm.body.viewer.isAdmin === true && adm.body.viewer.via === 'admin', 'an admin may watch anything');
    ok((await api('GET', `/watch/${WSR}`)).status === 401 && (await api('GET', `/watch/${WSR}`, { as: 'bob' })).status === 200 && (await api('GET', `/watch/${WSR}`, { as: 'bob' })).body.viewer.via === 'workspace', 'workspace: anonymous → login_required, a member may watch');
    const nonMember = await api('GET', `/watch/${WSR}`, { as: 'carol', headers: { 'x-viewer': 'unmigrated' } });
    ok(nonMember.status === 404, 'workspace: a signed-in non-member gets 404, indistinguishable from missing');
    ok((await api('GET', `/watch/${DEL}`)).status === 404 && (await api('GET', `/watch/${DEL}`, { as: 'alice' })).status === 404 && (await api('GET', `/watch/rec_nope`)).status === 404, 'deleted (even for the owner) and unknown ids → 404');
    const fv = await api('GET', `/watch/${FAILED}`); const fo = await api('GET', `/watch/${FAILED}`, { as: 'alice' });
    ok(fv.status === 200 && fv.body.status === 'failed' && fv.body.failureCode === null && fo.body.failureCode === 'probe_invalid', 'viewers see status honestly; the failure code is owner-only');

    console.log('\nC. Share links');
    const mkLink = async (recordingId, extra = {}) => { const token = crypto.randomBytes(16).toString('base64url'); const row = await repos.shareLinks.create({ userId: pg('alice') }, recordingId, { tokenHash: sha256(token), ...extra }); return { token, row }; };
    const l1 = await mkLink(LOG);
    const viaShare = await api('GET', `/watch/${LOG}?s=${l1.token}`);
    ok(viaShare.status === 200 && viaShare.body.viewer.via === 'share', 'a live share link opens a login-only recording anonymously (?s=)');
    ok((await api('GET', `/watch/${LOG}?shareToken=${l1.token}`)).status === 200, '?shareToken= is accepted too (docs/08 §7)');
    ok((await repos.shareLinks.list({ userId: pg('alice') }, LOG)).find((l) => l.id === l1.row.id).viewCount === 2, 'each payload fetch through the link counts a view');
    ok((await api('GET', `/watch/${LOG}?s=not-a-real-token`)).status === 403 && code(await api('GET', `/watch/${LOG}?s=not-a-real-token`)) === 'link_expired', 'an unknown token is a dead link (403 link_expired)');
    const l2 = await mkLink(PUB, { maxViews: 1 });
    ok((await api('GET', `/watch/${PUB}?s=${l2.token}`)).status === 200 && code(await api('GET', `/watch/${PUB}?s=${l2.token}`)) === 'link_expired' && (await api('GET', `/watch/${PUB}`)).status === 200, 'max views: the second watch through the link is refused although the recording itself is public');
    const l3 = await mkLink(PUB, { expiresAt: new Date(Date.now() - 1000) });
    ok(code(await api('GET', `/watch/${PUB}?s=${l3.token}`)) === 'link_expired', 'an expired link is refused on a public recording — no fallback to the more permissive default');
    const l4 = await mkLink(UNL); await repos.shareLinks.revoke({ userId: pg('alice') }, l4.row.id);
    ok(code(await api('GET', `/watch/${UNL}?s=${l4.token}`)) === 'link_expired' && (await api('GET', `/watch/${UNL}?s=${l4.token}`, { as: 'alice' })).status === 200, 'a revoked link is dead for viewers; the owner is never locked out');
    const l5 = await mkLink(LOG, { passwordHash: sha256('link-pw'), label: 'client X' });
    const lg = await api('GET', `/watch/${LOG}?s=${l5.token}`);
    ok(lg.status === 200 && lg.body.requiresPassword === true && lg.body.shareLink.label === 'client X', 'a link with its own password gates like a password recording');
    ok(code(await api('GET', `/watch/${PWD}?s=${l5.token}`)) === 'link_expired', 'a link cannot be replayed against another recording');

    console.log('\nD. POST /watch/:id/unlock + limiter');
    const wrong = await api('POST', `/watch/${PWD}/unlock`, { body: { password: 'nope' }, ip: '10.0.0.1' });
    ok(wrong.status === 401 && code(wrong) === 'invalid_password', 'wrong password → 401 invalid_password');
    const un = await api('POST', `/watch/${PWD}/unlock`, { body: { password: 'open-sesame' }, ip: '10.0.0.1' });
    ok(un.status === 200 && un.body.id === PWD && typeof un.body.accessToken === 'string' && un.body.author && un.body.viewer.via === 'password', 'correct password → the WatchPayload + an access token');
    const tokPwd = un.body.accessToken;
    ok((await api('GET', `/watch/${PWD}`, { access: tokPwd })).status === 200 && (await api('GET', `/watch/${PWD}`, { access: tokPwd })).body.viewer.via === 'password' && (await api('GET', `/watch/${PWD}?a=${encodeURIComponent(tokPwd)}`)).status === 200, 'the token (header or ?a=) satisfies later requests');
    ok((await api('GET', `/watch/${PWB}`, { access: tokPwd })).body.requiresPassword === true, 'a token for one recording does nothing for another');
    const unb = await api('POST', `/watch/${PWB}/unlock`, { body: { password: 'legacy-pw' }, ip: '10.0.0.2' });
    ok(unb.status === 200 && unb.body.accessToken, 'a legacy bcrypt password hash unlocks too');
    const unl5 = await api('POST', `/watch/${LOG}/unlock?s=${l5.token}`, { body: { password: 'link-pw' }, ip: '10.0.0.3' });
    ok(unl5.status === 200 && unl5.body.viewer.via === 'share' && (await api('GET', `/watch/${LOG}?s=${l5.token}`, { access: unl5.body.accessToken })).status === 200 && (await api('GET', `/watch/${LOG}?s=${l5.token}`)).body.requiresPassword === true, 'unlocking a link password grants that link; without the token the gate stays');
    ok((await api('POST', `/watch/${LOG}/unlock?s=${l5.token}`, { body: { password: 'wrong' }, ip: '10.0.0.3' })).status === 401 && code(await api('POST', `/watch/${PUB}/unlock?s=${l3.token}`, { body: { password: 'x' }, ip: '10.0.0.3' })) === 'link_expired', 'link unlock: wrong password 401; a dead link 403');
    ok((await api('POST', `/watch/${PUB}/unlock`, { body: { password: 'anything' }, ip: '10.0.0.4' })).status === 200 && (await api('POST', `/watch/${PUB}/unlock`, { body: { password: 'anything' }, ip: '10.0.0.4' })).body.accessToken === null, 'unlocking a recording without a password gate just returns the payload (no token)');
    const hits = []; for (let i = 0; i < 4; i += 1) hits.push(await api('POST', `/watch/${PWD}/unlock`, { body: { password: 'nope' }, ip: '10.9.9.9' }));
    ok(hits.slice(0, 3).every((h) => h.status === 401) && hits[3].status === 429 && code(hits[3]) === 'rate_limited' && Number(hits[3].headers.get('retry-after')) >= 1, 'the unlock limiter answers 429 + Retry-After after the per-IP budget (10/15 min in production; 3 here)');
    ok((await api('POST', `/watch/${PWD}/unlock`, { body: { password: 'open-sesame' }, ip: '10.9.9.10' })).status === 200, 'another IP is unaffected');
    clock += 61 * 1000;
    ok((await api('POST', `/watch/${PWD}/unlock`, { body: { password: 'open-sesame' }, ip: '10.9.9.9' })).status === 200, 'the window resets with the clock');

    console.log('\nE. GET /watch/:id/media — signed URLs, TTL, download');
    if (!storageUp) { console.log('  SKIPPED E — no object storage'); } else {
      const mUnl = await seedMedia(UNL); const mPub = await seedMedia(PUB); await seedMedia(LOG); await seedMedia(PWD, { hls: false });
      const m = await api('GET', `/watch/${UNL}/media`);
      ok(m.status === 200 && m.body.status === 'ready' && m.body.mp4Url && m.body.posterUrl && m.body.captionsUrl && m.body.hlsUrl && m.body.ttlSeconds === 600, 'unlisted: mp4/poster/captions/hls URLs, 10-minute TTL');
      ok(near(new Date(m.body.expiresAt).getTime(), clock + 600 * 1000, 5000), 'expiresAt = now + TTL');
      ok(m.body.mp4Url.includes('X-Amz-Signature') && m.body.mp4Url.includes(encodeURI(mUnl.mp4Key)), 'the mp4 URL is a presigned URL bound to the exact object key');
      ok(!m.body.mp4Url.includes(mPub.mp4Key), 'URLs are minted per recording (no cross-recording key)');
      const fetched = await fetch(m.body.mp4Url);
      ok(fetched.status === 200 && Buffer.from(await fetched.arrayBuffer()).equals(MP4), 'the mp4 URL serves the exact object from storage');
      const cap = await fetch(m.body.captionsUrl);
      ok(cap.status === 200 && (cap.headers.get('content-type') || '').startsWith('text/vtt') && (await cap.text()) === VTT, 'the captions URL serves the VTT with text/vtt');
      ok((await fetch(m.body.posterUrl)).status === 200 && /X-Amz-Expires=86400/.test(m.body.posterUrl), 'the poster URL is fetchable and carries the 24 h TTL');
      ok(/X-Amz-Expires=600(&|$)/.test(m.body.mp4Url), 'the private-ish mp4 signature expires in 600 s');
      const mp = await api('GET', `/watch/${PUB}/media`);
      ok(mp.status === 200 && mp.body.ttlSeconds === 86400 && /X-Amz-Expires=86400/.test(mp.body.mp4Url) && !mp.body.hlsUrl.includes('?a='), 'public: 24 h TTL, and the HLS URL needs no token');
      ok(!m.body.hlsUrl.includes('?a=') && m.body.hlsUrl === `${base}/watch/${UNL}/hls/master.m3u8`, 'unlisted HLS: the master URL points at the API proxy; link access needs no playlist token');
      ok((await api('GET', `/watch/${LOG}/media`)).status === 401 && (await api('GET', `/watch/${PWD}/media`)).status === 403 && code(await api('GET', `/watch/${PWD}/media`)) === 'password_required', 'media is gated exactly like the payload: 401 login / 403 password');
      ok((await api('GET', `/watch/${PWD}/media`, { access: tokPwd })).status === 200 && (await api('GET', `/watch/${PWD}/media`, { access: tokPwd })).body.hlsUrl === null, 'the unlock token opens media; no HLS package → hlsUrl null');
      ok((await api('GET', `/watch/${LOG}/media`, { as: 'bob' })).body.ttlSeconds === 600, 'login-level media: 10 min');
      const dl = await api('GET', `/watch/${UNL}/media?disposition=attachment`);
      const dlRes = await fetch(dl.body.mp4Url);
      ok(dl.status === 200 && dl.body.hlsUrl === null && dlRes.status === 200 && (dlRes.headers.get('content-disposition') || '') === 'attachment; filename="My Video final v2.mp4"', 'disposition=attachment → the signed URL forces a download with a safe filename');
      await db.execute(sql`update recordings set audience = '{"download": false}'::jsonb where id = ${UNL}`);
      ok(code(await api('GET', `/watch/${UNL}/media?disposition=attachment`)) === 'audience_disabled' && (await api('GET', `/watch/${UNL}/media?disposition=attachment`, { as: 'alice' })).status === 200 && (await api('GET', `/watch/${UNL}/media`)).body.download === false, 'downloads off → 403 audience_disabled for viewers, still allowed for the owner');
      await db.execute(sql`update recordings set audience = '{}'::jsonb where id = ${UNL}`);
      const PROC = await mkRec('proc', { privacy: 'unlisted', status: 'processing' });
      const pm = await api('GET', `/watch/${PROC}/media`);
      ok(pm.status === 200 && pm.body.status === 'processing' && pm.body.mp4Url === null && pm.body.posterUrl === null, 'a processing recording answers honestly: status + null URLs (the page polls, never guesses)');
      ok(code(await api('GET', `/watch/${UNL}/media?s=${l4.token}`)) === 'link_expired', 'a dead link is dead for media too');

      console.log('\nF. HLS playlist proxy');
      const master = await api('GET', m.body.hlsUrl.slice(base.length));
      ok(master.status === 200 && (master.headers.get('content-type') || '').startsWith('application/vnd.apple.mpegurl') && master.headers.get('cache-control') === 'no-store', `the master playlist is served as application/vnd.apple.mpegurl, no-store [${master.status} ${master.headers.get('content-type')} ${JSON.stringify(master.body || master.text).slice(0, 200)}]`);
      const variantLine = (master.text || '').split('\n').find((l) => /240p_index\.m3u8/.test(l));
      ok(variantLine === `${base}/watch/${UNL}/hls/240p_index.m3u8`, 'variant playlists are rewritten to absolute proxy URLs (tokenless for link access)');
      const variant = await fetch(variantLine);
      const vtext = await variant.text();
      const initUrl = /#EXT-X-MAP:URI="([^"]+)"/.exec(vtext)[1];
      const segs = vtext.split('\n').filter((l) => l && !l.startsWith('#'));
      ok(variant.status === 200 && initUrl.includes('X-Amz-Signature') && segs.length === 2 && segs.every((s) => s.includes('X-Amz-Signature') && s.includes(`${MINIO.replace(/^https?:\/\//, '')}`)) && vtext.includes('#EXT-X-ENDLIST'), 'the variant playlist references presigned storage URLs for init + segments (the API serves no media bytes)');
      ok(Buffer.from(await (await fetch(initUrl)).arrayBuffer()).equals(INIT) && Buffer.from(await (await fetch(segs[0])).arrayBuffer()).equals(SEG1) && Buffer.from(await (await fetch(segs[1])).arrayBuffer()).equals(SEG2), 'init and both segments are fetchable byte-for-byte through the rewritten URLs');
      ok(/X-Amz-Expires=600/.test(segs[0]), 'segment signatures follow the media TTL');
      ok((await api('GET', `/watch/${UNL}/hls/240p_seg_00001.m4s`)).status === 404, 'the proxy refuses to serve segments (playlists only)');
      ok((await api('GET', `/watch/${UNL}/hls/..%2Fmaster.m3u8`)).status === 400 || (await api('GET', `/watch/${UNL}/hls/..%2Fmaster.m3u8`)).status === 404, 'a traversal-looking name is refused');
      ok((await api('GET', `/watch/${UNL}/hls/nope_index.m3u8`)).status === 404, 'an unknown playlist name → 404');
      const pubMaster = await api('GET', `/watch/${PUB}/hls/master.m3u8`);
      ok(pubMaster.status === 200 && pubMaster.text.includes(`${base}/watch/${PUB}/hls/240p_index.m3u8`) && !pubMaster.text.includes('?a='), 'public playlists need no token and link tokenless variant playlists');
      ok((await api('GET', `/watch/${LOG}/hls/master.m3u8`)).status === 401 && (await api('GET', `/watch/${LOG}/hls/master.m3u8`, { as: 'bob' })).status === 200, 'a gated playlist without a token falls back to the full resolver (401 anonymous, 200 signed in)');
      const lm = await api('GET', `/watch/${LOG}/media`, { as: 'bob' });
      const lmTok = lm.body.hlsUrl.split('?a=')[1];
      ok((await api('GET', `/watch/${LOG}/hls/master.m3u8?a=${lmTok}`)).status === 200, 'the playlist token from /media opens gated playlists without a Bearer (hls.js cannot send one)');
      ok(authz.verifyAccess(SECRET, decodeURIComponent(lmTok), { rec: LOG, now }).grants.join() === 'hls' && (await api('GET', `/watch/${LOG}/media`, { access: decodeURIComponent(lmTok) })).status === 401, 'that token carries only the hls grant — it does not unlock /media or the payload');
      clock += 601 * 1000;
      ok((await api('GET', `/watch/${LOG}/hls/master.m3u8?a=${lmTok}`)).status === 401, 'the playlist token expires with the media TTL');
      clock -= 601 * 1000;

      console.log('\nG. Transcript + lead gate');
      const t0 = await api('GET', `/watch/${UNL}/transcript`);
      ok(t0.status === 200 && t0.body.status === 'none' && t0.body.configured === true, 'no transcript → status none');
      const tr = await repos.transcripts.upsertSystem(UNL, { status: 'done', language: 'en', text: 'Hello world', source: 'groq' }, REASON);
      await rawTx((tx) => tx.transcripts.replaceSegmentsSystem(tr.id, [{ idx: 0, start: 0, end: 2, text: 'Hello', language: 'en' }, { idx: 1, start: 2, end: 4, text: 'world', language: 'en' }], REASON), db);
      const t1 = await api('GET', `/watch/${UNL}/transcript`);
      ok(t1.status === 200 && t1.body.status === 'done' && t1.body.segments.length === 2 && t1.body.segments[1].text === 'world' && t1.body.text === 'Hello world', 'a done transcript returns text + segments');
      await repos.transcripts.upsertSystem(LOG, { status: 'running', language: null }, REASON);
      ok((await api('GET', `/watch/${LOG}/transcript`)).status === 401 && (await api('GET', `/watch/${LOG}/transcript`, { as: 'bob' })).body.status === 'running', 'the transcript is gated like media and exposes the real status');
      await db.execute(sql`update recordings set audience = '{"transcript": false}'::jsonb where id = ${UNL}`);
      ok(code(await api('GET', `/watch/${UNL}/transcript`)) === 'audience_disabled' && (await api('GET', `/watch/${UNL}/transcript`, { as: 'alice' })).status === 200, 'audience.transcript=false hides it from viewers, not from the owner');
      await db.execute(sql`update recordings set audience = '{"requireEmail": true}'::jsonb where id = ${UNL}`);
      const gated = await api('GET', `/watch/${UNL}/media`);
      ok(gated.status === 403 && code(gated) === 'email_required' && (await api('GET', `/watch/${UNL}`)).body.requiresEmail === true && (await api('GET', `/watch/${UNL}`)).status === 200, 'requireEmail: the payload flags the gate, media is 403 email_required (server-side, not client-only)');
      ok((await api('GET', `/watch/${UNL}/media`, { as: 'alice' })).status === 200 && (await api('GET', `/watch/${UNL}/hls/master.m3u8`)).status === 403, 'the owner bypasses the gate; playlists are gated too');
      ok(code(await api('POST', `/watch/${UNL}/lead`, { body: { email: 'not-an-email' } })) === 'invalid_request', 'a lead needs a valid email');
      const lead = await api('POST', `/watch/${UNL}/lead`, { body: { email: `Viewer-${RUN}@Example.com`, name: 'V' } });
      ok(lead.status === 200 && lead.body.ok === true && lead.body.accessToken, 'submitting the email captures the lead and returns a token');
      const leads = await repos.leads.listForOwner({ userId: pg('alice') }, UNL);
      ok(leads.length === 1 && leads[0].email === `viewer-${RUN}@example.com` && (await api('POST', `/watch/${UNL}/lead`, { body: { email: `viewer-${RUN}@example.com` } })).status === 200 && (await repos.leads.listForOwner({ userId: pg('alice') }, UNL)).length === 1, 'leads are unique per (recording, email) — a re-submission is not an error');
      const after = await api('GET', `/watch/${UNL}/media`, { access: lead.body.accessToken });
      ok(after.status === 200 && after.body.mp4Url && after.body.hlsUrl.includes('?a=') && (await api('GET', `/watch/${UNL}`, { access: lead.body.accessToken })).body.requiresEmail === false, 'with the lead token media is minted and the playlist URL is tokenised (the gate holds for hls.js too)');
      ok((await api('GET', after.body.hlsUrl.slice(base.length))).status === 200, 'the playlist token minted behind the lead gate opens the master');
      await db.execute(sql`update recordings set audience = '{}'::jsonb where id = ${UNL}`);
    }
  } finally {
    server.close();
  }

  // ── H. Mounted on the legacy server behind the flag, real JWT viewer ─────
  console.log('\nH. Legacy server mount (V1_UPLOAD_API=true, real Bearer → viewer)');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't801-'));
  const PORT = '3281';
  const child = spawn(process.execPath, ['index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env, PORT, NODE_ENV: 'production', JWT_SECRET: 't801-jwt-secret-0123456789', DATA_DIR: dataDir, LOG_PRETTY: 'false', SENTRY_DSN: '',
      V1_UPLOAD_API: 'true', PG_DUAL_WRITE: 'true', APP_ENV: 'test', DATABASE_URL_TEST: env.databaseUrl, ADMIN_EMAILS: `admin-t801-${RUN}@example.com`,
      STORAGE_ENDPOINT: MINIO, STORAGE_BUCKET: 'veorec-media-test', STORAGE_PROVIDER: 'minio',
      STORAGE_ACCESS_KEY_ID: 'veorec_dev', STORAGE_SECRET_ACCESS_KEY: 'veorec_local_dev_secret', STORAGE_REGION: 'auto', STORAGE_FORCE_PATH_STYLE: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  const L = `http://127.0.0.1:${PORT}`;
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) { try { ready = (await fetch(`${L}/api/plans`)).ok; } catch {} if (!ready) await sleep(250); }
    ok(ready && /watch API ENABLED/.test(out), 'the legacy server boots with the watch router mounted');
    const signup = async (email) => (await (await fetch(`${L}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Owner T801', email, password: 'secret123' }) })).json());
    const ownerS = await signup(`owner-t801-${RUN}@example.com`);
    const viewerS = await signup(`viewer-t801-${RUN}@example.com`);
    const call = (tok, p, init = {}) => fetch(`${L}/api/v1${p}`, { ...init, headers: { ...(init.headers || {}), ...(tok ? { authorization: `Bearer ${tok}` } : {}) } });
    let mirrored = false;
    for (let i = 0; i < 40 && !mirrored; i += 1) { mirrored = (await call(ownerS.token, '/me/usage')).status === 200 && (await call(viewerS.token, '/me/usage')).status === 200; if (!mirrored) await sleep(250); }
    ok(mirrored, 'both signups reached PostgreSQL (dual-write)');
    const ownerPg = `usr_${ownerS.user.id}`;
    const LREC = `rec_t801_legacy_${RUN}`;
    await db.execute(sql`INSERT INTO recordings (id,user_id,title,status,source_kind,privacy) VALUES (${LREC}, ${ownerPg}, 'Mounted', 'processing', 'extension', 'login')`);
    const a1 = await call(null, `/watch/${LREC}`);
    ok(a1.status === 401 && (await a1.json()).error.code === 'login_required', 'mounted: anonymous on a login-only recording → 401 login_required (nested contract)');
    const a2 = await call(viewerS.token, `/watch/${LREC}`); const b2 = await a2.json();
    ok(a2.status === 200 && b2.viewer.isOwner === false && b2.author.name === 'Owner T801' && b2.status === 'processing', 'mounted: a real Bearer resolves through the canonical id mapping to a signed-in viewer');
    const a3 = await call(ownerS.token, `/watch/${LREC}`);
    ok(a3.status === 200 && (await a3.json()).viewer.isOwner === true, 'mounted: the owner is recognised');
    const bad = await call('not.a.jwt', `/watch/${LREC}`);
    ok(bad.status === 401 && (await bad.json()).error.code === 'login_required', 'mounted: an invalid Bearer is anonymous (the privacy level answers), never a token error');
    const m3 = await call(viewerS.token, `/watch/${LREC}/media`); const mb = await m3.json();
    ok(m3.status === 200 && mb.status === 'processing' && mb.mp4Url === null, 'mounted: /media answers the processing state with the real storage provider wired');
    ok((await fetch(`${L}/api/watch/${LREC}`)).status === 404, 'the legacy /api/watch route is untouched (this v1 id is unknown to it)');
    await db.execute(sql`delete from recordings where id = ${LREC}`);
  } finally {
    child.kill();
    await sleep(300);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // ── cleanup ────────────────────────────────────────────────────────────
  try { if (uploaded.length && storageUp) await provider.deleteObjects(uploaded); } catch {}
  await db.execute(sql`delete from users where id in (${pg('alice')}, ${pg('bob')}, ${pg('carol')})`).catch(() => {});
  await db.execute(sql`delete from users where email like ${`%t801-${RUN}@example.com`}`).catch(() => {});
  await pool.end().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
