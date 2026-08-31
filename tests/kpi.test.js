// T-003 KPI instrumentation tests (run: node tests/kpi.test.js)
// Part A: unit tests of server/kpi.js with an injected fake logger.
// Part B: integration — boots the real server (local mode, temp DATA_DIR) and
// exercises upload success / plan-rejection / watch-404-retry, asserting kpi
// events correlate by request_id and that API behavior is unchanged.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const PORT = 3179;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Part A: unit ──────────────────────────────────────────────────────────────
function unitTests() {
  const { createKpi } = require(path.join(SERVER_DIR, 'kpi.js'));
  const events = [];
  const fake = { info: (o, m) => events.push({ ...o, msg: m }), warn: () => {}, error: () => {}, debug: () => {} };
  const kpi = createKpi(fake, { snapshotIntervalMs: 0 });
  const evts = (name) => events.filter((e) => e.kpi === name);

  // upload success with duration
  const req1 = { log: fake };
  kpi.uploadStarted(req1, { store: 'local', sizeBytes: 1000 });
  kpi.uploadFinished(req1, 'success', { sizeBytes: 1000 });
  ok(evts('upload_started').length === 1, 'unit: upload_started emitted');
  ok(evts('upload_finished')[0].outcome === 'success' && typeof evts('upload_finished')[0].durationMs === 'number',
    'unit: success carries numeric durationMs');

  // double-finish guard
  kpi.uploadFinished(req1, 'error', {});
  ok(kpi._counters.uploadError === 0, 'unit: double-finish is ignored');

  // rejection + error outcomes
  const req2 = { log: fake };
  kpi.uploadStarted(req2, { store: 'local' });
  kpi.uploadFinished(req2, 'rejected_limit', { code: 'recording_limit' });
  const req3 = { log: fake };
  kpi.uploadStarted(req3, { store: 'cloudinary' });
  kpi.uploadFinished(req3, 'error', { code: 'cloudinary_error' });
  ok(kpi._counters.uploadSuccess === 1 && kpi._counters.uploadRejectedLimit === 1 && kpi._counters.uploadError === 1,
    'unit: outcome counters correct');

  // multer-level failure (no uploadStarted ran) — attempt implied
  const before = kpi._counters.uploadStarted;
  kpi.requestError({ originalUrl: '/api/upload', log: fake }, Object.assign(new Error('too big'), { code: 'LIMIT_FILE_SIZE' }));
  ok(kpi._counters.uploadStarted === before + 1, 'unit: multer-level failure implies an attempt');
  ok(evts('upload_finished').some((e) => e.code === 'file_too_large'), 'unit: LIMIT_FILE_SIZE classified file_too_large');
  ok(kpi._counters.unhandledError === 0, 'unit: file_too_large not counted as unhandled');

  // non-upload unhandled error
  kpi.requestError({ originalUrl: '/api/plans', log: fake }, new Error('boom'));
  ok(kpi._counters.unhandledError === 1, 'unit: unhandled error counted');
  ok(kpi._counters.uploadError === 2, 'unit: upload error count from multer failure');

  // watch 404 retry + recovery
  kpi.watchMiss({ log: fake }, 'rec_lagging');
  kpi.watchMiss({ log: fake }, 'rec_lagging');
  kpi.watchMiss({ log: fake }, 'rec_lagging');
  ok(evts('watch_404_retry').length === 2 && evts('watch_404_retry')[1].attempt === 3,
    'unit: repeated 404s on same id emit retry events with attempt count');
  kpi.watchHit({ log: fake }, 'rec_lagging');
  const rec = evts('watch_recovered_after_404');
  ok(rec.length === 1 && rec[0].retries === 3 && typeof rec[0].waitedMs === 'number',
    'unit: hit after misses emits recovered event');
  kpi.watchHit({ log: fake }, 'rec_fresh');
  ok(evts('watch_recovered_after_404').length === 1, 'unit: clean hit emits no recovered event');

  // snapshot math: success=1, error=2 → 33.33%; rejected excluded from reliability rate
  kpi.snapshot();
  const snap = evts('kpi_snapshot')[0];
  ok(!!snap && snap.upload.successRatePct === 33.33, `unit: snapshot successRate excludes policy rejections (got ${snap && snap.upload.successRatePct})`);
  ok(snap.upload.acceptRatePct === 25, 'unit: acceptRate includes policy rejections');
  ok(snap.counters.watchMiss === 3 && snap.counters.watchHit === 2, 'unit: snapshot watch counters');
  ok(typeof snap.upload.durationMsP50 === 'number', 'unit: snapshot p50 present');
  kpi._stop();
}

