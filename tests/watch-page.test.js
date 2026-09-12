// T-802 watch page refactor (run: cd server && npm run test:watch-page)
//
// A. The watch-page gate (rollout.js) and its public config route on a real
//    spawned legacy server — exact 'true' only, anonymous, no identifiers, the
//    KPI line. B. The client data layer (client/src/lib/watchApi.mjs) in node:
//    explicit states, the deterministic v1 → legacy fallback, gates, tokens,
//    refresh maths. C. Source-level client wiring: the legacy hacks are gone
//    (and guarded where they legitimately survive), alert() is gone, the
//    player wires hls.js / <track> / keyboard, nothing on the v1 path builds a
//    Cloudinary URL. The in-browser run (real Vite client + server + PostgreSQL
//    + MinIO) is recorded in docs/24 — Playwright is not part of this repo.
//
// A needs nothing but node; the spawned-server section SKIPS LOUDLY without
// PostgreSQL. WATCH_PAGE_TESTS_REQUIRED=1 makes a skip a failure.
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
const REQUIRED = process.env.WATCH_PAGE_TESTS_REQUIRED === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Math.random().toString(36).slice(2, 8);

(async () => {
  console.log('T-802 watch page tests');

  // ── A. The gate ──────────────────────────────────────────────────────────
  console.log('\nA. The watch-page gate (V1_WATCH_PAGE) and its public config');
  const on = { V1_UPLOAD_API: 'true', V1_WATCH_PAGE: 'true' };
  ok(rollout.watchPageEnabled(on) === true && rollout.decideWatch({ env: on }).path === 'v1', 'exact "true" + v1 API on → v1');
  for (const bad of ['TRUE', '1', 'yes', ' true', 'true ', '', undefined]) {
    ok(rollout.decideWatch({ env: { V1_UPLOAD_API: 'true', V1_WATCH_PAGE: bad } }).path === 'legacy', `V1_WATCH_PAGE=${JSON.stringify(bad)} → legacy`);
  }
  ok(rollout.decideWatch({ env: { V1_WATCH_PAGE: 'true' } }).path === 'legacy' && rollout.decideWatch({ env: { V1_WATCH_PAGE: 'true', V1_UPLOAD_API: 'TRUE' } }).path === 'legacy', 'the watch gate never opens while the v1 API is off (neither flag implies the other)');
  ok(rollout.decideWatch({ env: {} }).decision === 'watch_legacy_disabled' && rollout.decideWatch({ env: on }).decision === 'watch_v1_enabled', 'decisions are named');
  const pub = rollout.publicConfigBody(rollout.decideWatch({ env: on }));
  ok(pub.watch.path === 'v1' && pub.watch.v1Enabled === true && typeof pub.refreshAfterSeconds === 'number' && !('upload' in pub) && !('webUpload' in pub) && !JSON.stringify(pub).match(/user|bucket|id/i), 'the public body carries the watch decision only — no upload decisions, no identifiers');
  const full = rollout.clientConfigBody({ path: 'legacy' }, { path: 'legacy' }, rollout.decideWatch({ env: on }));
  ok(full.watch.path === 'v1' && full.upload.path === 'legacy' && full.webUpload.path === 'legacy', 'the authed client-config carries the watch decision as its own block, independent of the upload gates');
  ok(rollout.clientConfigBody({ path: 'legacy' }, { path: 'legacy' }).watch.path === 'legacy', 'omitting the watch decision means legacy');
  const lines = [];
  const kpi = createKpi({ info: (o, m) => lines.push({ o, m }), warn() {}, error() {}, child() { return this; } });
  kpi.watchDecision({ log: null }, rollout.decideWatch({ env: on }));
  kpi.watchDecision({ log: null }, rollout.decideWatch({ env: {} }));
  ok(kpi._counters.watchV1Selected === 1 && kpi._counters.watchLegacySelected === 1, 'KPI counters split v1 / legacy decisions');
  ok(lines.some((l) => l.o && l.o.kpi === 'watch_decision' && l.o.watch_path === 'v1' && l.o.decision === 'watch_v1_enabled') && !lines.some((l) => l.o && /user_id|userId/.test(JSON.stringify(l.o))), 'one watch_decision line per lookup, without a user identifier');
  kpi._stop();

  // ── B. The client data layer (node) ─────────────────────────────────────
  console.log('\nB. Client data layer (watchApi.mjs)');
  const lib = await import(`file:///${path.join(CLIENT_DIR, 'src', 'lib', 'watchApi.mjs').replace(/\\/g, '/')}`);
  ok(lib.stateFor(null) === 'loading' && lib.stateFor({ status: 'uploaded' }) === 'processing' && lib.stateFor({ status: 'processing' }) === 'processing' && lib.stateFor({ status: 'ready' }) === 'ready' && lib.stateFor({ status: 'failed' }) === 'failed' && lib.stateFor({ status: 'rejected_limit' }) === 'failed', 'page states come from the payload status (docs/11 §1)');
  ok(lib.stateFor({ status: 'ready', requiresPassword: true }) === 'password_gate' && lib.stateFor({ status: 'ready', requiresEmail: true }) === 'email_gate', 'gates take precedence over the status');
  ok(lib.pollDelay(0) === 2000 && lib.pollDelay(4) === 2000 && lib.pollDelay(5) === 5000 && lib.pollDelay(50) === 5000, 'status polling backs off 2 s → 5 s');
  const t0 = 1_800_000_000_000;
  ok(lib.shouldRefresh(new Date(t0 + 59_000).toISOString(), t0) && !lib.shouldRefresh(new Date(t0 + 61_000).toISOString(), t0) && lib.shouldRefresh(null, t0), 'refresh when expiresAt − now < 60 s (or unknown)');
  ok(lib.refreshDelay(new Date(t0 + 600_000).toISOString(), t0) === 540_000 && lib.refreshDelay(new Date(t0 + 10_000).toISOString(), t0) === 1000, 'the refresh timer fires 60 s before expiry, never sooner than 1 s');
  ok(lib.watchIsV1({ watch: { path: 'v1' } }) && !lib.watchIsV1({ watch: { path: 'legacy' } }) && !lib.watchIsV1(null) && !lib.watchIsV1({ watch: { v1Enabled: true } }), 'only an explicit watch.path === "v1" counts');
  ok((await lib.fetchWatchConfig({ API: '', fetchImpl: async () => { throw new Error('offline'); } })) === null && (await lib.fetchWatchConfig({ API: '', fetchImpl: async () => ({ ok: false }) })) === null, 'a failed config fetch resolves to null, i.e. legacy');

  const v1Payload = { id: 'rec_1', title: 'T', description: 'd', status: 'ready', duration: 12.5, privacy: 'unlisted', created_at: '2026-09-12T00:00:00.000Z', author: { name: 'Alice' }, branding: true, chapters: [{ t: 1, title: 'x' }], audience: {}, views: 3, viewer: { isOwner: true, isAdmin: false, via: 'owner', signedIn: true }, requiresEmail: false };
  const n1 = lib.normalizePayload(v1Payload, 'v1');
  ok(n1.source === 'v1' && n1.author === 'Alice' && n1.created_at === Date.parse('2026-09-12T00:00:00.000Z') && n1.viewer.isOwner === true && n1.views === 3 && n1.legacy === null && n1.chapters.length === 1, 'v1 payload → one page shape (author string, epoch created_at, explicit viewer)');
  const nl = lib.normalizePayload({ id: 'rec_L', title: 'L', cloudinary: true, filename: 'https://res.cloudinary.com/x/video/upload/v1/a.mp4', privacy: 'public', author: 'Bob', created_at: 5, audience: { download: true } }, 'legacy');
  ok(nl.source === 'legacy' && nl.status === 'ready' && nl.legacy.cloudinary === true && nl.author === 'Bob' && nl.viewer.isOwner === false, 'legacy payload → the same shape, status assumed ready (the legacy API has no status)');
  const lm = lib.legacyMedia(nl, '');
  ok(lm.mp4Url === nl.legacy.filename && lm.downloadUrl.includes('/upload/fl_attachment/') && lm.hlsUrl === null && lm.expiresAt === null, 'legacy media keeps the Cloudinary rule (fl_attachment download) — unchanged');
  ok(lib.legacyMedia(lib.normalizePayload({ id: 'x', filename: 'a.webm' }, 'legacy'), '').isWebm === true && lib.legacyMedia(n1, '') === null, 'legacy WebM is flagged for the guarded Infinity-duration workaround; v1 never is');

  // A scripted fetch: what the client asks for, in order.
  const calls = [];
  const mk = (routes) => async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {} });
    const u = new URL(url, 'http://x');
    const key = `${init.method || 'GET'} ${u.pathname}`;
    const r = routes[key] || routes['*'];
    const res = typeof r === 'function' ? r(u, init) : r;
    return { ok: res.status < 400, status: res.status, json: async () => res.body };
  };
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const nested = (status, code) => ({ status, body: { error: { code, message: code } } });

  let c = lib.createWatchClient({ API: '', id: 'rec_1', shareToken: 'tok', storage, fetchImpl: mk({ 'GET /api/v1/watch/rec_1': { status: 200, body: v1Payload } }) });
  let r = await c.load({ useV1: true });
  ok(r.rec && r.rec.source === 'v1' && calls.length === 1 && calls[0].url === '/api/v1/watch/rec_1?s=tok', 'v1 path: ONE request to /api/v1/watch/:id with ?s= for the share token');
  calls.length = 0;
  c = lib.createWatchClient({ API: '', id: 'rec_L', storage, fetchImpl: mk({ 'GET /api/v1/watch/rec_L': nested(404, 'recording_not_found'), 'GET /api/watch/rec_L': { status: 200, body: { id: 'rec_L', title: 'L', cloudinary: true, filename: 'https://c/upload/a.mp4' } } }) });
  r = await c.load({ useV1: true });
  ok(r.rec && r.rec.source === 'legacy' && calls.length === 2 && calls[0].url === '/api/v1/watch/rec_L' && calls[1].url === '/api/watch/rec_L', 'a recording unknown to v1 (404 recording_not_found) falls back to legacy ONCE — two requests, no retry loop');
  ok((await c.media({ rec: r.rec })).media.mp4Url === 'https://c/upload/a.mp4' && calls.length === 2, 'legacy media needs no request');
  calls.length = 0;
  c = lib.createWatchClient({ API: '', id: 'rec_2', storage, fetchImpl: mk({ 'GET /api/v1/watch/rec_2': nested(401, 'login_required') }) });
  r = await c.load({ useV1: true });
  ok(r.gate && r.gate.state === 'login_gate' && calls.length === 1, 'a v1 gate (401 login_required) is reported as a state and NEVER falls back to legacy');
  c = lib.createWatchClient({ API: '', id: 'rec_3', storage, fetchImpl: mk({ 'GET /api/v1/watch/rec_3': nested(403, 'link_expired') }) });
  ok((await c.load({ useV1: true })).gate.state === 'link_expired', '403 link_expired → link_expired state');
  c = lib.createWatchClient({ API: '', id: 'rec_4', storage, fetchImpl: mk({ 'GET /api/v1/watch/rec_4': { status: 200, body: { id: 'rec_4', title: 'P', requiresPassword: true } } }) });
  ok(lib.stateFor((await c.load({ useV1: true })).rec) === 'password_gate', 'the 200 password gate → password_gate state');
  calls.length = 0;
  c = lib.createWatchClient({ API: '', id: 'rec_5', storage, fetchImpl: mk({ 'GET /api/watch/rec_5': { status: 401, body: { error: 'login_required', title: 'x' } } }) });
  r = await c.load({ useV1: false });
  ok(r.gate && r.gate.state === 'login_gate' && calls.length === 1 && calls[0].url === '/api/watch/rec_5', 'legacy path (flag off): exactly the legacy request, its flat login gate understood');

  // Unlock → token → later requests carry it (header) and it survives in sessionStorage.
  calls.length = 0;
  c = lib.createWatchClient({ API: '', id: 'rec_6', storage, fetchImpl: mk({
    'GET /api/v1/watch/rec_6': (u, init) => (init.headers['X-Watch-Access'] === 'TOKEN' ? { status: 200, body: { ...v1Payload, id: 'rec_6' } } : { status: 200, body: { id: 'rec_6', title: 'P', requiresPassword: true } }),
    'POST /api/v1/watch/rec_6/unlock': (u, init) => (JSON.parse(init.body).password === 'pw' ? { status: 200, body: { ...v1Payload, id: 'rec_6', accessToken: 'TOKEN' } } : nested(401, 'invalid_password')),
    'GET /api/v1/watch/rec_6/media': (u, init) => (init.headers['X-Watch-Access'] === 'TOKEN' ? { status: 200, body: { status: 'ready', mp4Url: 'https://s/v.mp4?X-Amz', hlsUrl: null, posterUrl: null, captionsUrl: null, expiresAt: new Date(Date.now() + 600000).toISOString(), ttlSeconds: 600, download: true } } : nested(403, 'password_required')),
  }) });
  await c.load({ useV1: true });
  ok((await c.unlock('nope')).error && !c.accessToken, 'a wrong password is an error and mints nothing');
  r = await c.unlock('pw');
  ok(r.rec && c.accessToken === 'TOKEN' && store.get('veorec_watch_access_rec_6') === 'TOKEN', 'a correct password stores the access token for the session');
  ok((await c.media({ rec: r.rec })).media.mp4Url.startsWith('https://s/') && calls[calls.length - 1].headers['X-Watch-Access'] === 'TOKEN', 'later requests send X-Watch-Access');
  const c2 = lib.createWatchClient({ API: '', id: 'rec_6', storage, fetchImpl: mk({ 'GET /api/v1/watch/rec_6': (u, init) => (init.headers['X-Watch-Access'] === 'TOKEN' ? { status: 200, body: { ...v1Payload, id: 'rec_6' } } : { status: 200, body: { requiresPassword: true } }) }) });
  ok(lib.stateFor((await c2.load({ useV1: true })).rec) === 'ready', 'a new client for the same recording reloads the token (reload survives)');
  calls.length = 0;
  c = lib.createWatchClient({ API: '', id: 'rec_7', storage, fetchImpl: mk({ 'GET /api/v1/watch/rec_7/media': (u) => ({ status: 200, body: { status: 'ready', mp4Url: `m?${u.searchParams.get('disposition') || ''}`, download: true } }) }) });
  ok((await c.downloadUrl({ rec: n1 })) === 'm?attachment' && calls[0].url.includes('disposition=attachment'), 'the download URL is minted on demand with disposition=attachment');
  c = lib.createWatchClient({ API: '', id: 'rec_8', storage, fetchImpl: mk({ 'GET /api/v1/watch/rec_8/media': nested(403, 'email_required') }) });
  ok((await c.media({ rec: n1 })).gate.state === 'email_gate', 'a /media email gate is reported as a state (the server enforces it)');
  c = lib.createWatchClient({ API: '', id: 'rec_9', storage, fetchImpl: mk({ 'POST /api/v1/watch/rec_9/lead': { status: 200, body: { ok: true, accessToken: 'LEAD' } } }) });
  ok((await c.lead({ email: 'a@b.co', name: '' })).ok === true && c.accessToken === 'LEAD', 'the lead endpoint\'s token is kept like the unlock token');
  ok(lib.classifyPlaybackError({ mediaError: { code: 2 } }) === 'network' && lib.classifyPlaybackError({ mediaError: { code: 3 } }) === 'decode' && lib.classifyPlaybackError({ hlsError: { type: 'networkError', response: { code: 404 } } }) === 'removed', 'playback errors are classified per docs/11 §5');

  // ── C. Client wiring (source level) ─────────────────────────────────────
  console.log('\nC. Client wiring (source level)');
  const watch = fs.readFileSync(path.join(CLIENT_DIR, 'src', 'pages', 'Watch.jsx'), 'utf8');
  const watchCode = watch.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const player = fs.readFileSync(path.join(CLIENT_DIR, 'src', 'components', 'VideoPlayer.jsx'), 'utf8');
  const embed = fs.readFileSync(path.join(CLIENT_DIR, 'src', 'pages', 'Embed.jsx'), 'utf8');
  const main = fs.readFileSync(path.join(CLIENT_DIR, 'src', 'main.jsx'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(CLIENT_DIR, 'package.json'), 'utf8'));
  ok(!/setTimeout\(\(\) => loadVideo\(attempt \+ 1\), 1500\)/.test(watch) && !/attempt < 6/.test(watch), 'the 6×1.5 s 404 retry loop is gone');
  ok(!/setTimeout\(ready, 12000\)/.test(watchCode) || /if \(!isLegacy \|\| pageState !== 'ready'\)/.test(watchCode), 'the blind 12 s readiness timeout survives ONLY behind the legacy guard');
  ok(/isLegacy && !legacyVideoReady/.test(watch) && /if \(!isLegacy \|\| pageState !== 'ready'\) \{ setLegacyVideoReady\(true\); return; \}/.test(watch), 'the legacy readiness overlay is guarded by rec.source === "legacy"');
  ok(!/\balert\(/.test(watchCode), 'alert() is gone from the watch page');
  ok(/useToast\(\)/.test(watch) && /ToastProvider/.test(main), 'errors go through the toast provider');
  ok(/fetchWatchConfig\(\{ API \}\)/.test(watch) && /client\.load\(\{ useV1: watchIsV1\(cfg\) \}\)/.test(watch), 'the page asks the server which path to use and loads through the data layer');
  ok(!/\/api\/v1\/watch\//.test(watchCode) && !/\/api\/watch\/\$\{id\}`\)/.test(watchCode.replace(/\/api\/watch\/\$\{id\}\/(view|engagement|comment|react|progress)/g, '')), 'the page itself never builds a watch URL — the data layer does');
  ok(/useStatusPolling\(\{ client, rec, API, authHeaders, enabled: pageState === 'processing'/.test(watch) && /useWatchMedia\(\{ client, rec, enabled: pageState === 'ready' \}\)/.test(watch), 'status polling runs only while processing; media resolves only when ready');
  ok(/<ProcessingPanel /.test(watch) && /<FailedPanel /.test(watch) && /<PasswordGate /.test(watch) && /<LoginGate /.test(watch) && /<LinkExpiredPanel /.test(watch) && /<EmailGate /.test(watch) && /<NotFoundPanel /.test(watch), 'every docs/11 §1 state has an explicit panel');
  ok(/\/api\/v1\/recordings\/\$\{id\}\/reprocess/.test(watch), 'the owner Retry calls POST /recordings/:id/reprocess');
  ok(!/fl_attachment/.test(watchCode) && /fl_attachment/.test(fs.readFileSync(path.join(CLIENT_DIR, 'src', 'lib', 'watchApi.mjs'), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n').match(/legacyMedia[\s\S]*?\n\}/)[0]), 'the Cloudinary download rule lives ONLY in the legacy media resolver');
  ok(!/cloudinary/i.test(watchCode.replace(/source === 'legacy'|isLegacy|legacyMedia/g, '')), 'no Cloudinary logic on the watch page outside the legacy branch');
  ok(/engagementAvailable = isLegacy/.test(watch) && /engagementAvailable && playable && \(rec\.audience/.test(watch), 'engagement (views/comments/reactions) stays on the legacy API until Phase 10 and is hidden for v1 recordings');
  ok(/import Hls from 'hls\.js'/.test(player) && /Hls\.isSupported\(\)/.test(player) && /canPlayType\('application\/vnd\.apple\.mpegurl'\)/.test(player) && pkg.dependencies['hls.js'], 'the player uses hls.js with native HLS on Safari; hls.js is a client dependency');
  ok(/<track kind="captions" src=\{captionsUrl\}/.test(player) && /cc && !captionsUrl && captions\.length/.test(player), 'captions prefer a native <track>; the JS overlay is the fallback');
  ok(/legacyWebm && \(v\.duration === Infinity/.test(player), 'the Infinity-duration workaround is guarded behind legacyWebm');
  for (const key of ["k === ' ' || k === 'k'", "'ArrowLeft'", "'ArrowRight'", "k === 'j'", "k === 'l'", "'ArrowUp'", "'ArrowDown'", "k === 'm'", "k === 'f'", "k === 'c'", "/^[0-9]$/", "k === '>'", "k === '<'"]) ok(player.includes(key), `keyboard: ${key}`);
  ok(/isTyping\(e\.target\)/.test(player) && /tabIndex=\{0\} onKeyDown=\{onKey\}/.test(player), 'keys are bound on the player container and ignored while typing');
  ok(/setTimeout\(\(\) => setBuffering\(true\), 500\)/.test(player) && /barBuffered/.test(player), 'buffering spinner is debounced 500 ms; buffered ranges are drawn');
  ok(/resumeRef\.current = \{ t: v\.currentTime, playing: !v\.paused \}/.test(player) && /if \(resume\) v\.currentTime = resume\.t/.test(player), 'a refreshed src resumes at currentTime (seamless swap)');
  ok(/onNeedRefresh\('expired'\)/.test(player) && /setUseMp4\(true\)/.test(player) && /hls\.recoverMediaError\(\)/.test(player), 'expired URL → refresh; fatal HLS → MP4 fallback; media error → recover once');
  ok(/chapterTick/.test(player), 'chapter ticks on the progress bar');
  ok(/createWatchClient\(/.test(embed) && /useWatchMedia\(/.test(embed) && /useStatusPolling\(/.test(embed) && !/rec\.cloudinary \? rec\.filename/.test(embed), 'the embed shares the data layer and player');
  ok(/'X-Watch-Access'/.test(fs.readFileSync(path.join(CLIENT_DIR, 'src', 'lib', 'watchApi.mjs'), 'utf8')) && /veorec_watch_access_/.test(fs.readFileSync(path.join(CLIENT_DIR, 'src', 'lib', 'watchApi.mjs'), 'utf8')), 'the access token is sent as X-Watch-Access and kept per recording in sessionStorage');
  ok(/document\.title = /.test(watch) && /og:image/.test(watch) && /privacy === 'public' \|\| rec\.privacy === 'unlisted'/.test(watch), 'SEO meta: title always, og:image only for public/unlisted');
  const server = fs.readFileSync(path.join(SERVER_DIR, 'index.js'), 'utf8');
  ok(/app\.get\('\/api\/client-config\/public', \(req, res\)/.test(server) && !/app\.get\('\/api\/client-config\/public', requireAuth/.test(server), 'the public config route takes no auth');

  // ── D. The public route on a real spawned server ─────────────────────────
  console.log('\nD. Spawned legacy server: /api/client-config/public');
  const runServer = async (extraEnv) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't802-'));
    const PORT = String(3290 + Math.floor(Math.random() * 20));
    const child = spawn(process.execPath, ['index.js'], { cwd: SERVER_DIR, env: { ...process.env, PORT, NODE_ENV: 'production', JWT_SECRET: 't802-jwt-secret-0123456789', DATA_DIR: dataDir, LOG_PRETTY: 'false', SENTRY_DSN: '', V1_UPLOAD_API: 'false', V1_WATCH_PAGE: 'false', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (d) => { out += d.toString(); }); child.stderr.on('data', (d) => { out += d.toString(); });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) { try { ready = (await fetch(`http://127.0.0.1:${PORT}/api/plans`)).ok; } catch {} if (!ready) await sleep(250); }
    return { child, PORT, dataDir, out: () => out, ready, stop: async () => { child.kill(); await sleep(300); fs.rmSync(dataDir, { recursive: true, force: true }); } };
  };
  const s1 = await runServer({});
  try {
    ok(s1.ready, 'the legacy server boots with the gate OFF');
    const r1 = await fetch(`http://127.0.0.1:${s1.PORT}/api/client-config/public`);
    const b1 = await r1.json();
    ok(r1.status === 200 && b1.watch.path === 'legacy' && b1.watch.v1Enabled === false && r1.headers.get('cache-control') === 'no-store', 'gate OFF: anonymous 200 {watch:{path:"legacy"}}, no-store');
    ok((await fetch(`http://127.0.0.1:${s1.PORT}/api/client-config`)).status === 401, 'the authed client-config still requires a Bearer');
    ok(/"kpi":"watch_decision"/.test(s1.out()) && /"decision":"watch_legacy_disabled"/.test(s1.out()), 'the KPI line is logged');
  } finally { await s1.stop(); }
  let pgUp = false;
  try { const { loadEnv, createPool } = require(path.join(ROOT, 'db', 'src', 'index.js')); const env = loadEnv({ appEnv: 'test' }); const pool = createPool({ env, max: 1 }); await pool.query('select 1'); pgUp = true; await pool.end(); process.env.__T802_DB = env.databaseUrl; } catch {}
  if (!pgUp) {
    console.log('  SKIPPED gate-ON server (PostgreSQL unreachable — V1_UPLOAD_API needs it)');
    if (REQUIRED) { fail += 1; console.log('  FAIL: WATCH_PAGE_TESTS_REQUIRED=1 but PostgreSQL is unavailable'); }
  } else {
    const s2 = await runServer({ V1_UPLOAD_API: 'true', V1_WATCH_PAGE: 'true', APP_ENV: 'test', DATABASE_URL_TEST: process.env.__T802_DB, PG_DUAL_WRITE: 'true', STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100', STORAGE_BUCKET: 'veorec-media-test', STORAGE_PROVIDER: 'minio', STORAGE_ACCESS_KEY_ID: 'veorec_dev', STORAGE_SECRET_ACCESS_KEY: 'veorec_local_dev_secret', STORAGE_REGION: 'auto', STORAGE_FORCE_PATH_STYLE: 'true' });
    try {
      ok(s2.ready, 'the legacy server boots with the gate ON');
      const r2 = await fetch(`http://127.0.0.1:${s2.PORT}/api/client-config/public`);
      const b2 = await r2.json();
      ok(r2.status === 200 && b2.watch.path === 'v1' && b2.watch.v1Enabled === true, 'gate ON: anonymous 200 {watch:{path:"v1"}}');
      ok(!JSON.stringify(b2).includes('upload'), 'the public body never carries the upload decisions');
      const s3 = await runServer({ V1_UPLOAD_API: 'true', V1_WATCH_PAGE: 'TRUE', APP_ENV: 'test', DATABASE_URL_TEST: process.env.__T802_DB, STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100', STORAGE_BUCKET: 'veorec-media-test', STORAGE_PROVIDER: 'minio', STORAGE_ACCESS_KEY_ID: 'veorec_dev', STORAGE_SECRET_ACCESS_KEY: 'veorec_local_dev_secret', STORAGE_REGION: 'auto', STORAGE_FORCE_PATH_STYLE: 'true' });
      try {
        const r3 = await fetch(`http://127.0.0.1:${s3.PORT}/api/client-config/public`);
        ok((await r3.json()).watch.path === 'legacy', 'a wrong-case V1_WATCH_PAGE leaves the page on legacy (config-only rollback)');
      } finally { await s3.stop(); }
      const signup = await (await fetch(`http://127.0.0.1:${s2.PORT}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'T', email: `t802-${RUN}@example.com`, password: 'secret123' }) })).json();
      const cfg = await (await fetch(`http://127.0.0.1:${s2.PORT}/api/client-config`, { headers: { authorization: `Bearer ${signup.token}` } })).json();
      ok(cfg.watch && cfg.watch.path === 'v1' && cfg.upload && cfg.webUpload, 'the authed client-config carries the same watch decision beside the upload gates');
    } finally { await s2.stop(); }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
