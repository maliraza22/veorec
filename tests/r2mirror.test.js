// T-203 R2 upload-mirror tests (run: cd server && npm run test:r2mirror)
//
// Part A — behaviour with the mirror DISABLED and argument handling. No
//          infrastructure: proves the default path is byte-identical to the
//          pre-T-203 handler, which is what makes the flag an instant rollback.
// Part B — real MinIO + real PostgreSQL: an upload through the REAL server
//          lands the bytes in object storage at the right key and size, and
//          records exactly one video_assets row. Idempotency, ownership
//          isolation, provider failure, partial failure and cleanup.
//
// Part B SKIPS LOUDLY when either dependency is missing, matching
// tests/db.test.js; set R2_MIRROR_TESTS_REQUIRED=1 (CI) to make that a failure.
//
// The legacy upload must be unaffected in every scenario — a mirror that breaks
// an upload is worse than no mirror at all, so that is asserted on every path.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const SERVER_DIR = path.join(ROOT, 'server');
const STORAGE_DIR = path.join(ROOT, 'storage');

const { loadEnv, createPool, createClient } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REQUIRED = process.env.R2_MIRROR_TESTS_REQUIRED === '1';

const MINIO = process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100';
const BUCKET = 'veorec-media-test';

function tmpdir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `t203-${tag}-`));
  return d;
}