// ── Part B: integration ───────────────────────────────────────────────────────
let stdoutBuf = '';
const kpiLines = () => stdoutBuf.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((l) => l && l.kpi);

async function waitReady(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`${BASE}/api/plans`); if (r.ok) return true; } catch {}
    await sleep(250);
  }
  return false;
}

async function integrationTests() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veorec-kpi-test-'));
  const child = spawn(process.execPath, ['index.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production', JWT_SECRET: 'kpi-test-secret', DATA_DIR: dataDir, SENTRY_DSN: '', LOG_PRETTY: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
  child.stderr.on('data', (d) => { stdoutBuf += d.toString(); });

  let uploadedId = null, token = null;
  try {
    ok(await waitReady(), 'server ready');

    // account (isolated DATA_DIR)
    const su = await fetch(`${BASE}/api/auth/signup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'KPI Test', email: 'kpi-test@example.com', password: 'kpi-test-pw-123' }),
    });
    ok(su.status === 200, 'signup ok');
    token = (await su.json()).token;
    const auth = { Authorization: `Bearer ${token}` };

    // upload success (local mode → server/uploads; cleaned up via DELETE below)
    const form = new FormData();
    form.append('video', new Blob([Buffer.from('fake-webm-bytes-for-kpi-test')], { type: 'video/webm' }), 'recording.webm');
    form.append('title', 'KPI test recording');
    form.append('duration', '5');
    const up = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: auth, body: form });
    const upId = up.headers.get('x-request-id');
    ok(up.status === 200, 'upload succeeds (behavior unchanged)');
    const upBody = await up.json();
    ok(typeof upBody.id === 'string' && typeof upBody.url === 'string', 'upload response shape unchanged {id,url}');
    uploadedId = upBody.id;
    await sleep(300);
    ok(kpiLines().some((l) => l.kpi === 'upload_started' && l.request_id === upId && l.store === 'local'),
      'kpi upload_started correlated by request_id');
    const fin = kpiLines().find((l) => l.kpi === 'upload_finished' && l.request_id === upId);
    ok(!!fin && fin.outcome === 'success' && typeof fin.durationMs === 'number' && fin.sizeBytes > 0,
      'kpi upload_finished success with duration + size');

    // upload plan-rejection (duration over free 10-min limit)
    const form2 = new FormData();
    form2.append('video', new Blob([Buffer.from('x')], { type: 'video/webm' }), 'recording.webm');
    form2.append('title', 'too long');
    form2.append('duration', '99999');
    const rej = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: auth, body: form2 });
    const rejId = rej.headers.get('x-request-id');
    ok(rej.status === 403, 'over-limit upload still 403 (behavior unchanged)');
    const rejBody = await rej.json();
    ok(rejBody.code === 'recording_limit' && rejBody.upgradeRequired === true, 'rejection body unchanged');
    await sleep(300);
    const rfin = kpiLines().find((l) => l.kpi === 'upload_finished' && l.request_id === rejId);
    ok(!!rfin && rfin.outcome === 'rejected_limit' && rfin.code === 'recording_limit',
      'kpi rejection classified rejected_limit/recording_limit');

    // watch hit on the uploaded recording
    const w1 = await fetch(`${BASE}/api/watch/${uploadedId}`);
    ok(w1.status === 200, 'watch of existing recording still 200');

    // watch 404 retry pattern (unknown id, twice — mirrors the client retry loop)
    const ghost = 'ghost-0000-kpi';
    const g1 = await fetch(`${BASE}/api/watch/${ghost}`);
    const g2 = await fetch(`${BASE}/api/watch/${ghost}`);
    ok(g1.status === 404 && g2.status === 404, 'unknown watch id still 404 (behavior unchanged)');
    const g2id = g2.headers.get('x-request-id');
    await sleep(300);
    const retry = kpiLines().find((l) => l.kpi === 'watch_404_retry' && l.recordingId === ghost);
    ok(!!retry && retry.attempt === 2 && retry.request_id === g2id,
      'kpi watch_404_retry emitted on second miss, correlated by request_id');

    // no sensitive data in kpi lines
    ok(!stdoutBuf.includes('kpi-test-pw-123') && !stdoutBuf.includes(token.slice(0, 24)),
      'no password/token leaked into logs');
  } finally {
    // cleanup: delete the uploaded recording (removes server/uploads file + row)
    try {
      if (uploadedId && token) await fetch(`${BASE}/api/recordings/${uploadedId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    } catch {}
    child.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  unitTests();
  await integrationTests();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test harness error:', e); process.exit(1); });
