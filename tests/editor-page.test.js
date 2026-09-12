// T-1201 editor page on v1 (run: cd server && npm run test:editor-page)
//
// A. The editor gate (V1_EDITOR) and its block on the authed client-config,
//    with the mirror rule, KPI counters. B. The client data layer
//    (client/src/lib/editorApi.mjs) in node with a scripted fetch: gate
//    reading, timeline helpers, the v1 flow (detail → session → render →
//    progress polling → done/failed), the legacy flow (trim/compose exactly as
//    before), the virtual save, silence removal (202 + poll) on both paths,
//    stitch, paywalls surfaced as data. C. Source-level wiring of Editor.jsx
//    and Watch.jsx: every editing call goes through the data layer (no page
//    builds a /trim, /compose or /stitch URL), undo/redo, the real progress
//    bar, the stale-load guard kept, "coming soon" stubs gone. D. A spawned
//    legacy server with a mirrored signup: the editor block flips to v1 and
//    the mounted routes answer.
//
// The spawned-server section SKIPS LOUDLY without PostgreSQL;
// EDITOR_PAGE_TESTS_REQUIRED=1 makes a skip a failure.
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
const REQUIRED = process.env.EDITOR_PAGE_TESTS_REQUIRED === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Math.random().toString(36).slice(2, 8);

