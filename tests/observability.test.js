// T-002 observability tests (run: node tests/observability.test.js)
// Boots the real server (isolated DATA_DIR, production log mode, no Sentry DSN)
// and asserts: request ids, log correlation, redaction, error capture, and that
// existing API behavior is byte-identical to the baseline captured pre-change.
// Style matches tests/fixwebm.test.js: plain node, pass/fail counters, exit code.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3177;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_DIR = path.join(__dirname, '..', 'server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

let stdoutBuf = '';
function logLines() {
  // JSON log lines only (ignore anything non-JSON).
  return stdoutBuf.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/plans`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  return false;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veorec-obs-test-'));
  const child = spawn(process.execPath, ['index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'production',            // forces structured JSON logs
      JWT_SECRET: 'obs-test-secret-not-a-real-secret',
      DATA_DIR: dataDir,                 // never touch real JSON data
      SENTRY_DSN: '',                    // test 6: must boot without Sentry
      LOG_PRETTY: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
  child.stderr.on('data', (d) => { stdoutBuf += d.toString(); });

  try {
    // ── 6. App starts without Sentry configuration ───────────────────────────
    ok(await waitReady(), 'server becomes ready without SENTRY_DSN');
    await sleep(300);
    ok(logLines().some((l) => /sentry disabled/.test(l.msg || '')), 'logs "sentry disabled" when no DSN');

    // ── 1. Request id generated when absent ─────────────────────────────────
    const r1 = await fetch(`${BASE}/api/plans`);
    const id1 = r1.headers.get('x-request-id');
    ok(r1.status === 200, 'GET /api/plans still 200');
    ok(!!id1 && /^req_[0-9a-f-]{36}$/.test(id1), `generated id shape (got ${id1})`);

    // ── 8a. Existing behavior unchanged: /api/plans body shape ───────────────
    const plans = await r1.json();
    ok(Array.isArray(plans.plans) && plans.plans.some((p) => p.slug === 'free'),
      '/api/plans body unchanged (plans array with free)');

    // ── 3+4. Request id appears in logs, correlated to this request ──────────
    await sleep(300);
    const line1 = logLines().find((l) => l.request_id === id1);
    ok(!!line1, 'completion log line carries the same request_id');
    ok(line1 && line1.req && line1.req.method === 'GET' && line1.req.url === '/api/plans',
      'log line has allowlisted req {method,url}');
    ok(line1 && line1.res && line1.res.status === 200, 'log line has res.status');
    ok(line1 && typeof line1.responseTime === 'number', 'log line has responseTime');
    ok(line1 && line1.service === 'api', 'log line tagged service=api');

    // ── 2a. Valid supplied X-Request-Id is preserved ─────────────────────────
    const supplied = 'client-test_1234.abc';
    const r2 = await fetch(`${BASE}/api/plans`, { headers: { 'X-Request-Id': supplied } });
    ok(r2.headers.get('x-request-id') === supplied, 'valid supplied id echoed');
    await sleep(300);
    ok(logLines().some((l) => l.request_id === supplied), 'valid supplied id used in logs');

    // ── 2b. Unsafe supplied id is rejected → generated ───────────────────────
    const evil = 'bad id with spaces and "quotes"';
    const r3 = await fetch(`${BASE}/api/plans`, { headers: { 'X-Request-Id': evil } });
    const id3 = r3.headers.get('x-request-id');
    ok(/^req_[0-9a-f-]{36}$/.test(id3 || ''), 'unsafe supplied id replaced with generated one');
    ok(!stdoutBuf.includes('bad id with spaces'), 'unsafe id value never reaches logs');

    // ── Concurrency: distinct ids under parallel requests ────────────────────
    const rs = await Promise.all(Array.from({ length: 10 }, () => fetch(`${BASE}/api/plans`)));
    const ids = rs.map((r) => r.headers.get('x-request-id'));
    ok(new Set(ids).size === 10, '10 concurrent requests → 10 distinct request ids');

    // ── 7. Sensitive values are not logged ───────────────────────────────────
    const secretPw = 'SuperSecretPW-931!xyz';
    const secretTok = 'sk-observability-secret-token-84121';
    const r4 = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secretTok}` },
      body: JSON.stringify({ email: 'obs-test@example.com', password: secretPw }),
    });
    ok(r4.status === 401, 'login with bad creds still 401 (behavior unchanged)');
    const b4 = await r4.json();
    ok(b4.error === 'Invalid email or password', 'login error body unchanged');
    await sleep(300);
    ok(!stdoutBuf.includes(secretPw), 'password never appears in logs');
    ok(!stdoutBuf.includes(secretTok), 'bearer token never appears in logs');

    // ── 5+8b. Unexpected server error captured; response unchanged ───────────
    // Malformed JSON is the reliably reproducible error-middleware path; the
    // legacy server answers 500 {"error":"Server error"} (baseline-verified).
    const r5 = await fetch(`${BASE}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{oops',
    });
    ok(r5.status === 500, 'malformed JSON still answers 500 (legacy behavior preserved)');
    const b5 = await r5.json();
    ok(b5.error === 'Server error', 'error body byte-identical to baseline');
    const id5 = r5.headers.get('x-request-id');
    await sleep(300);
    const errLine = logLines().find((l) => l.request_id === id5 && l.level >= 50);
    ok(!!errLine, 'error-level log line correlated to the failing request');
    ok(errLine && errLine.err && /JSON|token|Unexpected/i.test(errLine.err.message || ''),
      'error log carries err details');

    // ── Query strings are stripped from logged urls ──────────────────────────
    const r6 = await fetch(`${BASE}/api/plans?s=share-token-value-123`);
    const id6 = r6.headers.get('x-request-id');
    await sleep(300);
    const line6 = logLines().find((l) => l.request_id === id6);
    ok(line6 && line6.req && line6.req.url === '/api/plans', 'logged url has no query string');
    ok(!stdoutBuf.includes('share-token-value-123'), 'query-string token never reaches logs');

    // ── captureException is a safe no-op when Sentry is disabled ─────────────
    const { captureException } = require(path.join(SERVER_DIR, 'log.js'));
    let threw = false;
    try { captureException(new Error('unit-no-op'), { requestId: 'req_x' }); } catch { threw = true; }
    ok(!threw, 'captureException no-ops safely without Sentry');
  } finally {
    child.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('test harness error:', e); process.exit(1); });