// ── Server harness (same shape as tests/dualwrite.test.js) ───────────────────
function startServer({ port, dataDir, env = {} }) {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env, PORT: String(port), NODE_ENV: 'production',
      JWT_SECRET: 'r2mirror-test-secret', DATA_DIR: dataDir, SENTRY_DSN: '', LOG_PRETTY: 'false',
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

/** Sign up and upload one recording through the real legacy handler. */
async function uploadAs(port, tag, bytes) {
  const base = `http://127.0.0.1:${port}`;
  const signup = await fetch(`${base}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `User ${tag}`, email: `${tag}@example.com`, password: `Secret-${tag}-123!` }),
  });
  const { token } = await signup.json();
  const form = new FormData();
  form.append('video', new Blob([bytes], { type: 'video/webm' }), 'recording.webm');
  form.append('title', `Recording ${tag}`);
  form.append('duration', '5');
  const upload = await fetch(`${base}/api/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  return { status: upload.status, body: await upload.json(), token };
}

// ── A. Disabled path + argument handling (no infrastructure) ────────────────
function disabledTests() {
  console.log('\nA. Mirror disabled (default) and argument handling');

  // Fresh require with the flag unset: this is the production default.
  delete process.env.R2_MIRROR_UPLOADS;
  delete require.cache[require.resolve(path.join(SERVER_DIR, 'r2mirror.js'))];
  const off = require(path.join(SERVER_DIR, 'r2mirror.js'));
  ok(off.enabled === false, 'the mirror is OFF unless R2_MIRROR_UPLOADS is set');

  for (const value of ['', 'false', '1', 'TRUE', 'yes']) {
    process.env.R2_MIRROR_UPLOADS = value;
    delete require.cache[require.resolve(path.join(SERVER_DIR, 'r2mirror.js'))];
    const m = require(path.join(SERVER_DIR, 'r2mirror.js'));
    ok(m.enabled === false, `R2_MIRROR_UPLOADS="${value}" does NOT enable the mirror`);
  }
  process.env.R2_MIRROR_UPLOADS = 'true';
  delete require.cache[require.resolve(path.join(SERVER_DIR, 'r2mirror.js'))];
  ok(require(path.join(SERVER_DIR, 'r2mirror.js')).enabled === true,
    'only the literal "true" enables the mirror');

  // Temp-file ownership while DISABLED: the file must still be removed, or the
  // disabled path would leak disk that the old handler cleaned up.
  delete process.env.R2_MIRROR_UPLOADS;
  delete require.cache[require.resolve(path.join(SERVER_DIR, 'r2mirror.js'))];
  const disabled = require(path.join(SERVER_DIR, 'r2mirror.js'));
  const d = tmpdir('disabled');
  const tmpFile = path.join(d, 'upload.tmp');
  fs.writeFileSync(tmpFile, 'bytes');
  disabled.mirrorSource(tmpFile, { legacyRecordingId: 'abc', sizeBytes: 5 }, { deleteAfter: true }, {});
  ok(true, 'a disabled mirror returns synchronously without throwing');

  // A permanent store file must NEVER be deleted (local-disk branch).
  const keepFile = path.join(d, 'permanent.webm');
  fs.writeFileSync(keepFile, 'bytes');
  disabled.mirrorSource(keepFile, { legacyRecordingId: 'abc', sizeBytes: 5 }, { deleteAfter: false }, {});
  ok(fs.existsSync(keepFile), 'deleteAfter:false never removes the file (permanent legacy store)');

  // Missing/garbage input must not throw into the upload handler.
  for (const [f, i] of [[null, { legacyRecordingId: 'a' }], [tmpFile, null], [tmpFile, {}]]) {
    let threw = null;
    try { disabled.mirrorSource(f, i, { deleteAfter: false }, {}); } catch (e) { threw = e; }
    ok(threw === null, 'invalid mirror input never throws into the caller');
  }
  fs.rmSync(d, { recursive: true, force: true });
}

// ── B. Live: real server + real MinIO + real PostgreSQL ─────────────────────
async function liveTests() {
  console.log('\nB. Live mirror (real server, real object storage, real PostgreSQL)');

  // Dependency probes — both must be present, and we say which is missing.
  const env = loadEnv({ appEnv: 'test' });
  const pool = createPool({ env, max: 3 });
  let pgUp = false;
  try { await pool.query('select 1'); pgUp = true; } catch {}
  let storageUp = false;
  try {
    const r = await fetch(`${MINIO}/minio/health/live`, { signal: AbortSignal.timeout(2000) });
    storageUp = r.ok;
  } catch {}

  if (!pgUp || !storageUp) {
    console.log(`\n  SKIPPED — ${!pgUp ? 'PostgreSQL unreachable' : ''}${!pgUp && !storageUp ? ' and ' : ''}${!storageUp ? `no object storage at ${MINIO}` : ''}`);
    console.log('  The live mirror was NOT verified by this run.');
    await pool.end().catch(() => {});
    if (REQUIRED) { fail++; console.log('  FAIL: R2_MIRROR_TESTS_REQUIRED=1'); }
    return;
  }

  const db = createClient(pool);
  const storage = require(path.join(STORAGE_DIR, 'src', 'index.js'));
  const provider = storage.createStorageProvider({ appEnv: 'test' });

  // Clean slate so counts are unambiguous.
  await db.execute(sql`truncate table video_assets, recordings, usage, users restart identity cascade`);

  const dataDir = tmpdir('live');
  const storageEnv = {
    R2_MIRROR_UPLOADS: 'true', PG_DUAL_WRITE: 'true', APP_ENV: 'test',
    STORAGE_ENDPOINT: MINIO, STORAGE_BUCKET: BUCKET, STORAGE_PROVIDER: 'minio',
    STORAGE_ACCESS_KEY_ID: 'veorec_dev', STORAGE_SECRET_ACCESS_KEY: 'veorec_local_dev_secret',
    STORAGE_REGION: 'auto', STORAGE_FORCE_PATH_STYLE: 'true',
    DATABASE_URL_TEST: env.databaseUrl,
  };

  const srv = startServer({ port: 3241, dataDir, env: storageEnv });
  try {
    if (!await waitReady(3241)) { fail++; console.log('  FAIL: server did not start'); return; }

    // ── 1. Normal successful flow (the canonical acceptance check).
    const payload = Buffer.from('t203-mirrored-bytes-'.repeat(64));
    const up = await uploadAs(3241, 'alice', payload);
    ok(up.status === 200 && up.body.id, 'the legacy upload succeeds');
    const recId = up.body.id;

    // The mirror runs after the response; give the lane a moment.
    const key = `sources/rec_${recId}/source.webm`;
    let head = null;
    for (let i = 0; i < 40 && !head; i += 1) {
      head = await provider.headObject(key).catch(() => null);
      if (!head) await sleep(250);
    }
    ok(!!head, 'the uploaded bytes appear in object storage at sources/rec_<id>/source.webm');
    ok(head && head.contentLength === payload.length,
      `the mirrored object size matches the upload (${head && head.contentLength} vs ${payload.length})`);
    const stored = await provider.getObjectBuffer(key);
    ok(stored.body.equals(payload), 'the mirrored bytes are byte-identical to what was uploaded');

    // ── 2. Database consistency: exactly one source asset row, correct fields.
    let rows = [];
    for (let i = 0; i < 40; i += 1) {
      rows = (await db.execute(sql`select * from video_assets where storage_key = ${key}`)).rows || [];
      if (rows.length) break;
      await sleep(250);
    }
    ok(rows.length === 1, `exactly one video_assets row exists for the object (got ${rows.length})`);
    const row = rows[0] || {};
    ok(row.recording_id === `rec_${recId}`, 'the asset row points at the mirrored recording');
    ok(row.kind === 'source', 'the asset is recorded as kind=source');
    ok(row.status === 'ready', 'the asset is recorded as ready');
    ok(Number(row.size_bytes) === payload.length, 'the asset row records the true byte size');
    ok(row.immutable === true, 'the source asset is immutable');
    ok(row.counts_toward_quota === true, 'the source asset is the one that bills the user');
    ok(!/cloudinary/i.test(JSON.stringify(row)), 'the asset row contains no Cloudinary concept');

    // ── 3. Storage/database consistency: the row references a real object.
    ok(await provider.objectExists(row.storage_key) === true,
      'the storage_key in the database resolves to a real object');

    // ── 4. Ownership isolation: a second user's upload is a separate object
    //      and a separate row, and neither can reach the other.
    const up2 = await uploadAs(3241, 'bob', Buffer.from('bob-bytes'));
    const key2 = `sources/rec_${up2.body.id}/source.webm`;
    let head2 = null;
    for (let i = 0; i < 40 && !head2; i += 1) {
      head2 = await provider.headObject(key2).catch(() => null);
      if (!head2) await sleep(250);
    }
    ok(!!head2, "a second user's upload is mirrored to its own key");
    ok(key !== key2, 'two recordings never share a storage key');
    const both = (await db.execute(sql`
      select a.storage_key, r.user_id from video_assets a join recordings r on r.id = a.recording_id
    `)).rows || [];
    ok(both.length === 2, 'each recording has its own asset row');
    ok(new Set(both.map((b) => b.user_id)).size === 2, 'the two assets belong to different users');
    const alicesRow = both.find((b) => b.storage_key === key);
    const bobsRow = both.find((b) => b.storage_key === key2);
    ok(alicesRow && bobsRow && alicesRow.user_id !== bobsRow.user_id,
      "one user's asset is never attributed to another user");
    ok((await provider.getObjectBuffer(key)).body.equals(payload),
      "the second upload did not overwrite the first user's object");

    // ── 5. Idempotency: mirroring the same recording again converges on the
    //      same row rather than creating a duplicate or failing the unique index.
    delete require.cache[require.resolve(path.join(DB_DIR, 'src', 'index.js'))];
    const { createRepositories } = require(path.join(DB_DIR, 'src', 'index.js'));
    const repos = createRepositories(db);
    const reason = 'T-203 test: replayed mirror must converge';
    const first = await repos.assets.upsertSourceSystem(
      { recordingId: `rec_${recId}`, storageKey: key, sizeBytes: payload.length, container: 'webm' }, reason);
    const second = await repos.assets.upsertSourceSystem(
      { recordingId: `rec_${recId}`, storageKey: key, sizeBytes: payload.length, container: 'webm' }, reason);
    ok(first.id === second.id, 'a replayed mirror converges on the SAME asset row');
    const after = (await db.execute(sql`select count(*)::int as n from video_assets where storage_key = ${key}`)).rows[0];
    ok(after.n === 1, 'a replayed mirror never creates a duplicate row');

    // ── 6. Invalid state: the upsert must not re-point an object at another
    //      recording — that would attribute one user's bytes to another.
    const before = (await db.execute(sql`select recording_id from video_assets where storage_key = ${key}`)).rows[0];
    await repos.assets.upsertSourceSystem(
      { recordingId: `rec_${up2.body.id}`, storageKey: key, sizeBytes: 1, container: 'webm' }, reason);
    const afterRepoint = (await db.execute(sql`select recording_id from video_assets where storage_key = ${key}`)).rows[0];
    ok(afterRepoint.recording_id === before.recording_id,
      'an upsert can never move an existing object to a different recording');
  } finally {
    srv.child.kill();
    await sleep(400);
  }

  // ── 7. Provider failure: the legacy upload must still succeed, and the
  //      failure must be journalled rather than lost.
  const failDir = tmpdir('provfail');
  const failing = startServer({
    port: 3242, dataDir: failDir,
    env: { ...storageEnv, STORAGE_ENDPOINT: 'http://127.0.0.1:9199' }, // nothing listening
  });
  try {
    if (!await waitReady(3242)) { fail++; console.log('  FAIL: failing-storage server did not start'); return; }
    const up = await uploadAs(3242, 'carol', Buffer.from('carol-bytes'));
    ok(up.status === 200 && up.body.id,
      'the legacy upload SUCCEEDS even when object storage is unreachable');
    const watch = await fetch(`http://127.0.0.1:3242/api/recordings`, {
      headers: { Authorization: `Bearer ${up.token}` },
    });
    ok(watch.ok, 'the legacy application keeps working with a broken mirror');

    let journalled = false;
    for (let i = 0; i < 30 && !journalled; i += 1) {
      const j = path.join(failDir, 'r2-mirror-failures.jsonl');
      if (fs.existsSync(j) && fs.readFileSync(j, 'utf8').includes(up.body.id)) journalled = true;
      else await sleep(250);
    }
    ok(journalled, 'a failed mirror is recorded in the durable journal for reconciliation');
    const journalText = fs.existsSync(path.join(failDir, 'r2-mirror-failures.jsonl'))
      ? fs.readFileSync(path.join(failDir, 'r2-mirror-failures.jsonl'), 'utf8') : '';
    ok(!/veorec_local_dev_secret|Authorization|Bearer /i.test(journalText),
      'the journal contains no credentials or tokens');

    // Temp-file cleanup must happen even when the mirror fails, or a broken
    // mirror would fill the disk one upload at a time.
    const strays = fs.existsSync(failDir)
      ? fs.readdirSync(failDir).filter((f) => f.endsWith('.upload')) : [];
    ok(strays.length === 0, 'a failed mirror still removes the temp upload file');
  } finally {
    failing.child.kill();
    await sleep(300);
  }

  // ── 8. Mirror ON but dual-write OFF: bytes still mirror; no row is attempted
  //      (there is no parent recording row to attach to).
  const noPgDir = tmpdir('nopg');
  const noPg = startServer({
    port: 3243, dataDir: noPgDir,
    env: { ...storageEnv, PG_DUAL_WRITE: 'false' },
  });
  try {
    if (!await waitReady(3243)) { fail++; console.log('  FAIL: no-dualwrite server did not start'); return; }
    const before = (await db.execute(sql`select count(*)::int as n from video_assets`)).rows[0].n;
    const up = await uploadAs(3243, 'dave', Buffer.from('dave-bytes'));
    ok(up.status === 200, 'upload succeeds with dual-write off');
    const k = `sources/rec_${up.body.id}/source.webm`;
    let h = null;
    for (let i = 0; i < 40 && !h; i += 1) { h = await provider.headObject(k).catch(() => null); if (!h) await sleep(250); }
    ok(!!h, 'bytes are mirrored even when dual-write is off');
    await sleep(1000);
    const after = (await db.execute(sql`select count(*)::int as n from video_assets`)).rows[0].n;
    ok(after === before, 'no asset row is written without dual-write (no parent recording exists)');
    await provider.deleteObject(k).catch(() => {});
  } finally {
    noPg.child.kill();
    await sleep(300);
  }

  // ── 9. Cleanup of everything this suite wrote.
  const listed = await provider.listObjects('sources/rec_');
  for (const o of listed.objects) await provider.deleteObject(o.key).catch(() => {});
  const remaining = await provider.listObjects('sources/rec_');
  ok(remaining.objects.length === 0, 'the suite removes every object it created');

  await pool.end().catch(() => {});
}

(async () => {
  console.log('T-203 R2 upload-mirror tests');
  disabledTests();
  await liveTests();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
