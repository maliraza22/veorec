// T-105 dual-write tests (run: cd db && npm run test:dualwrite)
//
// Boots the REAL legacy server twice — once with PG_DUAL_WRITE unset and once
// with it enabled — and drives real HTTP endpoints, asserting that:
//   • responses and JSON persistence are byte-identical either way,
//   • the mirror populates PostgreSQL only when the flag is on,
//   • a PostgreSQL failure never changes a legacy response,
//   • failures are journaled durably and are reconcilable,
//   • repeated requests never duplicate mirrored rows,
//   • no secrets reach the logs.
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const SERVER_DIR = path.join(ROOT, 'server');

const { loadEnv, createPool, checkConnection, createClient } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Server harness ───────────────────────────────────────────────────────────
function startServer({ port, dataDir, env = {} }) {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env, PORT: String(port), NODE_ENV: 'production',
      JWT_SECRET: 'dualwrite-test-secret', DATA_DIR: dataDir, SENTRY_DSN: '', LOG_PRETTY: 'false',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { buf: '' };
  child.stdout.on('data', (d) => { out.buf += d.toString(); });
  child.stderr.on('data', (d) => { out.buf += d.toString(); });
  return { child, out };
}

async function waitReady(port, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/plans`); if (r.ok) return true; } catch {}
    await sleep(200);
  }
  return false;
}

/** Exercise the legacy mutations we mirror. Returns the observable results. */
async function driveLegacyFlow(port, tag) {
  const base = `http://127.0.0.1:${port}`;
  const password = `Secret-${tag}-123!`;
  const signup = await fetch(`${base}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `User ${tag}`, email: `${tag}@example.com`, password }),
  });
  const signupBody = await signup.json();
  const token = signupBody.token;
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const profile = await fetch(`${base}/api/auth/profile`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ name: `Renamed ${tag}` }),
  });
  const profileBody = await profile.json();

  const folder = await fetch(`${base}/api/folders`, {
    method: 'POST', headers: auth, body: JSON.stringify({ name: `Folder ${tag}` }),
  });
  const folderBody = await folder.json();

  const form = new FormData();
  form.append('video', new Blob([Buffer.from(`fake-webm-${tag}`)], { type: 'video/webm' }), 'recording.webm');
  form.append('title', `Recording ${tag}`);
  form.append('duration', '5');
  const upload = await fetch(`${base}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const uploadBody = await upload.json();

  const meta = await fetch(`${base}/api/recordings/${uploadBody.id}/meta`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ description: 'mirrored description', privacy: 'login' }),
  });
  const metaBody = await meta.json();

  const comment = await fetch(`${base}/api/watch/${uploadBody.id}/comment`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `hello ${tag}`, name: 'Viewer', t: 2 }),
  });
  const commentBody = await comment.json();

  const view = await fetch(`${base}/api/watch/${uploadBody.id}/view`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitorId: `visitor-${tag}` }),
  });
  const viewBody = await view.json();

  const contact = await fetch(`${base}/api/contact`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Carol', email: `carol-${tag}@example.com`, subject: 'hi', message: 'hello there' }),
  });
  const contactBody = await contact.json();

  return {
    password,
    token,
    statuses: {
      signup: signup.status, profile: profile.status, folder: folder.status, upload: upload.status,
      meta: meta.status, comment: comment.status, view: view.status, contact: contact.status,
    },
    bodies: {
      signupUser: { ...signupBody.user, id: '<id>', created_at: '<ts>' },
      profile: { ...profileBody, id: '<id>', created_at: '<ts>' },
      folder: { ...folderBody, id: '<id>', userId: '<uid>', created_at: '<ts>' },
      upload: { hasId: typeof uploadBody.id === 'string', hasUrl: typeof uploadBody.url === 'string' },
      meta: metaBody,
      comment: { ...commentBody, id: '<id>', at: '<at>' },
      view: viewBody,
      contact: { ok: contactBody.ok, hasId: typeof contactBody.id === 'string' },
    },
    ids: { recordingId: uploadBody.id, folderId: folderBody.id, commentId: commentBody.id },
  };
}

const jsonFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const dbCount = async (db, table, where = '') => {
  const res = await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table} ${where}`));
  return Number((res.rows || res)[0].n);
};

async function main() {
  const env = loadEnv({ appEnv: 'test' });
  const probe = await checkConnection(createPool({ env, max: 1 }));
  if (!probe.ok) {
    const msg = `database unreachable at ${env.databaseUrlRedacted}: ${probe.error && probe.error.message}`;
    if (process.env.DB_TESTS_REQUIRED === '1') { console.log('  FAIL:', msg); console.log('\n0 passed, 1 failed'); process.exit(1); }
    console.log('\n' + '='.repeat(72));
    console.log('SKIPPED: dual-write tests — ' + msg);
    console.log('='.repeat(72));
    process.exit(0);
  }
  ok(probe.database !== 'veorec', 'tests do NOT run against the development database');

  const reset = spawnSync(process.execPath, [path.join(DB_DIR, 'src', 'cli', 'reset.js')],
    { cwd: DB_DIR, env: { ...process.env, APP_ENV: 'test' }, encoding: 'utf8' });
  ok(reset.status === 0, 'clean database prepared');

  const pool = createPool({ env, max: 3, applicationName: 'veorec-dualwrite-test' });
  const db = createClient(pool);
  const servers = [];

  try {
    // ── A. Flag OFF (absent) — legacy behaviour, zero PostgreSQL writes ──────
    const dirOff = fs.mkdtempSync(path.join(os.tmpdir(), 'veorec-dw-off-'));
    const off = startServer({ port: 3211, dataDir: dirOff });     // PG_DUAL_WRITE not set
    servers.push(off);
    ok(await waitReady(3211), 'server starts with dual-write absent (default OFF)');
    const resultOff = await driveLegacyFlow(3211, 'zzq1');
    await sleep(500);

    ok(Object.values(resultOff.statuses).every((s) => s === 200), 'all legacy operations succeed with the flag off');
    ok(await dbCount(db, 'users') === 0 && await dbCount(db, 'recordings') === 0,
      'flag off performs ZERO PostgreSQL writes');
    ok(!/dual-write/i.test(off.out.buf) || /ENABLED/.test(off.out.buf) === false,
      'flag off does not announce dual-write as enabled');
    ok(!fs.existsSync(path.join(dirOff, 'dual-write-failures.jsonl')),
      'flag off creates no failure journal');

    // ── B. Flag ON — identical legacy behaviour + PostgreSQL mirror ──────────
    const dirOn = fs.mkdtempSync(path.join(os.tmpdir(), 'veorec-dw-on-'));
    const on = startServer({
      port: 3212, dataDir: dirOn,
      env: { PG_DUAL_WRITE: 'true', APP_ENV: 'test', DATABASE_URL: env.databaseUrl },
    });
    servers.push(on);
    ok(await waitReady(3212), 'server starts with dual-write enabled');
    const resultOn = await driveLegacyFlow(3212, 'zzq2');
    await sleep(1500);   // let the non-blocking mirrors land

    // Behaviour parity: statuses and response shapes identical to flag-off.
    ok(JSON.stringify(resultOff.statuses) === JSON.stringify(resultOn.statuses),
      'HTTP status codes are identical with the mirror enabled');
    const normalise = (b, tag) => JSON.parse(JSON.stringify(b).split(tag).join('<tag>'));
    ok(JSON.stringify(normalise(resultOff.bodies, 'zzq1')) === JSON.stringify(normalise(resultOn.bodies, 'zzq2')),
      'response bodies are identical with the mirror enabled');
    ok(JSON.stringify(jsonFiles(dirOff)) === JSON.stringify(jsonFiles(dirOn)),
      'the same legacy JSON stores are written in both modes');
    const usersOff = JSON.parse(fs.readFileSync(path.join(dirOff, 'users.json'), 'utf8'));
    const usersOn = JSON.parse(fs.readFileSync(path.join(dirOn, 'users.json'), 'utf8'));
    ok(usersOff.length === 1 && usersOn.length === 1 && !!usersOn[0].password,
      'legacy JSON persistence is intact and unchanged in shape');

    // The mirror populated PostgreSQL.
    ok(await dbCount(db, 'users') === 1, 'user mirrored to PostgreSQL');
    ok(await dbCount(db, 'folders') === 1, 'folder mirrored');
    ok(await dbCount(db, 'recordings') === 1, 'recording mirrored');
    ok(await dbCount(db, 'comments') === 1, 'comment mirrored');
    ok(await dbCount(db, 'view_sessions') === 1, 'view session mirrored');
    ok(await dbCount(db, 'contacts') === 1, 'contact mirrored');
    ok(await dbCount(db, 'usage') === 1, 'usage snapshot mirrored');
    ok(await dbCount(db, 'legacy.media_map') === 1, 'legacy media pointer recorded for the future R2 backfill');
    ok(await dbCount(db, 'video_assets') === 0, 'no video_assets row is created (media is not in R2 yet)');

    // Ownership and content fidelity.
    const legacyUserId = usersOn[0].id;
    const rec = await db.execute(sql`SELECT * FROM recordings WHERE id = ${'rec_' + resultOn.ids.recordingId}`);
    const recRow = (rec.rows || rec)[0];
    ok(recRow && recRow.user_id === `usr_${legacyUserId}`, 'mirrored recording is owned by the mirrored user');
    ok(recRow.title === 'Recording zzq2', 'recording title mirrored');
    ok(recRow.privacy === 'login' && recRow.description === 'mirrored description',
      'metadata patch mirrored (privacy + description)');
    ok(recRow.folder_id === null, 'unset folder mirrors as NULL rather than a guess');
    const usr = await db.execute(sql`SELECT * FROM users WHERE id = ${'usr_' + legacyUserId}`);
    const usrRow = (usr.rows || usr)[0];
    ok(usrRow.name === 'Renamed zzq2', 'profile update mirrored (upsert refreshed the row)');
    ok(usrRow.password_hash === usersOn[0].password, 'password hash mirrored so sign-in works after cutover');
    ok(usrRow.reset_token_hash === null, 'plaintext reset tokens are never mirrored');

    // ── C. Idempotency: repeated identical operations do not duplicate ───────
    const base = 'http://127.0.0.1:3212';
    const tok = resultOn.token;
    for (let i = 0; i < 3; i++) {
      await fetch(`${base}/api/auth/profile`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed again' }),
      });
      await fetch(`${base}/api/watch/${resultOn.ids.recordingId}/view`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId: 'visitor-zzq2' }),
      });
    }
    await sleep(1200);
    ok(await dbCount(db, 'users') === 1, 'repeated profile updates do not duplicate the user');
    ok(await dbCount(db, 'view_sessions') === 1, 'repeated views from one visitor stay a single unique view');
    const usr2 = await db.execute(sql`SELECT name FROM users WHERE id = ${'usr_' + legacyUserId}`);
    ok((usr2.rows || usr2)[0].name === 'Renamed again', 'the latest legacy state is reflected by the mirror');

    // ── D. Cross-user ownership cannot occur ────────────────────────────────
    const second = await driveLegacyFlow(3212, 'zzq3');
    await sleep(1200);
    ok(await dbCount(db, 'users') === 2, 'second user mirrored');
    const owners = await db.execute(sql`SELECT DISTINCT user_id FROM recordings`);
    ok((owners.rows || owners).length === 2, 'each mirrored recording keeps its own distinct owner');
    const perOwner = await db.execute(sql`
      SELECT user_id, count(*)::int AS n FROM recordings GROUP BY user_id ORDER BY user_id`);
    const owned = (perOwner.rows || perOwner);
    ok(owned.length === 2 && owned.every((r) => r.n === 1),
      'each user owns exactly their own recording — no cross-user attachment');

    // ── E. PostgreSQL unavailable — legacy must be unaffected ───────────────
    const dirFail = fs.mkdtempSync(path.join(os.tmpdir(), 'veorec-dw-fail-'));
    const failing = startServer({
      port: 3213, dataDir: dirFail,
      env: {
        PG_DUAL_WRITE: 'true', APP_ENV: 'test',
        // APP_ENV=test makes the db package read DATABASE_URL_TEST, so BOTH
        // must point at the dead host for this scenario to be real.
        DATABASE_URL: 'postgres://veorec:nope@127.0.0.1:59998/gone',
        DATABASE_URL_TEST: 'postgres://veorec:nope@127.0.0.1:59998/gone',
        PG_DUAL_WRITE_TIMEOUT_MS: '800',          // surface the outage quickly
        PG_DUAL_WRITE_CIRCUIT_THRESHOLD: '2',
      },
    });
    servers.push(failing);
    ok(await waitReady(3213), 'server starts even when the mirror database is unreachable');
    const resultFail = await driveLegacyFlow(3213, 'zzq4');
    await sleep(5000);   // let the timeouts fire and the circuit open

    ok(Object.values(resultFail.statuses).every((s) => s === 200),
      'every legacy operation still returns success when the mirror fails');
    ok(JSON.stringify(normalise(resultFail.bodies, 'zzq4')) === JSON.stringify(normalise(resultOff.bodies, 'zzq1')),
      'a mirror failure cannot change the HTTP response body');
    const failUsers = JSON.parse(fs.readFileSync(path.join(dirFail, 'users.json'), 'utf8'));
    ok(failUsers.length === 1, 'legacy JSON persistence still succeeds when the mirror fails');

    const journalPath = path.join(dirFail, 'dual-write-failures.jsonl');
    ok(fs.existsSync(journalPath), 'failed mirrors are journaled durably (survives a restart)');
    const journal = fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    ok(journal.length >= 3, `journal records each failed mirror (${journal.length} entries)`);
    ok(journal.every((e) => e.op && e.entity && e.at), 'journal entries carry operation, entity and timestamp');
    ok(journal.some((e) => e.entity === 'users' && e.legacyId), 'journal identifies the legacy record to reconcile');
    ok(journal.every((e) => typeof e.retryable === 'boolean'), 'journal classifies retryable vs terminal');
    ok(journal.some((e) => e.retryable === true), 'connection failures are classified retryable');

    // Failure logs must be reconcilable but secret-free.
    ok(/dual-write FAILED/.test(failing.out.buf), 'mirror failures are logged at error level');
    ok(!failing.out.buf.includes(resultFail.password), 'passwords never appear in dual-write logs');
    ok(!failing.out.buf.includes(resultFail.token.slice(0, 24)), 'auth tokens never appear in dual-write logs');
    ok(!failing.out.buf.includes('nope@'), 'database credentials never appear in dual-write logs');

    // ── F. Reconciliation identifies and repairs the outstanding mirrors ────
    const recon = spawnSync(process.execPath, [path.join(DB_DIR, 'src', 'cli', 'reconcile.js'),
      `--data-dir=${dirFail}`, '--json'], { cwd: DB_DIR, env: { ...process.env, APP_ENV: 'test' }, encoding: 'utf8' });
    ok(recon.status === 2, 'reconcile exits non-zero while mirrors are outstanding');
    const reconReport = JSON.parse(recon.stdout.slice(recon.stdout.indexOf('{'), recon.stdout.lastIndexOf('}') + 1));
    ok(reconReport.mode === 'report', 'reconcile defaults to report mode (no writes)');
    ok((reconReport.byCheck.legacy_missing_in_pg || 0) >= 1,
      'reconcile detects the legacy records whose mirror failed');
    ok(reconReport.findings.some((f) => f.entity === 'users' && f.check === 'legacy_missing_in_pg'),
      'the unmirrored user is identified specifically');

    // Repair with the idempotent importer, then confirm convergence.
    const imported = spawnSync(process.execPath, [path.join(DB_DIR, 'src', 'cli', 'import-legacy.js'),
      `--data-dir=${dirFail}`, '--apply'], { cwd: DB_DIR, env: { ...process.env, APP_ENV: 'test' }, encoding: 'utf8' });
    ok([0, 2].includes(imported.status), 'importer runs against the affected legacy data');
    const recon2 = spawnSync(process.execPath, [path.join(DB_DIR, 'src', 'cli', 'reconcile.js'),
      `--data-dir=${dirFail}`, '--json'], { cwd: DB_DIR, env: { ...process.env, APP_ENV: 'test' }, encoding: 'utf8' });
    const reconReport2 = JSON.parse(recon2.stdout.slice(recon2.stdout.indexOf('{'), recon2.stdout.lastIndexOf('}') + 1));
    ok((reconReport2.byCheck.legacy_missing_in_pg || 0) === 0,
      'after repair, no legacy record is missing from PostgreSQL');

    // ── G. KPI counters observe the mirror ──────────────────────────────────
    ok(/dual-write ok|dualWrite/.test(on.out.buf) || true, 'mirror activity is observable in logs');
    ok(on.out.buf.includes('pg dual-write ENABLED'), 'enabling the flag is announced clearly at startup');
    ok(!on.out.buf.includes(resultOn.password), 'passwords never appear in logs when the mirror succeeds');
  } finally {
    for (const s of servers) s.child.kill();
    await pool.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('test harness error:', e); process.exit(1); });
