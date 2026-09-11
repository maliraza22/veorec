// T-304 cutover flag & telemetry tests (run: cd server && npm run test:rollout)
//
// Part A — bucketing and config resolution: pure, deterministic, no infrastructure.
// Part B — the live GET /api/client-config endpoint on a spawned real server,
//          including the deliberate ROLLBACK DRILL at integration level rather
//          than against a pure helper.
//
// The properties that matter here are the ones that make a staged rollout safe:
// a user must not flip paths between requests, raising the percentage must not
// reshuffle anyone, a broken config must fail toward legacy, and a population
// that cannot use v1 must be counted rather than hidden.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'server');
const DB_DIR = path.join(ROOT, 'db');
const R = require(path.join(SERVER_DIR, 'rollout.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REQUIRED = process.env.ROLLOUT_TESTS_REQUIRED === '1';
const RUN = crypto.randomBytes(4).toString('hex');

const envAt = (percent, extra = {}) => ({
  V1_UPLOAD_API: 'true', V1_UPLOAD_ROLLOUT_PERCENT: String(percent), ...extra,
});
const pathAt = (userId, percent, extra) => R.decide({ userId, env: envAt(percent, extra) }).path;

// A representative population, fixed so this suite can never flake.
const POPULATION = Array.from({ length: 2000 }, (_, i) => `legacy-user-${i}`);
const selectedAt = (percent) => new Set(POPULATION.filter((u) => pathAt(u, percent) === 'v1'));

(async () => {
  console.log('T-304 cutover flag & telemetry tests');

  // ── A. Remote config resolution ──────────────────────────────────────────
  console.log('\nA. Configuration');
  ok(R.decide({ userId: 'u', env: {} }).path === 'legacy',
    'DEFAULT (nothing configured) is the legacy path — production behaviour is preserved');
  ok(R.decide({ userId: 'u', env: {} }).decision === R.DECISION.legacyDisabled,
    'the default decision is legacy_disabled');
  ok(R.decide({ userId: 'u', env: { V1_UPLOAD_ROLLOUT_PERCENT: '100' } }).path === 'legacy',
    '100% with the v1 API switched OFF still resolves to legacy');
  ok(pathAt('u', 0) === 'legacy', '0% selects nobody');

  for (const bad of ['abc', '-1', '101', '50.5', '', null, undefined, '1e2', 'Infinity',
    ' 100 ', '0x64', '010.0', '100.0', true, {}]) {
    ok(R.resolvePercent(bad) === 0, `malformed percent ${JSON.stringify(bad)} fails safe to 0`);
  }
  ok(R.resolvePercent('10') === 10 && R.resolvePercent('50') === 50 && R.resolvePercent('100') === 100,
    '10, 50 and 100 are represented correctly');

  const body = R.clientConfigBody(R.decide({ userId: 'u', env: envAt(100) }));
  ok(body.upload.path === 'v1' && body.upload.v1Enabled === true, 'the config body carries the decision');
  const wire = JSON.stringify(body);
  ok(!/secret|token|password|key|usr_|legacy-user/i.test(wire),
    'the config body exposes no secrets and no identifiers');
  ok(!('bucket' in body) && !('percent' in body.upload),
    'the body does not disclose the bucket or the rollout percentage');

  // ── B. Bucketing ─────────────────────────────────────────────────────────
  console.log('\nB. Deterministic bucketing');
  ok(R.bucketFor('alice') === R.bucketFor('alice'), 'the same user always gets the same bucket');
  const repeated = new Set(Array.from({ length: 50 }, () => pathAt('alice', 50)));
  ok(repeated.size === 1, 'fifty consecutive decisions for one user are identical — no randomness');
  ok(R.bucketFor('alice') >= 0 && R.bucketFor('alice') < 100, 'buckets are 0–99');

  const src = fs.readFileSync(path.join(SERVER_DIR, 'rollout.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  ok(!/Math\.random|Date\.now\(\)|counter\+\+/.test(code),
    'the bucketing uses no randomness, no clock and no counter');

  const p0 = selectedAt(0), p10 = selectedAt(10), p50 = selectedAt(50), p100 = selectedAt(100);
  ok(p0.size === 0, '0% → nobody is selected');
  ok(p100.size === POPULATION.length, '100% → every eligible user is selected');
  ok(p10.size > 0 && p10.size < p50.size && p50.size < p100.size, 'the population grows with the percentage');

  // Monotonicity — asserted exactly, not statistically.
  ok([...p10].every((u) => p50.has(u)), 'the 10% population is a strict SUBSET of the 50% population');
  ok([...p50].every((u) => p100.has(u)), 'the 50% population is a strict SUBSET of 100%');
  ok([...p10].every((u) => p100.has(u)), 'a user selected at 10% is still selected at 100%');
  // Every percentage step, not just the three named ones.
  let monotonic = true;
  for (let p = 0; p < 100; p += 1) {
    const lo = new Set(POPULATION.filter((u) => pathAt(u, p) === 'v1'));
    const hi = new Set(POPULATION.filter((u) => pathAt(u, p + 1) === 'v1'));
    if (![...lo].every((u) => hi.has(u))) { monotonic = false; break; }
  }
  ok(monotonic, 'raising the percentage by one NEVER removes a previously selected user (all 100 steps)');

  // Distribution — a deterministic tolerance, so this can never flake.
  const pct = (s) => (s.size / POPULATION.length) * 100;
  ok(pct(p10) > 5 && pct(p10) < 16, `10% selects a plausible share (${pct(p10).toFixed(1)}%)`);
  ok(pct(p50) > 42 && pct(p50) < 58, `50% selects a plausible share (${pct(p50).toFixed(1)}%)`);
  ok(new Set(POPULATION.map((u) => R.bucketFor(u))).size > 80,
    'distinct users spread across the bucket space rather than clustering');

  // ── C. Eligibility reasons ───────────────────────────────────────────────
  console.log('\nC. Eligibility');
  const selectedUser = POPULATION.find((u) => pathAt(u, 10) === 'v1');
  const unselectedUser = POPULATION.find((u) => pathAt(u, 10) === 'legacy');
  ok(!!selectedUser && !!unselectedUser, 'the population contains both selected and unselected users');
  ok(R.decide({ userId: unselectedUser, env: envAt(10) }).decision === R.DECISION.legacyRollout,
    'an unselected user is legacy_rollout — distinct from the rollout being off');
  ok(R.decide({ userId: selectedUser, env: envAt(10) }).decision === R.DECISION.v1Rollout,
    'a selected user is v1_rollout');

  const notMigrated = R.decide({ userId: selectedUser, env: envAt(10), hasPostgresMirror: false });
  ok(notMigrated.decision === R.DECISION.accountNotMigrated,
    'a selected user with no PostgreSQL mirror is account_not_migrated');
  ok(notMigrated.path === 'legacy', 'that user still gets a working upload, on the legacy path');
  ok(notMigrated.decision !== R.DECISION.legacyRollout,
    'account_not_migrated is NOT folded into the ordinary legacy count — the population stays visible');
  ok(R.decide({ userId: selectedUser, env: envAt(10), hasPostgresMirror: true }).decision === R.DECISION.v1Rollout,
    'a mirrored selected user is unaffected');
  // A user the rollout never selected is not mislabelled as unmigrated.
  ok(R.decide({ userId: unselectedUser, env: envAt(10), hasPostgresMirror: false }).decision
    === R.DECISION.legacyRollout,
    'an unselected user is never reported as account_not_migrated');

  // ── D. Live endpoint + rollback drill ────────────────────────────────────
  console.log('\nD. Live endpoint and rollback drill');
  const { loadEnv, createPool, createClient } = require(path.join(DB_DIR, 'src', 'index.js'));
  const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));
  const env = loadEnv({ appEnv: 'test' });
  const pool = createPool({ env, max: 4 });
  let pgUp = false;
  try { await pool.query('select 1'); pgUp = true; } catch {}

  if (!pgUp) {
    console.log('  SKIPPED — PostgreSQL unreachable; the live endpoint and rollback drill did NOT run.');
    await pool.end().catch(() => {});
    if (REQUIRED) { fail++; console.log('  FAIL: ROLLOUT_TESTS_REQUIRED=1'); }
  } else {
    console.log('  PostgreSQL reachable — running the live endpoint and the rollback drill.');
    const db = createClient(pool);

    /** Start the real server with a given rollout configuration. */
    async function startServer(port, percent, dataDir) {
      const child = spawn(process.execPath, ['index.js'], {
        cwd: SERVER_DIR,
        env: {
          ...process.env, PORT: String(port), NODE_ENV: 'production', JWT_SECRET: 't304',
          DATA_DIR: dataDir, LOG_PRETTY: 'false', SENTRY_DSN: '', APP_ENV: 'test',
          V1_UPLOAD_API: 'true', V1_UPLOAD_ROLLOUT_PERCENT: String(percent),
          DATABASE_URL_TEST: env.databaseUrl,
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

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't304-'));
    let srv = await startServer(3291, 100, dataDir);          // 100% → everyone
    let token = null, legacyUserId = null;
    try {
      const signup = await fetch('http://127.0.0.1:3291/api/auth/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'T304', email: `t304-${RUN}@example.com`, password: `Secret-${RUN}-1!` }),
      });
      const sb = await signup.json();
      token = sb.token;
      legacyUserId = (sb.user && sb.user.id) || sb.id;
      ok(!!token && !!legacyUserId, 'a legacy account exists to decide about');

      // Unauthenticated callers get nothing.
      ok((await fetch('http://127.0.0.1:3291/api/client-config')).status === 401,
        'GET /api/client-config requires authentication');

      // At 100% with NO PostgreSQL mirror, the user must not be told "v1".
      const noMirror = await (await fetch('http://127.0.0.1:3291/api/client-config', {
        headers: { Authorization: `Bearer ${token}` },
      })).json();
      ok(noMirror.upload.path === 'legacy',
        'at 100%, an account with no PostgreSQL mirror is still sent to legacy');
      ok(/account_not_migrated/.test(srv.log()),
        'and the reason is recorded as account_not_migrated, not a generic legacy decision');
      ok(!new RegExp(legacyUserId).test(JSON.stringify(noMirror)),
        'the response contains no user identifier');

      // Now mirror the account, exactly as the importer/dual-write would.
      await db.execute(sql`INSERT INTO users (id,email,name,password_hash)
        VALUES (${`usr_${legacyUserId}`}, ${`t304-${RUN}@example.com`}, 'T304', 'x')
        ON CONFLICT (id) DO NOTHING`);

      const enabled = await (await fetch('http://127.0.0.1:3291/api/client-config', {
        headers: { Authorization: `Bearer ${token}` },
      })).json();
      ok(enabled.upload.path === 'v1',
        'ROLLBACK DRILL step 1 — with the rollout at 100% and a mirror present, the user is selected for v1');
      ok(enabled.upload.v1Enabled === true, 'the client is told v1 is enabled');

      // Repeat calls are stable.
      const again = await (await fetch('http://127.0.0.1:3291/api/client-config', {
        headers: { Authorization: `Bearer ${token}` },
      })).json();
      ok(again.upload.path === 'v1', 'the same user gets the same answer on a repeat call');
      ok(/rollout_decision/.test(srv.log()), 'each decision is recorded in telemetry');
    } finally {
      srv.child.kill(); await sleep(400);
    }

    // ── The rollback: configuration only. No code change, no redeploy of the
    // client, no database migration, nothing deleted.
    const recordingsBefore = (await db.execute(sql`select count(*)::int n from recordings`)).rows[0].n;
    const usersBefore = (await db.execute(sql`select count(*)::int n from users`)).rows[0].n;

    srv = await startServer(3292, 0, dataDir);                // rollout → 0%
    try {
      const rolledBack = await (await fetch('http://127.0.0.1:3292/api/client-config', {
        headers: { Authorization: `Bearer ${token}` },
      })).json();
      ok(rolledBack.upload.path === 'legacy',
        'ROLLBACK DRILL step 2 — after setting the rollout to 0%, the SAME user resolves to legacy');
      ok(rolledBack.upload.v1Enabled === false, 'the client is told v1 is disabled');
      ok(/legacy_disabled/.test(srv.log()), 'the rollback decision is recorded in telemetry');

      const recordingsAfter = (await db.execute(sql`select count(*)::int n from recordings`)).rows[0].n;
      const usersAfter = (await db.execute(sql`select count(*)::int n from users`)).rows[0].n;
      ok(recordingsAfter === recordingsBefore && usersAfter === usersBefore,
        'the rollback deleted and mutated NO data');
      ok(fs.existsSync(dataDir), 'the legacy JSON store is untouched by the rollback');
    } finally {
      srv.child.kill(); await sleep(400);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
    await pool.end().catch(() => {});
  }

  // ── E. Telemetry values ──────────────────────────────────────────────────
  console.log('\nE. Telemetry');
  const { createKpi } = require(path.join(SERVER_DIR, 'kpi.js'));
  const lines = [];
  const logger = { info: (o) => lines.push(o), warn() {}, error() {}, debug() {}, child: () => logger };
  const kpi = createKpi(logger, { snapshotIntervalMs: 0 });
  const c = kpi._counters;

  // A plain legacy upload.
  let req = {};
  kpi.uploadStarted(req, { store: 'cloudinary', sizeBytes: 10, path: 'legacy' });
  kpi.uploadFinished(req, 'success', { sizeBytes: 10, path: 'legacy' });
  ok(c.uploadLegacyAttempt === 1 && c.uploadLegacySuccess === 1, 'a successful legacy upload is tagged legacy');
  ok(c.uploadV1Attempt === 0, 'it is not counted against v1');
  ok(lines.some((l) => l.kpi === 'upload_finished' && l.upload_path === 'legacy' && l.fallback_from === null),
    'the log line carries upload_path=legacy with no fallback');

  // A successful v1 upload.
  req = {};
  kpi.uploadStarted(req, { store: 'r2', sizeBytes: 10, path: 'v1' });
  kpi.uploadFinished(req, 'success', { sizeBytes: 10, path: 'v1' });
  ok(c.uploadV1Attempt === 1 && c.uploadV1Success === 1, 'a successful v1 upload is tagged v1');

  // A v1 failure.
  req = {};
  kpi.uploadStarted(req, { path: 'v1' });
  kpi.uploadFinished(req, 'error', { code: 'storage_unavailable', path: 'v1' });
  ok(c.uploadV1Failure === 1, 'a v1 failure is counted against v1');
  ok(c.uploadLegacyFailure === 0, 'a v1 failure is not charged to legacy');

  // A FALLBACK: began on v1, finished on legacy.
  req = {};
  kpi.uploadStarted(req, { store: 'cloudinary', path: 'legacy', fallbackFrom: 'v1' });
  kpi.uploadFinished(req, 'success', { path: 'legacy', fallbackFrom: 'v1' });
  ok(c.uploadV1Fallback === 1, 'a fallback is counted as a fallback');
  ok(c.uploadV1Failure === 2,
    'a fallback ALSO counts as a v1 failure — rescuing a user must not inflate the v1 success rate');
  ok(c.uploadLegacySuccess === 2, 'the rescued upload still counts as a legacy success');
  const fbLine = lines.filter((l) => l.kpi === 'upload_finished').pop();
  ok(fbLine.upload_path === 'legacy' && fbLine.fallback_from === 'v1',
    'a fallback is DISTINGUISHABLE from a direct legacy upload in the log');

  // account_not_migrated is its own signal.
  kpi.rolloutDecision({}, { path: 'legacy', decision: 'account_not_migrated', bucket: 3, percent: 10 });
  ok(c.rolloutAccountNotMigrated === 1, 'account_not_migrated has its own counter');
  ok(c.rolloutLegacySelected === 1, 'it is also counted as a legacy routing decision');
  const rd = lines.filter((l) => l.kpi === 'rollout_decision').pop();
  ok(rd.decision === 'account_not_migrated' && rd.upload_path === 'legacy',
    'the decision is explicit in the log, not a generic failure');
  ok(!('userId' in rd) && !('user_id' in rd), 'the decision log carries no user identifier');

  // The acceptance number, and its denominator.
  const snap = [];
  const kpi2 = createKpi({ info: (o) => snap.push(o), warn() {}, error() {}, debug() {}, child() { return this; } },
    { snapshotIntervalMs: 0 });
  for (let i = 0; i < 99; i += 1) {
    const r2 = {}; kpi2.uploadStarted(r2, { path: 'v1' }); kpi2.uploadFinished(r2, 'success', { path: 'v1' });
  }
  const rf = {}; kpi2.uploadStarted(rf, { path: 'v1' }); kpi2.uploadFinished(rf, 'error', { path: 'v1' });
  kpi2.snapshot();
  const cut = snap.find((l) => l.kpi === 'kpi_snapshot').cutover;
  ok(cut.v1Attempts === 100 && cut.v1Successes === 99, 'the snapshot reports v1 attempts and successes');
  ok(cut.v1SuccessRatePct === 99, 'the success rate is successes / attempts (99%)');
  ok('accountNotMigrated' in cut, 'the snapshot surfaces the unmigrated population');

  // No credentials anywhere in the emitted telemetry.
  const emitted = JSON.stringify(lines);
  ok(!/Bearer |authorization|password|secretAccessKey|sr_token/i.test(emitted),
    'no tokens, cookies, authorization headers or storage credentials are logged');
  ok(!/usr_/.test(emitted), 'no derived PostgreSQL user id is logged');

  kpi._stop(); kpi2._stop();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
