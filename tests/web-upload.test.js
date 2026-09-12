// T-305 web upload path tests (run: cd server && npm run test:web)
//
// Part A — the dedicated web gate: pure, deterministic, no infrastructure.
//          Its whole job is to be OFF unless told otherwise, and to be
//          independent of the extension rollout in BOTH directions.
// Part B — telemetry: the deprecation counter for the memory-multer route and
//          the web single-PUT slice of the v1 numbers.
// Part C — the client wiring, asserted at source level: the legacy editor path
//          is byte-for-byte still there, no file bytes ever go to /api, and the
//          fallback boundary sits exactly at session creation.
// Part D — a real spawned server (PostgreSQL required): /client-config's web
//          decision, the 409 clip_not_composable answer, the deprecated replace
//          route still working AND being counted, and config-only rollback.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'server');
const DB_DIR = path.join(ROOT, 'db');
const CLIENT_DIR = path.join(ROOT, 'client');
const R = require(path.join(SERVER_DIR, 'rollout.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REQUIRED = process.env.WEB_UPLOAD_TESTS_REQUIRED === '1';
const RUN = crypto.randomBytes(4).toString('hex');

(async () => {
  console.log('T-305 web upload path tests');

  // ── A. The dedicated web gate ────────────────────────────────────────────
  console.log('\nA. Web gate');
  const API_ON = { V1_UPLOAD_API: 'true' };
  const webPath = (env) => R.decideWeb({ env }).path;

  ok(webPath({}) === 'legacy', 'DEFAULT (nothing configured) → legacy');
  ok(webPath(API_ON) === 'legacy', 'the v1 API being on does NOT enable web uploads');
  ok(webPath({ ...API_ON, V1_WEB_UPLOAD: 'true' }) === 'v1', 'exact "true" with the API mounted → v1');
  ok(R.decideWeb({ env: { ...API_ON, V1_WEB_UPLOAD: 'true' } }).decision === R.WEB_DECISION.v1Enabled,
    'the decision is web_v1_enabled');
  ok(webPath({ V1_WEB_UPLOAD: 'true' }) === 'legacy',
    'V1_WEB_UPLOAD=true with the v1 API OFF → legacy (a "v1" answer would only send the browser to a 404)');
  for (const bad of ['TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', ' true ', '"true"', 'false', '', 'null', 'undefined']) {
    ok(webPath({ ...API_ON, V1_WEB_UPLOAD: bad }) === 'legacy', `V1_WEB_UPLOAD=${JSON.stringify(bad)} → legacy`);
  }
  ok(R.decideWeb({ env: {} }).decision === R.WEB_DECISION.legacyDisabled, 'OFF is reported as web_legacy_disabled');
  const nm = R.decideWeb({ env: { ...API_ON, V1_WEB_UPLOAD: 'true' }, hasPostgresMirror: false });
  ok(nm.path === 'legacy' && nm.decision === R.WEB_DECISION.accountNotMigrated,
    'an account with no PostgreSQL mirror gets legacy under its OWN reason, account_not_migrated');
  ok(R.decideWeb({ env: { ...API_ON, V1_WEB_UPLOAD: 'true' }, hasPostgresMirror: true }).path === 'v1',
    'a mirrored account gets v1');

  // Independence — both directions, over a real population.
  const POP = Array.from({ length: 2000 }, (_, i) => `legacy-user-${i}`);
  const extDecisions = (env) => POP.map((u) => R.decide({ userId: u, env }).path).join('');
  for (const pct of ['0', '10', '50', '100']) {
    const base = { ...API_ON, V1_UPLOAD_ROLLOUT_PERCENT: pct };
    ok(extDecisions(base) === extDecisions({ ...base, V1_WEB_UPLOAD: 'true' }),
      `enabling the web gate changes NO extension decision at ${pct}%`);
  }
  ok(webPath({ ...API_ON, V1_UPLOAD_ROLLOUT_PERCENT: '100' }) === 'legacy',
    'a 100% extension rollout does NOT enable web uploads');
  ok(webPath({ ...API_ON, V1_UPLOAD_ROLLOUT_PERCENT: '100', V1_WEB_UPLOAD: 'false' }) === 'legacy',
    'nor does it override an explicit web OFF');
  ok(R.decide({ userId: 'someone', env: { ...API_ON, V1_WEB_UPLOAD: 'true' } }).path === 'legacy',
    'the web gate does NOT enable the extension rollout (0% stays 0%)');
  const src = fs.readFileSync(path.join(SERVER_DIR, 'rollout.js'), 'utf8');
  const webFn = src.slice(src.indexOf('function webUploadEnabled'), src.indexOf('function clientConfigBody'));
  ok(!/bucketFor|resolvePercent|ROLLOUT_PERCENT|SALT/.test(webFn),
    'the web decision code references no bucket, percentage or salt');

  // The wire body.
  const body = R.clientConfigBody(R.decide({ userId: 'u', env: {} }), R.decideWeb({ env: { ...API_ON, V1_WEB_UPLOAD: 'true' } }));
  ok(body.upload.path === 'legacy' && body.webUpload.path === 'v1' && body.webUpload.v1Enabled === true,
    '/client-config carries the web decision in its OWN block, independent of `upload`');
  ok(R.clientConfigBody(R.decide({ userId: 'u', env: {} })).webUpload.path === 'legacy',
    'a body built without a web decision defaults the web block to legacy');
  ok(!/secret|token|password|bucket|percent|usr_|key/i.test(JSON.stringify(body)),
    'the body exposes no secrets, identifiers, buckets, percentages or storage details');

  // ── B. Telemetry ─────────────────────────────────────────────────────────
  console.log('\nB. Telemetry');
  const { createKpi } = require(path.join(SERVER_DIR, 'kpi.js'));
  const lines = [];
  const logger = { info: (o) => lines.push(o), warn: (o) => lines.push(o), error() {}, debug() {}, child() { return this; } };
  const kpi = createKpi(logger, { snapshotIntervalMs: 0 });
  const c = kpi._counters;

  ok(c.legacyReplaceUsed === 0, 'the deprecation counter starts at zero');
  kpi.legacyReplaceUsed({}, { sizeBytes: 1234, mode: 'overwrite' });
  ok(c.legacyReplaceUsed === 1, 'a use of the memory-multer replace route increments the counter');
  const dep = lines.find((l) => l.kpi === 'deprecated_replace_used');
  ok(!!dep && dep.deprecated === true && /replace/.test(dep.route) && /Phase 14/.test(dep.removal),
    'and emits a structured, clearly identifiable deprecation event naming the removal phase');
  ok(!('userId' in dep) && !('buffer' in dep), 'the event carries no identity and no bytes');

  // A web single-PUT upload is tagged and counted in its own slice.
  let req = {};
  kpi.uploadStarted(req, { path: 'v1', store: 'r2', sizeBytes: 10, mode: 'single' });
  kpi.uploadFinished(req, 'success', { path: 'v1', sizeBytes: 10, mode: 'single' });
  ok(c.uploadV1SingleAttempt === 1 && c.uploadV1SingleSuccess === 1, 'a web single-PUT upload is counted in the single slice');
  ok(c.uploadV1Attempt === 1 && c.uploadV1Success === 1, 'and in the pooled v1 total');
  ok(c.legacyReplaceUsed === 1, 'a v1 upload does NOT touch the deprecation counter');
  ok(lines.some((l) => l.kpi === 'upload_finished' && l.upload_path === 'v1' && l.upload_mode === 'single'),
    'the log line says upload_mode=single');
  req = {};
  kpi.uploadStarted(req, { path: 'v1', mode: 'multipart' });
  kpi.uploadFinished(req, 'error', { path: 'v1', mode: 'multipart', code: 'x' });
  ok(c.uploadV1SingleFailure === 0 && c.uploadV1Failure === 1, 'an extension multipart failure is NOT charged to the web slice');
  req = {};
  kpi.uploadStarted(req, { path: 'v1', mode: 'single' });
  kpi.uploadFinished(req, 'error', { path: 'v1', mode: 'single', code: 'storage_put_failed' });
  ok(c.uploadV1SingleFailure === 1, 'a web single-PUT failure is charged to the web slice');
  req = {};
  kpi.uploadStarted(req, { path: 'legacy', store: 'cloudinary', fallbackFrom: 'v1' });
  kpi.uploadFinished(req, 'success', { path: 'legacy', fallbackFrom: 'v1' });
  ok(c.uploadV1Fallback === 1 && c.uploadV1Failure === 3, 'a rescued upload still counts as a v1 failure — the rate stays truthful');

  kpi.webUploadDecision({}, { path: 'v1', decision: 'web_v1_enabled' });
  kpi.webUploadDecision({}, { path: 'legacy', decision: 'account_not_migrated' });
  ok(c.webUploadV1Selected === 1 && c.webUploadLegacySelected === 1 && c.webUploadAccountNotMigrated === 1,
    'web decisions have their own counters');
  ok(c.rolloutV1Selected === 0 && c.rolloutLegacySelected === 0, 'and do NOT move the extension rollout counters');
  const snapLines = [];
  const kpi2 = createKpi({ info: (o) => snapLines.push(o), warn() {}, error() {}, debug() {}, child() { return this; } }, { snapshotIntervalMs: 0 });
  kpi2.legacyReplaceUsed({}, {});
  kpi2.snapshot();
  const snap = snapLines.find((l) => l.kpi === 'kpi_snapshot');
  ok(snap.deprecations && snap.deprecations.legacyReplaceUsed === 1, 'the snapshot carries deprecations.legacyReplaceUsed');
  ok(snap.cutover && snap.cutover.web && 'singleSuccessRatePct' in snap.cutover.web && 'enabled' in snap.cutover.web,
    'the snapshot carries a separate cutover.web block');
  ok(!/Bearer |authorization|secretAccessKey|sr_token|usr_/i.test(JSON.stringify(lines)), 'no credentials or user ids in any line');
  kpi._stop(); kpi2._stop();

  // ── C. Client wiring (source level) ──────────────────────────────────────
  console.log('\nC. Client wiring');
  const lib = fs.readFileSync(path.join(CLIENT_DIR, 'src', 'lib', 'v1Upload.js'), 'utf8');
  const editor = fs.readFileSync(path.join(CLIENT_DIR, 'src', 'pages', 'Editor.jsx'), 'utf8');
  const libCode = lib.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

  // Gate OFF ⇒ the legacy path, unchanged.
  ok(/form\.append\('video', file, file\.name \|\| 'clip\.mp4'\)/.test(editor)
    && /authFetch\(`\$\{API\}\/api\/upload`, \{ method: 'POST', body: form \}\)/.test(editor),
    'the legacy editor upload (FormData → POST /api/upload) is still present, unchanged');
  ok(/webUploadIsV1\(cfg\) && preflightSingle\(file\)\.ok/.test(editor),
    'the v1 path runs ONLY when the server says v1 AND the file fits single mode');
  ok(/webUpload\.path === 'v1'/.test(lib), 'only an explicit webUpload.path === "v1" counts');
  ok(/return null;/.test(lib) && /fetchClientConfig/.test(lib), 'a failed config fetch resolves to null, i.e. legacy');

  // No bytes through the application server.
  ok(!/\/api\/upload/.test(libCode), 'the v1 library never references the legacy /api/upload');
  ok(!/FormData/.test(libCode) && !/multer/i.test(libCode), 'the v1 library builds no multipart form and knows no multer');
  ok(/xhr\.open\('PUT', url\)/.test(lib) && /putDirect\(ses\.uploadUrl, file/.test(lib),
    'the file is PUT directly to the presigned storage URL');
  ok(!/xhr\.open\('PUT', `\$\{API\}/.test(lib), 'the PUT never targets the API origin');
  ok(/mode: 'single', sizeBytes: file\.size/.test(lib), 'the session is single mode with the exact file size');
  ok(/parts: \[\]/.test(lib), 'completion sends an empty parts list');
  ok(!/aws-sdk|S3Client|accessKeyId|secretAccessKey/.test(lib), 'no storage SDK or credentials in the browser');

  // The fallback boundary is exactly session creation.
  ok(/apiError\(recRes, rec, 'create_recording', true\)/.test(lib), 'recording-create failure → fallback allowed');
  ok(/apiError\(sesRes, ses, 'create_session', true\)/.test(lib), 'session-create failure → fallback allowed');
  ok(/method: 'DELETE' \}\); \} catch \(e\) \{\}\n\s+throw apiError\(sesRes, ses, 'create_session', true\)/.test(lib),
    'a recording created for a session that then failed is deleted before falling back — no duplicate recording');
  ok(/fallbackAllowed: false/.test(lib.slice(lib.indexOf('function putDirect'))), 'a storage PUT failure is NOT fallback-eligible');
  ok(/apiError\(doneRes, done, 'complete', false\)/.test(lib), 'a completion failure is NOT fallback-eligible');
  ok(/if \(!\(e instanceof V1UploadError\) \|\| !e\.fallbackAllowed\)/.test(editor)
    && /setPicker\(\(p\) => p && \{ \.\.\.p, uploading: false \}\);\r?\n\s+return;/.test(editor),
    'the editor surfaces a non-fallback error and does NOT run the legacy POST');
  ok(/SINGLE_MAX_BYTES = 32 \* 1024 \* 1024/.test(lib), 'the client knows the single-mode ceiling');

  // Composition protection in the editor.
  ok(/clips\.some\(\(c\) => c\.v1\)/.test(editor) && /NOT_COMPOSABLE_MSG/.test(editor),
    'the editor explains, before sending, that a v1 clip cannot be composed');
  ok(/r\.code === 'clip_not_composable'/.test(editor), "and handles the server's own 409 clip_not_composable");
  ok(/addClip\(r\.recordingId, r\.playbackUrl \|\| '', name, dur, useV1 \? \{ fresh: true \} : \{ v1: true \}\)/.test(editor),
    'a v1 clip enters the timeline playing from its signed playbackUrl');

  // ── D. Live server ───────────────────────────────────────────────────────
  console.log('\nD. Live server');
  const { loadEnv, createPool, createClient } = require(path.join(DB_DIR, 'src', 'index.js'));
  const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));
  const env = loadEnv({ appEnv: 'test' });
  const pool = createPool({ env, max: 4 });
  let pgUp = false;
  try { await pool.query('select 1'); pgUp = true; } catch {}
  if (!pgUp) {
    console.log('  SKIPPED — PostgreSQL unreachable; the live server checks did NOT run.');
    await pool.end().catch(() => {});
    if (REQUIRED) { fail++; console.log('  FAIL: WEB_UPLOAD_TESTS_REQUIRED=1'); }
  } else {
    console.log('  PostgreSQL reachable — running the live server checks.');
    const db = createClient(pool);
    const MINIO = process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100';
    async function startServer(port, extra, dataDir) {
      const child = spawn(process.execPath, ['index.js'], {
        cwd: SERVER_DIR,
        env: {
          ...process.env, PORT: String(port), NODE_ENV: 'production', JWT_SECRET: 't305', DATA_DIR: dataDir,
          LOG_PRETTY: 'false', SENTRY_DSN: '', APP_ENV: 'test', DATABASE_URL_TEST: env.databaseUrl,
          STORAGE_ENDPOINT: MINIO, STORAGE_BUCKET: 'veorec-media-test', STORAGE_PROVIDER: 'minio',
          STORAGE_ACCESS_KEY_ID: 'veorec_dev', STORAGE_SECRET_ACCESS_KEY: 'veorec_local_dev_secret',
          STORAGE_REGION: 'auto', STORAGE_FORCE_PATH_STYLE: 'true',
          V1_UPLOAD_API: 'true', V1_WEB_UPLOAD: '', V1_UPLOAD_ROLLOUT_PERCENT: '0', ...extra,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { out += d.toString(); });
      for (let i = 0; i < 60; i += 1) {
        try { if ((await fetch(`http://127.0.0.1:${port}/api/plans`)).ok) break; } catch {}
        await sleep(250);
      }
      return { child, log: () => out };
    }
    const cfgOf = async (port, token) => (await fetch(`http://127.0.0.1:${port}/api/client-config`,
      { headers: { Authorization: `Bearer ${token}` } })).json();
    // pino writes asynchronously; give a line up to 2s to reach the pipe.
    async function waitLog(srv, re) {
      for (let i = 0; i < 20; i += 1) { if (re.test(srv.log())) return true; await sleep(100); }
      return re.test(srv.log());
    }

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't305-'));
    let token = null, legacyUserId = null;
    let srv = await startServer(3301, { V1_WEB_UPLOAD: 'true', V1_UPLOAD_ROLLOUT_PERCENT: '100' }, dataDir);
    try {
      const sb = await (await fetch('http://127.0.0.1:3301/api/auth/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'T305', email: `t305-${RUN}@example.com`, password: `Secret-${RUN}-1!` }),
      })).json();
      token = sb.token; legacyUserId = (sb.user && sb.user.id) || sb.id;
      ok(!!token, 'a legacy account exists');

      const unmirrored = await cfgOf(3301, token);
      ok(unmirrored.webUpload.path === 'legacy', 'gate ON but no PostgreSQL mirror → web legacy');
      ok(await waitLog(srv, /web_upload_decision.*account_not_migrated|account_not_migrated.*web_upload_decision/s),
        'recorded as account_not_migrated on the web decision line');

      await db.execute(sql`INSERT INTO users (id,email,name,password_hash)
        VALUES (${`usr_${legacyUserId}`}, ${`t305-${RUN}@example.com`}, 'T305', 'x') ON CONFLICT (id) DO NOTHING`);
      const mirrored = await cfgOf(3301, token);
      ok(mirrored.webUpload.path === 'v1' && mirrored.webUpload.v1Enabled === true, 'gate ON with a mirror → web v1');
      ok(mirrored.upload.path === 'v1', '(the extension is at 100% in this run — its decision is its own)');
      ok(!('percent' in mirrored.webUpload) && !('bucket' in mirrored.webUpload), 'the web block discloses nothing internal');

      // ── Composition protection on the real route ──
      // A legacy base recording (local-disk mode: no Cloudinary in tests).
      const form = new FormData();
      form.append('video', new Blob([crypto.randomBytes(2048)], { type: 'video/webm' }), 'base.webm');
      form.append('title', 'base'); form.append('duration', '3');
      const up = await (await fetch('http://127.0.0.1:3301/api/upload', { method: 'POST',
        headers: { Authorization: `Bearer ${token}` }, body: form })).json();
      ok(!!up.id, 'a legacy base recording exists');
      const form2 = new FormData();
      form2.append('video', new Blob([crypto.randomBytes(2048)], { type: 'video/webm' }), 'other.webm');
      form2.append('title', 'other'); form2.append('duration', '3');
      const other = await (await fetch('http://127.0.0.1:3301/api/upload', { method: 'POST',
        headers: { Authorization: `Bearer ${token}` }, body: form2 })).json();
      // A v1 recording — the row only; composability does not depend on bytes.
      const v1rec = await (await fetch('http://127.0.0.1:3301/api/v1/recordings', { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `c-${RUN}` },
        body: JSON.stringify({ title: 'v1 clip', source: 'web_upload' }) })).json();
      ok(!!v1rec.id, 'a v1 recording exists');
      const compose = (clips) => fetch(`http://127.0.0.1:3301/api/recordings/${up.id}/compose`, { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ clips, mode: 'copy' }) });
      let cr = await compose([{ id: up.id, start: 0, end: 1 }, { id: v1rec.id, start: 0, end: 1 }]);
      let cb = await cr.json();
      ok(cr.status === 409 && cb.code === 'clip_not_composable', 'composing with a v1 clip → 409 clip_not_composable');
      ok(/new storage/.test(cb.error) && /played/.test(cb.error), 'with a plain, user-facing explanation');
      ok(cr.status !== 404, 'NOT a generic 404');
      cr = await compose([{ id: up.id, start: 0, end: 1 }, { id: other.id, start: 0, end: 1 }]);
      ok(cr.status !== 409 && cr.status !== 404, `two legacy clips pass the protective check untouched (${cr.status}: the backend answer, not ours)`);
      cr = await compose([{ id: up.id, start: 0, end: 1 }, { id: 'rec_does_not_exist', start: 0, end: 1 }]);
      ok(cr.status !== 409, 'an unknown clip is NOT reported as a v1 clip');
      ok(!/cloudinary\.uploader/.test(srv.log()), 'no Cloudinary upload was attempted');

      // ── The deprecated replace route: functional AND counted ──
      const form3 = new FormData();
      form3.append('video', new Blob([crypto.randomBytes(1024)], { type: 'video/webm' }), 'trim.webm');
      form3.append('duration', '2');
      const rep = await fetch(`http://127.0.0.1:3301/api/recordings/${up.id}/replace`, { method: 'POST',
        headers: { Authorization: `Bearer ${token}` }, body: form3 });
      ok(rep.status === 200, 'the memory-multer replace route still works');
      ok(await waitLog(srv, /deprecated_replace_used/), 'and its use emitted the deprecation event');
      ok((srv.log().match(/deprecated_replace_used/g) || []).length === 1, 'exactly once for one use');
    } finally {
      srv.child.kill(); await sleep(400);
    }

    // ── Rollback: configuration only ──
    srv = await startServer(3302, { V1_WEB_UPLOAD: '', V1_UPLOAD_ROLLOUT_PERCENT: '100' }, dataDir);
    try {
      const rolled = await cfgOf(3302, token);
      ok(rolled.webUpload.path === 'legacy', 'ROLLBACK: with V1_WEB_UPLOAD unset the SAME user is back on legacy');
      ok(rolled.upload.path === 'v1', 'while the extension rollout (100%) is untouched by the web rollback');
      ok(await waitLog(srv, /web_legacy_disabled/), 'the rollback decision is recorded');
    } finally {
      srv.child.kill(); await sleep(400);
    }
    srv = await startServer(3303, { V1_WEB_UPLOAD: 'TRUE' }, dataDir);
    try {
      ok((await cfgOf(3303, token)).webUpload.path === 'legacy', 'a live server with V1_WEB_UPLOAD=TRUE (wrong case) answers legacy');
    } finally {
      srv.child.kill(); await sleep(400);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
    await pool.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