(async () => {
  console.log('T-1201 editor page tests');

  console.log('\nA. The editor gate (V1_EDITOR) and the authed client-config');
  const on = { V1_UPLOAD_API: 'true', V1_EDITOR: 'true' };
  ok(rollout.editorEnabled(on) === true && rollout.decideEditor({ env: on }).path === 'v1' && rollout.decideEditor({ env: on }).decision === 'editor_v1_enabled', 'exact "true" + v1 API on → v1');
  for (const bad of ['TRUE', '1', 'yes', ' true', '', undefined]) ok(rollout.decideEditor({ env: { V1_UPLOAD_API: 'true', V1_EDITOR: bad } }).path === 'legacy', `V1_EDITOR=${JSON.stringify(bad)} → legacy`);
  ok(rollout.decideEditor({ env: { V1_EDITOR: 'true' } }).path === 'legacy', 'never opens while the v1 API is off');
  ok(rollout.decideEditor({ env: on, hasPostgresMirror: false }).decision === 'account_not_migrated' && rollout.decideEditor({ env: on, hasPostgresMirror: false }).path === 'legacy' && rollout.decideEditor({ env: on, hasPostgresMirror: true }).path === 'v1', 'an unmirrored account is told legacy under its own reason');
  const body = rollout.clientConfigBody({ path: 'legacy' }, { path: 'legacy' }, { path: 'legacy' }, { path: 'legacy' }, rollout.decideEditor({ env: on }));
  ok(body.editor.path === 'v1' && body.editor.v1Enabled === true && body.library.path === 'legacy' && body.upload.path === 'legacy' && body.webUpload.path === 'legacy' && body.watch.path === 'legacy', 'the editor block is independent of the other four gates');
  ok(rollout.clientConfigBody({ path: 'legacy' }).editor.path === 'legacy' && !('editor' in rollout.publicConfigBody(rollout.decideWatch({ env: {} }))), 'omitted → legacy; the PUBLIC config never carries the editor decision');
  ok(!/secret|token|password|usr_/i.test(JSON.stringify(body)), 'the body exposes no secrets and no identifiers');
  const lines = [];
  const kpi = createKpi({ info: (o) => lines.push(o), warn() {}, error() {}, child() { return this; } });
  kpi.editorDecision({}, rollout.decideEditor({ env: on }));
  kpi.editorDecision({}, rollout.decideEditor({ env: on, hasPostgresMirror: false }));
  ok(kpi._counters.editorV1Selected === 1 && kpi._counters.editorLegacySelected === 1 && kpi._counters.editorAccountNotMigrated === 1 && lines.some((o) => o.kpi === 'editor_decision' && o.editor_path === 'v1'), 'KPI counters and the editor_decision line');
  kpi._stop();

  console.log('\nB. Client data layer (editorApi.mjs)');
  const E = await import(`file:///${path.join(CLIENT_DIR, 'src', 'lib', 'editorApi.mjs').replace(/\\/g, '/')}`);
  ok(E.editorIsV1({ editor: { path: 'v1' } }) && !E.editorIsV1({ editor: { v1Enabled: true } }) && !E.editorIsV1({ library: { path: 'v1' } }) && !E.editorIsV1(null), 'only an explicit editor.path === "v1" counts');
  ok(JSON.stringify(E.timelineFromRecording({ id: 'r', duration: 30 })) === '[{"recordingId":"r","start":0,"end":30}]' && JSON.stringify(E.timelineFromRecording({ id: 'r', duration: 30, trimStart: 2, trimEnd: 10 })) === '[{"recordingId":"r","start":2,"end":10}]' && JSON.stringify(E.timelineFromRecording({ id: 'r', duration: 30, segments: [{ start: 1, end: 4.0004 }, { start: 8, end: 9 }] })) === '[{"recordingId":"r","start":1,"end":4},{"recordingId":"r","start":8,"end":9}]', 'the initial timeline honours segments, else trims, else the whole video (3-decimal rounding)');
  ok(JSON.stringify(E.clipsToTimeline([{ id: 'a', in: 0.12345, out: 3 }, { id: 'b', in: 1, out: 2 }])) === '[{"recordingId":"a","start":0.123,"end":3},{"recordingId":"b","start":1,"end":2}]', 'clips → the API timeline');
  const R = { id: 'a', duration: 30 };
  ok(E.isFullLength([{ id: 'a', in: 0, out: 30 }], R) && E.isFullLength([{ id: 'a', in: 0.04, out: 29.96 }], R) && !E.isFullLength([{ id: 'a', in: 1, out: 30 }], R) && !E.isFullLength([{ id: 'a', in: 0, out: 30 }, { id: 'a', in: 0, out: 1 }], R) && !E.isFullLength([{ id: 'b', in: 0, out: 30 }], R), 'full length = one base clip spanning the video (±50 ms)');
  ok(E.isSingleSource([{ id: 'a' }, { id: 'a' }], 'a') && !E.isSingleSource([{ id: 'a' }, { id: 'b' }], 'a') && !E.isSingleSource([], 'a'), 'single source = every clip is the base');
  const nd = E.normalizeDetail({ id: 'rec_1', title: 'T', status: 'ready', duration: '12.5', mediaUrl: 'https://s/mp4?sig', playbackUrl: 'https://s/src?sig', segments: [{ start: 0, end: 2 }], trimStart: null, trimEnd: 5, canStitch: true }, { useV1: true });
  ok(nd.source === 'v1' && nd.filename === 'https://s/mp4?sig' && nd.duration === 12.5 && nd.segments.length === 1 && nd.trimEnd === 5 && nd.ready === true && nd.canStitch === true, 'a v1 detail → the editor shape: the ACTIVE media (mediaUrl) is the preview');
  ok(E.normalizeDetail({ id: 'x', playbackUrl: 'src' }, { useV1: true }).filename === 'src' && E.normalizeDetail({ id: 'y', filename: 'https://c/v.webm', canStitch: false }, { useV1: false }).source === 'legacy' && E.normalizeDetail({ id: 'y', filename: 'f', canStitch: false }, { useV1: false }).canStitch === false, 'no MP4 yet → the source; a legacy detail is tagged and otherwise untouched');
  ok(E.normalizeGalleryItem({ id: 'g', title: 'G', duration: 3, thumbnailUrl: 't', status: 'ready' }).filename === null && E.normalizeGalleryItem({ id: 'g', posterUrl: 'p' }).thumbnail === 'p', 'a v1 gallery row has no full-file URL (poster only)');
  ok(E.errorOf({ error: { code: 'feature_locked', message: 'Pro', upgradeRequired: true } }).upgradeRequired === true && E.errorOf({ error: { code: 'feature_locked', message: 'Pro', upgradeRequired: true } }).code === 'feature_locked' && E.errorOf({ error: 'legacy text', code: 'x' }).error === 'legacy text' && E.errorOf(null, 'fb').error === 'fb', 'nested v1 errors and legacy string errors → one shape');
  ok(E.pollDelay(0) === 1500 && E.pollDelay(6) === 3000 && E.pollDelay(100) === 3000, 'poll delay 1.5 s → 3 s');
  ok(/nothing to trim/.test(E.friendlySilenceError('no_silence: x')) && /Transcribe/.test(E.friendlySilenceError('no_speech')) && /failed/.test(E.friendlySilenceError('boom')), 'terminal silence reasons are explained');

  // A scripted fetch: [method, url-regex, handler(body) → {status, json}].
  const calls = [];
  const mk = (routes) => async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url, body });
    for (const [m, re, h] of routes) if (m === method && re.test(url)) { const r = h(body, url); return { ok: r.status < 400, status: r.status, json: async () => r.json }; }
    return { ok: false, status: 404, json: async () => ({ error: { code: 'not_found', message: 'nope' } }) };
  };
  const noSleep = async () => {};
  // v1 flow
  let renderPolls = 0;
  const v1 = E.createEditorClient({ API: 'http://api', useV1: true, sleep: noSleep, authFetch: mk([
    ['GET', /\/api\/v1\/recordings\/rec_a$/, () => ({ status: 200, json: { id: 'rec_a', title: 'A', status: 'ready', duration: 30, mediaUrl: 'm', playbackUrl: 'p', segments: null } })],
    ['GET', /\/api\/v1\/recordings\?limit=100&archived=false$/, () => ({ status: 200, json: { items: [{ id: 'rec_a', title: 'A', status: 'ready' }, { id: 'rec_b', title: 'B', status: 'ready', duration: 5, thumbnailUrl: 't' }, { id: 'rec_c', title: 'C', status: 'processing' }] } })],
    ['PATCH', /\/api\/v1\/recordings\/rec_a\/meta$/, () => ({ status: 200, json: { ok: true } })],
    ['POST', /\/api\/v1\/recordings\/rec_a\/edit-sessions$/, (b) => ({ status: 201, json: { editSessionId: 'eds_1', status: 'draft', timeline: b.timeline } })],
    ['POST', /\/api\/v1\/edit-sessions\/eds_1\/render$/, (b) => (b.mode === 'copy' ? { status: 202, json: { renderJobId: 'rnd_1', outputRecordingId: 'rec_out' } } : { status: 202, json: { renderJobId: 'rnd_2' } })],
    ['GET', /\/api\/v1\/render-jobs\/rnd_1$/, () => { renderPolls += 1; return renderPolls < 3 ? { status: 200, json: { status: 'running', progress: renderPolls * 40 } } : { status: 200, json: { status: 'done', progress: 100, outputRecordingId: 'rec_out' } }; }],
    ['GET', /\/api\/v1\/render-jobs\/rnd_2$/, () => ({ status: 200, json: { status: 'failed', progress: 0, error: 'render_ffmpeg_failed: boom' } })],
    ['POST', /\/api\/v1\/recordings\/rec_a\/remove-silences$/, () => ({ status: 202, json: { jobId: 'job_s', status: 'queued' } })],
    ['GET', /\/api\/v1\/recordings\/rec_a\/remove-silences$/, () => (calls.filter((c) => c.method === 'GET' && /remove-silences/.test(c.url)).length < 2 ? { status: 200, json: { jobId: 'job_s', status: 'active', result: null, error: null } } : { status: 200, json: { jobId: 'job_s', status: 'completed', result: { segments: [{ start: 0, end: 4 }], keptSeconds: 4, removedSeconds: 2, method: 'audio' } } })],
    ['POST', /\/api\/v1\/recordings\/stitch$/, (b) => (b.ids.length === 2 ? { status: 202, json: { editSessionId: 'eds_s', renderJobId: 'rnd_s', outputRecordingId: 'rec_st' } } : { status: 403, json: { error: { code: 'feature_locked', message: 'Combining clips is a Pro feature.', upgradeRequired: true } } })],
  ]) });
  const loaded = await v1.loadRecording('rec_a');
  ok(loaded.rec && loaded.rec.source === 'v1' && loaded.rec.filename === 'm', 'v1: the detail comes from /api/v1/recordings/:id');
  const gal = await v1.listGallery('rec_a');
  ok(gal.length === 1 && gal[0].id === 'rec_b' && gal[0].thumbnail === 't' && gal[0].filename === null, 'v1: the gallery lists other READY recordings only');
  ok((await v1.saveVirtual('rec_a', { segments: [{ start: 0, end: 2 }], trimStart: null, trimEnd: null })).ok === true && calls.some((c) => c.method === 'PATCH' && /rec_a\/meta$/.test(c.url) && c.body.segments.length === 1), 'v1: the instant save is PATCH /meta with segments');
  const clips = [{ id: 'rec_a', in: 0, out: 2.5 }, { id: 'rec_b', in: 1, out: 3 }];
  const started = await v1.startRender({ recordingId: 'rec_a', clips, mode: 'copy' });
  const sess = calls.find((c) => c.method === 'POST' && /edit-sessions$/.test(c.url));
  ok(started.renderJobId === 'rnd_1' && started.outputRecordingId === 'rec_out' && started.editSessionId === 'eds_1' && sess.body.timeline.length === 2 && sess.body.timeline[1].recordingId === 'rec_b' && calls.some((c) => /eds_1\/render$/.test(c.url) && c.body.mode === 'copy'), 'v1: save = edit session (the timeline) → render (the mode) → 202 with the job and the output id');
  const pcts = [];
  const done = await v1.waitForRender('rnd_1', { onProgress: (p) => pcts.push(p) });
  ok(done.status === 'done' && done.outputRecordingId === 'rec_out' && JSON.stringify(pcts) === '[40,80,100]', 'v1: the progress bar is the job\'s real progress, polled until done');
  const failed = await v1.startRender({ recordingId: 'rec_a', clips: [{ id: 'rec_a', in: 0, out: 2 }], mode: 'overwrite' });
  const fj = await v1.waitForRender(failed.renderJobId);
  ok(fj.status === 'failed' && /ffmpeg/.test(fj.error), 'v1: a failed render reports its reason (the draft is kept server-side)');
  const ac = new AbortController(); ac.abort();
  ok((await v1.waitForRender('rnd_1', { signal: ac.signal })).status === 'aborted', 'an aborted wait stops polling (the render continues in the worker)');
  const sil = await v1.removeSilences('rec_a');
  ok(sil.segments && sil.segments.length === 1 && sil.removedSeconds === 2 && sil.method === 'audio' && calls.filter((c) => c.method === 'GET' && /rec_a\/remove-silences$/.test(c.url)).length === 2, 'v1: silence removal = POST (202) then poll GET until the worker\'s result');
  ok((await v1.stitch(['rec_a', 'rec_b'])).outputRecordingId === 'rec_st' && (await v1.stitch(['rec_a', 'rec_b', 'rec_c'])).code === 'feature_locked' && (await v1.stitch(['rec_a', 'rec_b', 'rec_c'])).upgradeRequired === true, 'v1: stitch → the copy render\'s output; a paywall comes back as data');
  ok(!calls.some((c) => /\/api\/recordings\//.test(c.url) && !/\/api\/v1\//.test(c.url)), 'v1: no legacy route was touched');
  // legacy flow — byte-identical requests
  calls.length = 0;
  const legacy = E.createEditorClient({ API: 'http://api', useV1: false, sleep: noSleep, authFetch: mk([
    ['GET', /\/api\/recordings\/rec_a$/, () => ({ status: 200, json: { id: 'rec_a', title: 'A', duration: 30, filename: 'https://c/v.webm', canStitch: false } })],
    ['GET', /\/api\/recordings$/, () => ({ status: 200, json: [{ id: 'rec_a' }, { id: 'rec_b', filename: 'f' }] })],
    ['POST', /\/api\/recordings\/rec_a\/trim$/, (b) => ({ status: 200, json: { ok: true, segments: b.segments } })],
    ['POST', /\/api\/recordings\/rec_a\/compose$/, () => ({ status: 403, json: { code: 'feature_locked', error: 'Pro only', upgradeRequired: true } })],
    ['POST', /\/api\/recordings\/rec_a\/remove-silences$/, () => ({ status: 200, json: { segments: [{ start: 0, end: 1 }], keptSeconds: 1, removedSeconds: 3 } })],
    ['POST', /\/api\/recordings\/stitch$/, () => ({ status: 200, json: { id: 'rec_new' } })],
  ]) });
  ok((await legacy.loadRecording('rec_a')).rec.source === 'legacy' && (await legacy.loadRecording('rec_a')).rec.canStitch === false && (await legacy.listGallery('rec_a')).length === 1, 'legacy: the detail and the list as before');
  const lt = await legacy.startRender({ recordingId: 'rec_a', clips: [{ id: 'rec_a', in: 1, out: 2 }], mode: 'copy' });
  ok(lt.done === true && lt.id === 'rec_a' && calls.some((c) => /\/trim$/.test(c.url) && c.body.mode === 'copy' && c.body.segments[0].start === 1), 'legacy: a single-source save is POST /trim {segments, mode}');
  const lc = await legacy.startRender({ recordingId: 'rec_a', clips: [{ id: 'rec_a', in: 0, out: 2 }, { id: 'rec_b', in: 0, out: 1 }], mode: 'overwrite' });
  ok(lc.code === 'feature_locked' && lc.upgradeRequired === true && calls.some((c) => /\/compose$/.test(c.url) && c.body.clips.length === 2), 'legacy: a multi-source save is POST /compose {clips, mode}; its paywall is surfaced');
  ok((await legacy.removeSilences('rec_a')).removedSeconds === 3 && (await legacy.stitch(['rec_a', 'rec_b'])).id === 'rec_new', 'legacy: synchronous silence removal and stitch');
  ok(!calls.some((c) => /\/api\/v1\//.test(c.url)), 'legacy: no v1 route was touched');

  console.log('\nC. Source-level wiring (Editor.jsx / Watch.jsx / server)');
  const editor = fs.readFileSync(path.join(CLIENT_DIR, 'src', 'pages', 'Editor.jsx'), 'utf8');
  const watch = fs.readFileSync(path.join(CLIENT_DIR, 'src', 'pages', 'Watch.jsx'), 'utf8');
  const hook = fs.readFileSync(path.join(CLIENT_DIR, 'src', 'hooks', 'useEditorClient.js'), 'utf8');
  ok(/useEditorClient\(\)/.test(editor) && /editorIsV1\(cfg\)/.test(hook) && /fetchClientConfig\(\{ API, authFetch \}\)/.test(hook), 'the editor binds to the server\'s editor decision once per page load');
  ok(!/\/compose`|\/trim`|\/api\/recordings\/\$\{id\}`\)/.test(editor) && /client\.startRender\(/.test(editor) && /client\.saveVirtual\(/.test(editor) && /client\.loadRecording\(/.test(editor) && /client\.listGallery\(/.test(editor) && /client\.removeSilences\(/.test(editor), 'Editor.jsx builds no trim/compose/detail URL — every editing call goes through the data layer');
  ok(/client\.waitForRender\(r\.renderJobId, \{ onProgress: \(p\) => setProgress\(p \/ 100\)/.test(editor) && /setIndeterminate\(false\)/.test(editor), 'the render overlay shows the job\'s real progress');
  ok(/function undo\(\)/.test(editor) && /function redo\(\)/.test(editor) && /<Undo2 size=\{15\} \/> Undo/.test(editor) && /<Redo2 size=\{15\} \/> Redo/.test(editor) && /function commit\(next\)/.test(editor), 'op-based undo / redo over the timeline');
  ok(/if \(v\.src !== c\.src\) \{ v\.src = c\.src; v\.onloadeddata = \(\) => \{ if \(loadedKey\.current === c\.key\)/.test(editor), 'the stale-load guard is kept (docs/14 §6)');
  ok(/doSave\('virtual'\)/.test(editor) && /Save instantly/.test(editor) && /saveKind === 'single'/.test(editor) && /modeHint/.test(editor), 'a single-source timeline offers the instant (virtual) save beside the bake; the mode is shown');
  ok(/r\.code === 'feature_locked' \|\| r\.upgradeRequired/.test(editor) && /render_in_progress/.test(editor) && /Continue in background/.test(editor), 'paywalls, a running render and leaving the page are handled honestly');
  ok(!/alert\(/.test(editor), 'alert() is gone from the editor');
  ok(!/Silence removal is coming to migrated recordings soon/.test(watch) && !/Combining is coming to migrated recordings soon/.test(watch) && /editorClient\.removeSilences\(id\)/.test(watch) && /editorClient\.stitch\(\[id, \.\.\.pickedIds\]\)/.test(watch) && /editorClient\.listGallery\(id\)/.test(watch), 'the watch page\'s silence removal and combine work for v1 recordings through the data layer');
  ok(!/`\$\{API\}\/api\/recordings\/stitch`/.test(watch) && !/`\$\{API\}\/api\/recordings\/\$\{id\}\/remove-silences`/.test(watch), 'the watch page builds no stitch / remove-silences URL itself');
  const server = fs.readFileSync(path.join(SERVER_DIR, 'index.js'), 'utf8');
  ok(/rollout\.editorEnabled\(\)/.test(server) && /kpi\.editorDecision\(req, editor\)/.test(server) && /rollout\.clientConfigBody\(decision, web, rollout\.decideWatch\(\), library, editor\)/.test(server), 'the server decides the editor gate with the mirror rule and reports it');
  const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  ok(/# V1_EDITOR=false/.test(envExample), '.env.example documents V1_EDITOR (off by default)');

  console.log('\nD. Spawned legacy server: the editor block with the mirror rule');
  let dbUrl = null;
  try { const { loadEnv, createPool } = require(path.join(ROOT, 'db', 'src', 'index.js')); const env = loadEnv({ appEnv: 'test' }); const pool = createPool({ env, max: 1 }); await pool.query('select 1'); dbUrl = env.databaseUrl; await pool.end(); } catch {}
  if (!dbUrl) {
    console.log('  SKIPPED D — PostgreSQL unreachable');
    if (REQUIRED) { fail += 1; console.log('  FAIL: EDITOR_PAGE_TESTS_REQUIRED=1 but PostgreSQL is unavailable'); }
  } else {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't1201-'));
    const PORT = String(3340 + Math.floor(Math.random() * 20));
    const child = spawn(process.execPath, ['index.js'], { cwd: SERVER_DIR, env: { ...process.env, PORT, NODE_ENV: 'production', JWT_SECRET: 't1201-jwt-secret-0123456789', DATA_DIR: dataDir, LOG_PRETTY: 'false', SENTRY_DSN: '', V1_UPLOAD_API: 'true', V1_EDITOR: 'true', PG_DUAL_WRITE: 'true', APP_ENV: 'test', DATABASE_URL_TEST: dbUrl, STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100', STORAGE_BUCKET: 'veorec-media-test', STORAGE_PROVIDER: 'minio', STORAGE_ACCESS_KEY_ID: 'veorec_dev', STORAGE_SECRET_ACCESS_KEY: 'veorec_local_dev_secret', STORAGE_REGION: 'auto', STORAGE_FORCE_PATH_STYLE: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (d) => { out += d.toString(); }); child.stderr.on('data', (d) => { out += d.toString(); });
    try {
      let ready = false;
      for (let i = 0; i < 60 && !ready; i += 1) { try { ready = (await fetch(`http://127.0.0.1:${PORT}/api/plans`)).ok; } catch {} if (!ready) await sleep(250); }
      ok(ready, 'the legacy server boots with V1_EDITOR=true');
      const L = `http://127.0.0.1:${PORT}`;
      const signup = await (await fetch(`${L}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'T', email: `t1201-${RUN}@example.com`, password: 'secret123' }) })).json();
      const call = (p, init = {}) => fetch(`${L}/api/v1${p}`, { ...init, headers: { authorization: `Bearer ${signup.token}`, 'content-type': 'application/json', ...(init.headers || {}) } });
      let cfg = null;
      for (let i = 0; i < 40; i += 1) { cfg = await (await fetch(`${L}/api/client-config`, { headers: { authorization: `Bearer ${signup.token}` } })).json(); if (cfg.editor && cfg.editor.path === 'v1') break; await sleep(250); }
      ok(cfg.editor && cfg.editor.path === 'v1' && cfg.library.path === 'legacy', 'once the signup is mirrored, the authed client-config says editor v1 (the library gate stays off)');
      ok((await call('/recordings/rec_nope/edit-sessions', { method: 'POST', body: '{}' })).status === 404 && (await call('/render-jobs/rnd_nope')).status === 404 && (await call('/recordings/rec_nope/remove-silences')).status === 404, 'mounted: the editing routes answer on the v1 flag');
      const stitch = await call('/recordings/stitch', { method: 'POST', body: JSON.stringify({ ids: ['a'] }) });
      ok(stitch.status === 400 && (await stitch.json()).error.code === 'invalid_request', 'mounted: stitch validates its input');
      ok(/"kpi":"editor_decision"/.test(out) && /"decision":"editor_v1_enabled"/.test(out), 'the KPI line is logged');
    } finally { child.kill(); await sleep(300); fs.rmSync(dataDir, { recursive: true, force: true }); }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
