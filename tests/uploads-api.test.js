// T-301 /api/v1/uploads tests (run: cd api && npm test)
//
// Real PostgreSQL + real object storage (MinIO). The router is mounted in an
// in-process Express app so dependencies can be substituted for the
// failure-injection cases — the database and the object store are still real,
// which is the part that matters: a mock cannot show that a transaction
// actually rolled back, or that two simultaneous completions produce one asset.
//
// A separate spawned-server check proves the flag actually mounts the router on
// the legacy server and that the legacy upload route is unaffected.
//
// SKIPS LOUDLY without infrastructure; UPLOAD_API_TESTS_REQUIRED=1 makes that a
// failure.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const API_DIR = path.join(ROOT, 'api');
const STORAGE_DIR = path.join(ROOT, 'storage');
const SERVER_DIR = path.join(ROOT, 'server');

const express = require(path.join(API_DIR, 'node_modules', 'express'));
const { loadEnv, createPool, createClient, createRepositories, withTransaction: rawTx } =
  require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));
const { createUploadRouter } = require(path.join(API_DIR, 'src', 'index.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REQUIRED = process.env.UPLOAD_API_TESTS_REQUIRED === '1';
const MINIO = process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100';
const MIN_PART = 5 * 1024 * 1024;

const RUN = crypto.randomBytes(4).toString('hex');
let n = 0;
const nextId = () => `u${RUN}${(n += 1)}`;

(async () => {
  console.log('T-301 /api/v1/uploads tests');

  const env = loadEnv({ appEnv: 'test' });
  const pool = createPool({ env, max: 8 });
  let pgUp = false;
  try { await pool.query('select 1'); pgUp = true; } catch {}
  let storageUp = false;
  try {
    const r = await fetch(`${MINIO}/minio/health/live`, { signal: AbortSignal.timeout(2000) });
    storageUp = r.ok;
  } catch {}
  if (!pgUp || !storageUp) {
    console.log(`\n  SKIPPED — ${!pgUp ? 'PostgreSQL unreachable' : ''}${!pgUp && !storageUp ? ' and ' : ''}${!storageUp ? `no object storage at ${MINIO}` : ''}`);
    console.log('  The upload API was NOT verified by this run.');
    await pool.end().catch(() => {});
    if (REQUIRED) { console.log('  FAIL: UPLOAD_API_TESTS_REQUIRED=1'); process.exit(1); }
    console.log('\n0 passed, 0 failed (skipped)');
    process.exit(0);
  }

  const db = createClient(pool);
  const storagePkg = require(path.join(STORAGE_DIR, 'src', 'index.js'));
  const provider = storagePkg.createStorageProvider({ appEnv: 'test' });

  await db.execute(sql`truncate table video_assets, upload_parts, upload_sessions, processing_jobs, recordings, users restart identity cascade`);

  // ── Harness: mount the real router with substitutable dependencies. ───────
  let currentUser = null;                    // who the fake auth reports
  let repoFactory = () => createRepositories(db);
  let txRunner = rawTx;

  const app = express();
  app.use('/api/v1', createUploadRouter({
    repositories: (...a) => repoFactory(...a),
    withTransaction: (fn) => txRunner(fn),
    storage: provider,
    keys: storagePkg.keys,
    requireAuth: (req, res, next) => {
      if (!currentUser) return res.status(401).json({ error: { code: 'unauthorized', message: 'no' } });
      req.userId = currentUser; req.id = 'req_test'; next();
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;

  const api = async (method, url, { body, headers = {}, as } = {}) => {
    if (as !== undefined) currentUser = as;
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, body: json };
  };

  // The caller authenticates with a LEGACY id; the PostgreSQL row the importer
  // and dual-write produce is `usr_<legacyId>`. Seeding it this way is what
  // makes these suites exercise the identity bridge rather than side-step it.
  const pgId = (legacyId) => `usr_${legacyId}`;
  async function seedUser(legacyId) {
    await db.execute(sql`INSERT INTO users (id,email,name,password_hash)
      VALUES (${pgId(legacyId)}, ${`${legacyId}@example.com`}, 'U', 'x') ON CONFLICT (id) DO NOTHING`);
    return legacyId;                      // callers authenticate with the legacy id
  }
  async function seedRecording(legacyUserId, rid, status = 'recording') {
    // Owned by the POSTGRESQL identity, which is what the FK references.
    await db.execute(sql`INSERT INTO recordings (id,user_id,title,status,source_kind,privacy)
      VALUES (${rid}, ${pgId(legacyUserId)}, 'T-301', ${status}, 'extension', 'unlisted') ON CONFLICT (id) DO NOTHING`);
    return rid;
  }
  const createSession = (rid, key, as, mime = 'video/webm') =>
    api('POST', '/uploads', { body: { recordingId: rid, mimeType: mime }, headers: { 'Idempotency-Key': key }, as });

  /** Presign, PUT the bytes to storage, and record the part — the real client flow. */
  async function uploadPart(sessionId, partNumber, buf, as) {
    const presign = await api('POST', `/uploads/${sessionId}/parts`,
      { body: { parts: [{ partNumber, size: buf.length }] }, as });
    if (presign.status !== 200) return { presign, put: null };
    const url = presign.body.parts[0].url;
    const put = await fetch(url, { method: 'PUT', body: buf, headers: { 'content-length': String(buf.length) } });
    const etag = (put.headers.get('etag') || '').replace(/"/g, '');
    const rec = await api('PUT', `/uploads/${sessionId}/parts/${partNumber}`,
      { body: { etag, size: buf.length, crc32c: 'AAAAAA==' }, as });
    return { presign, put, etag, rec };
  }

  try {
    // ── A. Create ────────────────────────────────────────────────────────────
    console.log('\nA. Create session');
    const alice = await seedUser(`usr_${nextId()}`);
    const rec1 = await seedRecording(alice, `rec_${nextId()}`);
    const c1 = await createSession(rec1, 'key-1', alice);
    ok(c1.status === 201, `session created (got ${c1.status})`);
    ok(!!c1.body.uploadSessionId, 'a session id is returned');
    ok(c1.body.partSize === 8 * 1024 * 1024, 'partSize is the documented 8 MiB');
    ok(c1.body.minPartSize === MIN_PART && c1.body.maxParts === 10000, 'minPartSize and maxParts match docs/06 §3');
    ok(typeof c1.body.byteCeiling === 'number' && c1.body.byteCeiling > 0, 'a byteCeiling is returned');
    ok(!!c1.body.expiresAt, 'expiresAt is returned');
    const s1 = c1.body.uploadSessionId;

    const row = (await db.execute(sql`select * from upload_sessions where id = ${s1}`)).rows[0];
    ok(row.recording_id === rec1 && row.user_id === pgId(alice),
      'the session row is bound to the recording and the POSTGRESQL owner');
    ok(row.storage_key === `sources/${rec1}/source.webm`, 'the session targets the canonical source key');
    ok(!!row.storage_upload_id, 'a storage multipart upload was created and recorded');
    ok(row.status === 'pending', 'a new session starts pending');
    ok(new Date(row.expires_at).getTime() > Date.now() + 47 * 3600 * 1000, 'the session expires ~48h out');

    // Idempotency-Key replay
    const replay = await createSession(rec1, 'key-1', alice);
    ok(replay.status === 200 && replay.body.uploadSessionId === s1,
      'retrying with the same Idempotency-Key returns the SAME session');
    ok((await db.execute(sql`select count(*)::int n from upload_sessions where recording_id = ${rec1}`)).rows[0].n === 1,
      'the replay created no second session');

    // A different key for the same recording still returns the live session,
    // never a second multipart upload against the same key.
    const second = await createSession(rec1, 'key-2', alice);
    ok(second.status === 200 && second.body.uploadSessionId === s1,
      'a second session for the same recording returns the existing one');

    // Validation
    ok((await api('POST', '/uploads', { body: { recordingId: rec1, mimeType: 'video/webm' }, as: alice })).status === 400,
      'a missing Idempotency-Key is rejected');
    ok((await createSession(rec1, 'k3', alice, 'application/zip')).status === 400, 'a disallowed mimeType is rejected');
    ok((await createSession('rec_does_not_exist', 'k4', alice)).status === 404, 'an unknown recording is 404');
    const doneRec = await seedRecording(alice, `rec_${nextId()}`, 'ready');
    ok((await createSession(doneRec, 'k5', alice)).status === 409,
      'a recording in a non-uploadable state is 409');

    // ── B. Ownership ─────────────────────────────────────────────────────────
    console.log('\nB. Ownership and authorization');
    const bob = await seedUser(`usr_${nextId()}`);
    ok((await api('GET', `/uploads/${s1}`, { as: bob })).status === 404,
      "another user's session is 404, not 403 — the id is never confirmed");
    ok((await api('POST', `/uploads/${s1}/parts`, { body: { parts: [1] }, as: bob })).status === 404,
      'a cross-user presign attempt is refused');
    ok((await api('PUT', `/uploads/${s1}/parts/1`, { body: { etag: 'x', size: 10 }, as: bob })).status === 404,
      'a cross-user part record is refused');
    ok((await api('POST', `/uploads/${s1}/complete`, { body: { parts: [] }, as: bob })).status === 404,
      'a cross-user completion is refused');
    ok((await api('DELETE', `/uploads/${s1}`, { as: bob })).status === 404,
      'a cross-user abort is refused');
    currentUser = null;
    ok((await api('GET', `/uploads/${s1}`)).status === 401, 'an unauthenticated request is 401');
    const bobRec = await seedRecording(bob, `rec_${nextId()}`);
    ok((await createSession(bobRec, 'k1-bob', alice)).status === 404,
      "a user cannot open a session against another user's recording");

    // ── C. Presign + part recording ──────────────────────────────────────────
    console.log('\nC. Parts');
    const body1 = Buffer.from('t301-single-part-payload');
    const up1 = await uploadPart(s1, 1, body1, alice);
    ok(up1.presign.status === 200 && up1.presign.body.parts[0].url, 'a presigned part URL is issued');
    ok(!/X-Amz-Signature/.test(JSON.stringify(up1.presign.body.parts[0].partNumber)), 'part numbers are plain data');
    ok(up1.put.ok, 'the client PUTs the bytes straight to storage');
    ok(up1.rec.status === 200, 'the part is recorded server-side');
    ok((await db.execute(sql`select status from upload_sessions where id = ${s1}`)).rows[0].status === 'active',
      'the first presign moves the session pending → active');

    // Idempotent part record
    const again = await api('PUT', `/uploads/${s1}/parts/1`,
      { body: { etag: up1.etag, size: body1.length, crc32c: 'AAAAAA==' }, as: alice });
    ok(again.status === 200, 're-recording the same part succeeds');
    ok((await db.execute(sql`select count(*)::int n from upload_parts where upload_session_id = ${s1}`)).rows[0].n === 1,
      'a duplicate part record does not create a second row');

    // Invalid input
    ok((await api('POST', `/uploads/${s1}/parts`, { body: { parts: [0] }, as: alice })).status === 400,
      'part number 0 is rejected');
    ok((await api('POST', `/uploads/${s1}/parts`, { body: { parts: [10001] }, as: alice })).status === 400,
      'a part number above the S3 limit is rejected');
    ok((await api('POST', `/uploads/${s1}/parts`, { body: { parts: [1, 1] }, as: alice })).status === 400,
      'a duplicate part number in one batch is rejected');
    ok((await api('POST', `/uploads/${s1}/parts`, { body: { parts: new Array(21).fill(0).map((_, i) => i + 1) }, as: alice })).status === 400,
      'more than 20 parts per presign call is rejected');
    ok((await api('POST', `/uploads/${s1}/parts`, { body: {}, as: alice })).status === 400, 'an empty presign body is rejected');
    ok((await api('PUT', `/uploads/${s1}/parts/1`, { body: { size: 5 }, as: alice })).status === 400,
      'recording a part without an etag is rejected');

    // Byte ceiling at presign
    const ceilingRes = await api('POST', `/uploads/${s1}/parts`,
      { body: { parts: [{ partNumber: 2, size: 999 * 1024 * 1024 }] }, as: alice });
    ok(ceilingRes.status === 403 && ceilingRes.body.error.code === 'storage_limit',
      'presigning beyond the byte ceiling is refused (a hostile client cannot mint the URL)');
    ok(ceilingRes.body.error.upgradeRequired === true, 'the paywall error carries upgradeRequired');

    // ── D. Status / resume ───────────────────────────────────────────────────
    console.log('\nD. Status and resume');
    const status = await api('GET', `/uploads/${s1}`, { as: alice });
    ok(status.status === 200 && status.body.status === 'active', 'status is returned');
    ok(status.body.parts.length === 1 && status.body.parts[0].partNumber === 1, 'recorded parts are listed');
    ok(status.body.parts[0].etag === up1.etag, 'the listed part carries its etag');

    // Storage wins: delete our row, the live part must still be reported.
    await db.execute(sql`delete from upload_parts where upload_session_id = ${s1}`);
    const resumed = await api('GET', `/uploads/${s1}`, { as: alice });
    ok(resumed.body.parts.length === 1,
      'a part missing from our rows is still reported from storage (storage wins)');

    // ── E. Completion ────────────────────────────────────────────────────────
    console.log('\nE. Completion');
    const complete1 = await api('POST', `/uploads/${s1}/complete`,
      { body: { parts: [{ partNumber: 1, etag: up1.etag, size: body1.length }], clientDuration: 5 }, as: alice });
    ok(complete1.status === 200, `completion succeeds (got ${complete1.status})`);
    ok(complete1.body.status === 'uploaded' && complete1.body.recordingId === rec1, 'the canonical result is returned');

    const obj = await provider.headObject(`sources/${rec1}/source.webm`);
    ok(obj.contentLength === body1.length, 'the object is assembled in storage at the right size');

    const sess = (await db.execute(sql`select * from upload_sessions where id = ${s1}`)).rows[0];
    ok(sess.status === 'completed' && sess.completed_at, 'the session is completed and stamped');
    const recRow = (await db.execute(sql`select * from recordings where id = ${rec1}`)).rows[0];
    ok(recRow.status === 'uploaded', 'the recording moves to uploaded');
    ok(Number(recRow.size_bytes) === body1.length, 'the recording records the REAL stored size');
    const assetRows = (await db.execute(sql`select * from video_assets where recording_id = ${rec1}`)).rows;
    ok(assetRows.length === 1 && assetRows[0].kind === 'source', 'exactly one source asset row exists');
    ok(assetRows[0].immutable === true && assetRows[0].counts_toward_quota === true,
      'the source asset is immutable and is the billed asset');

    // Outbox probe row — written INSIDE the transaction (docs/10 §3).
    const jobs = (await db.execute(sql`select * from processing_jobs where recording_id = ${rec1}`)).rows;
    ok(jobs.length === 1 && jobs[0].queue === 'probe' && jobs[0].status === 'queued',
      'a queued probe job row is written as a transactional outbox entry');

    // Idempotent completion
    const complete2 = await api('POST', `/uploads/${s1}/complete`,
      { body: { parts: [{ partNumber: 1, etag: up1.etag, size: body1.length }] }, as: alice });
    ok(complete2.status === 200 && complete2.body.recordingId === rec1,
      'a repeated completion replays the canonical result');
    ok((await db.execute(sql`select count(*)::int n from video_assets where recording_id = ${rec1}`)).rows[0].n === 1,
      'a repeated completion creates NO second asset');
    ok((await db.execute(sql`select count(*)::int n from processing_jobs where recording_id = ${rec1}`)).rows[0].n === 1,
      'a repeated completion creates NO second probe job');

    // Post-completion transitions
    ok((await api('POST', `/uploads/${s1}/parts`, { body: { parts: [2] }, as: alice })).status === 409,
      'presigning against a completed session is refused');
    ok((await api('DELETE', `/uploads/${s1}`, { as: alice })).status === 409,
      'a completed upload cannot be aborted');

    // ── F. Manifest validation ───────────────────────────────────────────────
    console.log('\nF. Manifest validation');
    const rec2 = await seedRecording(alice, `rec_${nextId()}`);
    const s2 = (await createSession(rec2, 'key-m', alice)).body.uploadSessionId;
    const p1 = await uploadPart(s2, 1, Buffer.from('manifest-test'), alice);
    const bad = (body) => api('POST', `/uploads/${s2}/complete`, { body, as: alice });
    ok((await bad({ parts: [] })).status === 422, 'an empty manifest is rejected');
    ok((await bad({ parts: [{ partNumber: 2, etag: p1.etag, size: 10 }] })).status === 422,
      'a manifest not starting at part 1 is rejected');
    ok((await bad({ parts: [{ partNumber: 1, etag: p1.etag, size: 10 }, { partNumber: 3, etag: 'x', size: 10 }] })).status === 422,
      'a gap in the part numbers is rejected');
    ok((await bad({ parts: [{ partNumber: 1, size: 10 }] })).status === 422, 'a manifest entry without an etag is rejected');
    ok((await bad({ parts: [{ partNumber: 1, etag: p1.etag, size: 1024 }, { partNumber: 2, etag: 'y', size: 10 }] })).status === 422,
      'a non-final part below the 5 MiB floor is rejected');
    const over = await bad({ parts: [{ partNumber: 1, etag: p1.etag, size: 999 * 1024 * 1024 }] });
    ok(over.status === 422 && over.body.error.code === 'upload_manifest_invalid',
      'a manifest exceeding the byte ceiling is rejected');
    ok((await db.execute(sql`select status from upload_sessions where id = ${s2}`)).rows[0].status === 'aborted',
      'an over-ceiling manifest aborts the session rather than leaving it live');
    ok((await db.execute(sql`select count(*)::int n from video_assets where recording_id = ${rec2}`)).rows[0].n === 0,
      'a rejected manifest creates no asset row');

    // ── G. Multi-part (a real 5 MiB first part) ──────────────────────────────
    console.log('\nG. Multipart');
    const rec3 = await seedRecording(alice, `rec_${nextId()}`);
    const s3 = (await createSession(rec3, 'key-mp', alice)).body.uploadSessionId;
    const partA = Buffer.alloc(MIN_PART, 0x61);
    const partB = Buffer.from('tail');
    const a1 = await uploadPart(s3, 1, partA, alice);
    const a2 = await uploadPart(s3, 2, partB, alice);
    const doneMp = await api('POST', `/uploads/${s3}/complete`, {
      body: { parts: [
        { partNumber: 1, etag: a1.etag, size: partA.length },
        { partNumber: 2, etag: a2.etag, size: partB.length }] }, as: alice });
    ok(doneMp.status === 200, 'a two-part upload completes');
    const mpObj = await provider.getObjectBuffer(`sources/${rec3}/source.webm`);
    ok(mpObj.body.length === partA.length + partB.length, 'the assembled object is the sum of its parts');
    ok(mpObj.body.subarray(MIN_PART).equals(partB), 'the parts are assembled in order');

    // ── H. Crash recovery + concurrency (the acceptance criterion) ──────────
    console.log('\nH. Crash recovery and concurrent completion');
    const rec4 = await seedRecording(alice, `rec_${nextId()}`);
    const s4res = await createSession(rec4, 'key-crash', alice);
    const s4 = s4res.body.uploadSessionId;
    const b4 = Buffer.from('crash-between-storage-and-db');
    const u4 = await uploadPart(s4, 1, b4, alice);
    // Simulate a crash AFTER storage completed but BEFORE the transaction: do
    // the storage completion out of band, then ask the API to complete.
    const s4row = (await db.execute(sql`select * from upload_sessions where id = ${s4}`)).rows[0];
    await provider.completeMultipartUpload(s4row.storage_key, s4row.storage_upload_id,
      [{ partNumber: 1, etag: u4.etag }]);
    const recovered = await api('POST', `/uploads/${s4}/complete`,
      { body: { parts: [{ partNumber: 1, etag: u4.etag, size: b4.length }] }, as: alice });
    ok(recovered.status === 200,
      'completion CONVERGES after a crash between storage completion and the transaction');
    ok((await db.execute(sql`select status from upload_sessions where id = ${s4}`)).rows[0].status === 'completed',
      'the recovered session ends completed');
    ok((await db.execute(sql`select count(*)::int n from video_assets where recording_id = ${rec4}`)).rows[0].n === 1,
      'crash recovery creates exactly one asset');

    // Concurrent completion: two simultaneous requests, one canonical outcome.
    const rec5 = await seedRecording(alice, `rec_${nextId()}`);
    const s5 = (await createSession(rec5, 'key-race', alice)).body.uploadSessionId;
    const b5 = Buffer.from('concurrent-completion');
    const u5 = await uploadPart(s5, 1, b5, alice);
    const manifest5 = { parts: [{ partNumber: 1, etag: u5.etag, size: b5.length }] };
    const [r1, r2] = await Promise.all([
      api('POST', `/uploads/${s5}/complete`, { body: manifest5, as: alice }),
      api('POST', `/uploads/${s5}/complete`, { body: manifest5, as: alice }),
    ]);
    ok([r1.status, r2.status].every((s) => s === 200 || s === 409),
      `concurrent completions both resolve without a 500 (${r1.status}/${r2.status})`);
    ok((await db.execute(sql`select count(*)::int n from video_assets where recording_id = ${rec5}`)).rows[0].n === 1,
      'two simultaneous completions create exactly ONE asset row');
    ok((await db.execute(sql`select count(*)::int n from processing_jobs where recording_id = ${rec5}`)).rows[0].n === 1,
      'two simultaneous completions enqueue exactly ONE probe job');

    // ── I. Transaction rollback ──────────────────────────────────────────────
    console.log('\nI. Transaction rollback on failure');
    const rec6 = await seedRecording(alice, `rec_${nextId()}`);
    const s6 = (await createSession(rec6, 'key-rollback', alice)).body.uploadSessionId;
    const b6 = Buffer.from('rollback-case');
    const u6 = await uploadPart(s6, 1, b6, alice);
    // Inject a failure at the LAST step inside the transaction (the outbox
    // write). Everything before it must roll back with it.
    txRunner = (fn) => rawTx(async (tx) => {
      const wrapped = { ...tx, jobs: { ...tx.jobs, enqueue: async () => { throw new Error('injected outbox failure'); } } };
      return fn(wrapped);
    });
    const failed = await api('POST', `/uploads/${s6}/complete`,
      { body: { parts: [{ partNumber: 1, etag: u6.etag, size: b6.length }] }, as: alice });
    txRunner = rawTx;
    ok(failed.status >= 500, `an injected transaction failure surfaces as a server error (got ${failed.status})`);
    ok(failed.body && failed.body.error && !/injected outbox failure/.test(JSON.stringify(failed.body)),
      'the internal failure detail is NOT leaked to the caller');
    const s6row = (await db.execute(sql`select status from upload_sessions where id = ${s6}`)).rows[0];
    ok(s6row.status !== 'completed', 'the session was NOT marked completed');
    ok((await db.execute(sql`select status from recordings where id = ${rec6}`)).rows[0].status !== 'uploaded',
      'the recording was NOT marked uploaded');
    ok((await db.execute(sql`select count(*)::int n from video_assets where recording_id = ${rec6}`)).rows[0].n === 0,
      'NO asset row survived the rolled-back transaction');
    ok((await db.execute(sql`select count(*)::int n from processing_jobs where recording_id = ${rec6}`)).rows[0].n === 0,
      'no probe job survived the rolled-back transaction');
    // …and the client can simply retry.
    const retried = await api('POST', `/uploads/${s6}/complete`,
      { body: { parts: [{ partNumber: 1, etag: u6.etag, size: b6.length }] }, as: alice });
    ok(retried.status === 200, 'retrying after a rolled-back completion succeeds');
    ok((await db.execute(sql`select count(*)::int n from video_assets where recording_id = ${rec6}`)).rows[0].n === 1,
      'the retry creates exactly one asset');

    // ── J. Storage failure + entitlement ─────────────────────────────────────
    console.log('\nJ. Storage failure and entitlement');
    const rec7 = await seedRecording(alice, `rec_${nextId()}`);
    const brokenApp = express();
    const brokenProvider = {
      createMultipartUpload: async () => { const e = new Error('down'); e.code = 'provider_unavailable'; e.retryable = true; throw e; },
    };
    brokenApp.use('/api/v1', createUploadRouter({
      repositories: () => createRepositories(db), withTransaction: rawTx,
      storage: brokenProvider, keys: storagePkg.keys,
      requireAuth: (req, _res, next) => { req.userId = alice; req.id = 'req_t'; next(); },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    }));
    const bsrv = await new Promise((r) => { const x = brokenApp.listen(0, '127.0.0.1', () => r(x)); });
    const bres = await fetch(`http://127.0.0.1:${bsrv.address().port}/api/v1/uploads`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'k-broken' },
      body: JSON.stringify({ recordingId: rec7, mimeType: 'video/webm' }),
    });
    const bbody = await bres.json();
    ok(bres.status === 503 && bbody.error.code === 'storage_unavailable',
      `a storage outage maps to 503 storage_unavailable (got ${bres.status})`);
    ok(!/bucket|endpoint|aws|s3/i.test(JSON.stringify(bbody)), 'no storage internals leak to the caller');
    ok((await db.execute(sql`select count(*)::int n from upload_sessions where recording_id = ${rec7}`)).rows[0].n === 0,
      'no session row is left behind when storage fails');
    bsrv.close();

    // Entitlement refuses at completion, with the real size.
    const rec8 = await seedRecording(alice, `rec_${nextId()}`);
    const entApp = express();
    entApp.use('/api/v1', createUploadRouter({
      repositories: () => createRepositories(db), withTransaction: rawTx,
      storage: provider, keys: storagePkg.keys,
      requireAuth: (req, _res, next) => { req.userId = alice; req.id = 'req_t'; next(); },
      entitlements: {
        async byteCeiling() { return 512 * 1024 * 1024; },
        async checkAtComplete() {
          return { allowed: false, code: 'video_limit', message: 'Plan limit reached.', meta: { plan: 'free' } };
        },
      },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    }));
    const esrv = await new Promise((r) => { const x = entApp.listen(0, '127.0.0.1', () => r(x)); });
    const ebase = `http://127.0.0.1:${esrv.address().port}/api/v1`;
    const ecreate = await (await fetch(`${ebase}/uploads`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'k-ent' },
      body: JSON.stringify({ recordingId: rec8, mimeType: 'video/webm' }),
    })).json();
    const es = ecreate.uploadSessionId;
    const eb = Buffer.from('entitlement-case');
    const epre = await (await fetch(`${ebase}/uploads/${es}/parts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ partNumber: 1, size: eb.length }] }),
    })).json();
    const eput = await fetch(epre.parts[0].url, { method: 'PUT', body: eb, headers: { 'content-length': String(eb.length) } });
    const eetag = (eput.headers.get('etag') || '').replace(/"/g, '');
    const edone = await fetch(`${ebase}/uploads/${es}/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ partNumber: 1, etag: eetag, size: eb.length }] }),
    });
    const ebody = await edone.json();
    ok(edone.status === 403 && ebody.error.code === 'video_limit',
      `entitlement rejection at completion returns 403 (got ${edone.status})`);
    ok(ebody.error.upgradeRequired === true, 'the entitlement rejection is a paywall error');
    ok((await db.execute(sql`select status from recordings where id = ${rec8}`)).rows[0].status === 'rejected_limit',
      'the recording is marked rejected_limit');
    ok((await db.execute(sql`select count(*)::int n from video_assets where recording_id = ${rec8}`)).rows[0].n === 0,
      'a rejected upload creates no asset row');
    ok(await provider.objectExists(`sources/${rec8}/source.webm`) === true,
      'the uploaded bytes are NOT deleted — an upgrade can still rescue them');
    esrv.close();

    // ── K. Abort ─────────────────────────────────────────────────────────────
    console.log('\nK. Abort');
    const rec9 = await seedRecording(alice, `rec_${nextId()}`);
    const s9 = (await createSession(rec9, 'key-abort', alice)).body.uploadSessionId;
    await uploadPart(s9, 1, Buffer.from('to-be-aborted'), alice);
    const ab1 = await api('DELETE', `/uploads/${s9}`, { as: alice });
    ok(ab1.status === 200 && ab1.body.status === 'aborted', 'a session aborts');
    const ab2 = await api('DELETE', `/uploads/${s9}`, { as: alice });
    ok(ab2.status === 200, 'aborting an already-aborted session succeeds (idempotent)');
    ok(await provider.objectExists(`sources/${rec9}/source.webm`) === false,
      'an aborted upload leaves no object behind');
    ok((await api('POST', `/uploads/${s9}/parts`, { body: { parts: [2] }, as: alice })).status === 409,
      'an aborted session cannot be presigned against');
    ok((await api('POST', `/uploads/${s9}/complete`, { body: { parts: [{ partNumber: 1, etag: 'x', size: 1 }] }, as: alice })).status === 409,
      'an aborted session cannot be completed');

    // Expiry
    const rec10 = await seedRecording(alice, `rec_${nextId()}`);
    const s10 = (await createSession(rec10, 'key-exp', alice)).body.uploadSessionId;
    await db.execute(sql`update upload_sessions set expires_at = now() - interval '1 hour' where id = ${s10}`);
    const expired = await api('POST', `/uploads/${s10}/parts`, { body: { parts: [1] }, as: alice });
    ok(expired.status === 409 && expired.body.error.code === 'upload_session_expired',
      'an expired session refuses new presigns');

    // ── L. Boundaries ────────────────────────────────────────────────────────
    console.log('\nL. Boundaries');
    const routerSrc = fs.readFileSync(path.join(API_DIR, 'src', 'uploads.router.js'), 'utf8');
    const code = routerSrc.split('\n').filter((l) => {
      const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    }).join('\n');
    ok(!/@aws-sdk|S3Client|PutObjectCommand/.test(code), 'the API layer contains no storage SDK');
    ok(!/cloudinary/i.test(code), 'the API layer contains no Cloudinary logic');
    ok(!/\bsql`|SELECT |INSERT |UPDATE .* SET |db\.execute/i.test(code), 'the API layer contains no raw SQL');
    ok(!/drizzle/i.test(code), 'the API layer does not reach past the repositories');
    const errSrc = fs.readFileSync(path.join(API_DIR, 'src', 'errors.js'), 'utf8');
    ok(/requestId/.test(errSrc), 'errors carry a requestId per docs/08 §2');

    // Error shape is the NESTED v1 contract, not the flat legacy one.
    const shape = await api('GET', '/uploads/nope', { as: alice });
    ok(shape.status === 404 && shape.body.error && typeof shape.body.error.code === 'string'
      && typeof shape.body.error.message === 'string',
      'errors use the nested /api/v1 contract { error: { code, message, requestId } }');
    ok(typeof shape.body.error !== 'string', 'the v1 shape is not the flat legacy shape');

    // ── S. Single-PUT mode (T-305, docs/06 §12) ──────────────────────────────
    // Its own block: the names below are local to this section.
    {
    console.log('\nS. Single-PUT mode');
    const { SINGLE_MAX_BYTES } = require(path.join(API_DIR, 'src', 'uploads.router.js'));
    ok(SINGLE_MAX_BYTES === 33554432, 'the single-mode ceiling is exactly 33,554,432 bytes (docs/06 §12)');
    const sBytes = crypto.randomBytes(1_234_567);          // well under the 5 MiB part floor: single mode only
    const sRec = await seedRecording(alice, `rec_${nextId()}`);
    const sKey = `single-${nextId()}`;

    // Validation before anything is created.
    let sr = await api('POST', '/uploads', { as: alice, headers: { 'Idempotency-Key': `${sKey}-nosize` },
      body: { recordingId: sRec, mimeType: 'video/webm', mode: 'single' } });
    ok(sr.status === 400 && sr.body.error.code === 'invalid_request', 'single mode requires sizeBytes');
    sr = await api('POST', '/uploads', { as: alice, headers: { 'Idempotency-Key': `${sKey}-big` },
      body: { recordingId: sRec, mimeType: 'video/webm', mode: 'single', sizeBytes: SINGLE_MAX_BYTES + 1 } });
    ok(sr.status === 400 && /multipart/.test(sr.body.error.message), 'a file over 32 MiB is refused for single mode');
    sr = await api('POST', '/uploads', { as: alice, headers: { 'Idempotency-Key': `${sKey}-mode` },
      body: { recordingId: sRec, mimeType: 'video/webm', mode: 'chunked', sizeBytes: 10 } });
    ok(sr.status === 400, 'an unknown mode is refused');
    let openBefore = (await db.execute(sql`select count(*)::int n from upload_sessions where recording_id = ${sRec}`)).rows[0].n;
    ok(openBefore === 0, 'refused creates left no session row behind');

    // Create.
    const created = await api('POST', '/uploads', { as: alice, headers: { 'Idempotency-Key': sKey },
      body: { recordingId: sRec, mimeType: 'video/webm', mode: 'single', sizeBytes: sBytes.length } });
    ok(created.status === 201 && created.body.mode === 'single', 'a single-PUT session is created');
    ok(typeof created.body.uploadUrl === 'string' && /^http/.test(created.body.uploadUrl),
      'the create response carries ONE presigned PUT URL');
    ok(!/uploadUrl/.test(JSON.stringify(created.body.parts || null)), 'no part URLs are involved');
    ok(created.body.byteCeiling === sBytes.length || created.body.byteCeiling === SINGLE_MAX_BYTES
      || created.body.byteCeiling <= SINGLE_MAX_BYTES, 'the byte ceiling never exceeds the single-mode ceiling');
    ok(created.body.uploadHeaders && created.body.uploadHeaders['Content-Type'] === 'video/webm'
      && created.body.uploadHeaders['Content-Length'] === sBytes.length, 'the headers the PUT must send are stated');
    const sRow = (await db.execute(sql`select storage_upload_id, mode, part_size from upload_sessions where id = ${created.body.uploadSessionId}`)).rows[0];
    ok(sRow.storage_upload_id === null, 'NO multipart upload id — nothing multipart was opened');
    ok(sRow.mode === 'single' && Number(sRow.part_size) === sBytes.length, 'the declared size is the single "part"');
    const sId = created.body.uploadSessionId;

    // Replay returns the same session with a freshly minted URL.
    const replay = await api('POST', '/uploads', { as: alice, headers: { 'Idempotency-Key': sKey },
      body: { recordingId: sRec, mimeType: 'video/webm', mode: 'single', sizeBytes: sBytes.length } });
    ok(replay.status === 200 && replay.body.uploadSessionId === sId && typeof replay.body.uploadUrl === 'string',
      'a replayed create returns the SAME session and a usable URL');

    // Part endpoints refuse a single session.
    sr = await api('POST', `/uploads/${sId}/parts`, { as: alice, body: { parts: [1] } });
    ok(sr.status === 409 && sr.body.error.code === 'invalid_state', 'presigning parts on a single session is refused');
    sr = await api('PUT', `/uploads/${sId}/parts/1`, { as: alice, body: { etag: 'x', size: 1 } });
    ok(sr.status === 409, 'recording a part on a single session is refused');

    // Ownership: another user cannot see it.
    sr = await api('GET', `/uploads/${sId}`, { as: bob });
    ok(sr.status === 404, 'another user cannot see the single session');
    sr = await api('GET', `/uploads/${sId}`, { as: alice });
    ok(sr.status === 200 && sr.body.mode === 'single', 'the owner sees mode:"single" on GET');

    // Completing before the PUT: nothing there, nothing changed, session still usable.
    sr = await api('POST', `/uploads/${sId}/complete`, { as: alice, body: { parts: [] } });
    ok(sr.status === 409 && sr.body.error.code === 'upload_object_missing', 'completing before the PUT is refused');
    sr = await api('GET', `/uploads/${sId}`, { as: alice });
    ok(sr.status === 200 && (sr.body.status === 'pending' || sr.body.status === 'active'), 'the session survives that refusal');
    sr = await api('POST', `/uploads/${sId}/complete`, { as: alice, body: { parts: [{ partNumber: 1, etag: 'x', size: 1 }] } });
    ok(sr.status === 422 && sr.body.error.code === 'upload_manifest_invalid', 'a non-empty manifest is refused for single mode');

    // The signed Content-Length is ENFORCED BY STORAGE: a different size is refused.
    const putWrong = await fetch(created.body.uploadUrl, { method: 'PUT',
      headers: { 'Content-Type': 'video/webm' }, body: sBytes.subarray(0, sBytes.length - 1) });
    ok(putWrong.status === 403 || putWrong.status === 400,
      `storage refuses a PUT whose size differs from the signed Content-Length (${putWrong.status})`);
    ok(!(await provider.headObject(`sources/${sRec}/source.webm`).catch(() => null)),
      'and nothing was stored');
    // The exact size succeeds — browser-direct, never through the API.
    const putOk = await fetch(created.body.uploadUrl, { method: 'PUT',
      headers: { 'Content-Type': 'video/webm' }, body: sBytes });
    ok(putOk.status === 200, 'the exact-size PUT succeeds');
    const head = await provider.headObject(`sources/${sRec}/source.webm`);
    ok(head.contentLength === sBytes.length, 'the object is present at the exact size');

    // Complete: HEAD-verified, one transaction, same outbox row as multipart.
    const done = await api('POST', `/uploads/${sId}/complete`, { as: alice, body: { parts: [] } });
    ok(done.status === 200 && done.body.status === 'uploaded' && done.body.recordingId === sRec,
      'completion finalises the recording');
    const recRow = (await db.execute(sql`select status, size_bytes from recordings where id = ${sRec}`)).rows[0];
    ok(recRow.status === 'uploaded' && Number(recRow.size_bytes) === sBytes.length, 'the recording row is uploaded with the real size');
    const assetRows = (await db.execute(sql`select kind, status, size_bytes from video_assets where recording_id = ${sRec}`)).rows;
    ok(assetRows.length === 1 && assetRows[0].kind === 'source' && assetRows[0].status === 'ready'
      && Number(assetRows[0].size_bytes) === sBytes.length, 'exactly one READY source asset row');
    const jobRows = (await db.execute(sql`select queue from processing_jobs where recording_id = ${sRec}`)).rows;
    ok(jobRows.length === 1 && jobRows[0].queue === 'probe', 'the probe job is in the outbox, same as multipart');
    const again = await api('POST', `/uploads/${sId}/complete`, { as: alice, body: { parts: [] } });
    ok(again.status === 200 && again.body.status === 'uploaded', 'a replayed completion is idempotent');
    ok((await db.execute(sql`select count(*)::int n from video_assets where recording_id = ${sRec}`)).rows[0].n === 1,
      'and creates no second asset');

    // The resulting object is playable through a signed GET (what T-302 mints as playbackUrl).
    const playUrl = await provider.getSignedDownloadUrl(`sources/${sRec}/source.webm`, { expiresIn: 60 });
    const played = await fetch(playUrl);
    const playedBytes = Buffer.from(await played.arrayBuffer());
    ok(played.status === 200 && playedBytes.equals(sBytes), 'the stored bytes are byte-identical and retrievable via a signed URL');

    // Abort of an INCOMPLETE single session removes its object; a completed one cannot be aborted.
    sr = await api('DELETE', `/uploads/${sId}`, { as: alice });
    ok(sr.status === 409, 'a completed single session cannot be aborted (the recording is safe)');
    const aRec = await seedRecording(alice, `rec_${nextId()}`);
    const aSes = await api('POST', '/uploads', { as: alice, headers: { 'Idempotency-Key': `${sKey}-abort` },
      body: { recordingId: aRec, mimeType: 'video/mp4', mode: 'single', sizeBytes: 100 } });
    await fetch(aSes.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: crypto.randomBytes(100) });
    ok(!!(await provider.headObject(`sources/${aRec}/source.mp4`).catch(() => null)), 'an object landed for the session to be aborted');
    sr = await api('DELETE', `/uploads/${aSes.body.uploadSessionId}`, { as: alice });
    ok(sr.status === 200 && sr.body.status === 'aborted', 'the incomplete single session aborts');
    ok(!(await provider.headObject(`sources/${aRec}/source.mp4`).catch(() => null)), 'and its orphaned object is removed');

    // Plan ceiling below 32 MiB is respected (entitlement, not the protocol constant).
    {
      const tight = express();
      tight.use('/api/v1', createUploadRouter({
        repositories: (...a) => repoFactory(...a), withTransaction: (fn) => txRunner(fn),
        storage: provider, keys: storagePkg.keys,
        requireAuth: (req, res, next) => { req.userId = alice; req.id = 'req_t'; next(); },
        entitlements: { async byteCeiling() { return 1024; }, async checkAtComplete() { return { allowed: true }; } },
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      }));
      const ts = await new Promise((resolve) => { const s2 = tight.listen(0, '127.0.0.1', () => resolve(s2)); });
      const tRec = await seedRecording(alice, `rec_${nextId()}`);
      const tr = await fetch(`http://127.0.0.1:${ts.address().port}/api/v1/uploads`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': `${sKey}-tight` },
        body: JSON.stringify({ recordingId: tRec, mimeType: 'video/webm', mode: 'single', sizeBytes: 2048 }) });
      const tb = await tr.json();
      ok(tr.status === 403 && tb.error.code === 'storage_limit' && tb.error.upgradeRequired === true,
        'a declared size above the PLAN ceiling is refused at create, as a paywall');
      ts.close();
    }

    // Multipart is untouched: a default-mode create still opens a multipart upload.
    const mpRec = await seedRecording(alice, `rec_${nextId()}`);
    const mp = await api('POST', '/uploads', { as: alice, headers: { 'Idempotency-Key': `${sKey}-mp` },
      body: { recordingId: mpRec, mimeType: 'video/webm' } });
    const mpRow = (await db.execute(sql`select storage_upload_id, mode from upload_sessions where id = ${mp.body.uploadSessionId}`)).rows[0];
    ok(mp.status === 201 && mp.body.mode === 'multipart' && typeof mpRow.storage_upload_id === 'string' && mpRow.mode === 'multipart',
      'multipart mode still opens a real multipart upload and is the default');
    ok(mp.body.uploadUrl === undefined, 'a multipart session carries no single PUT URL');
    await api('DELETE', `/uploads/${mp.body.uploadSessionId}`, { as: alice });
    }
  } finally {
    server.close();
  }

  // ── M. The flag actually mounts on the legacy server ──────────────────────
  console.log('\nM. Legacy server mount');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't301-'));
  const child = spawn(process.execPath, ['index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env, PORT: '3271', NODE_ENV: 'production', JWT_SECRET: 't301', DATA_DIR: dataDir,
      LOG_PRETTY: 'false', SENTRY_DSN: '', V1_UPLOAD_API: 'true', APP_ENV: 'test',
      STORAGE_ENDPOINT: MINIO, STORAGE_BUCKET: 'veorec-media-test', STORAGE_PROVIDER: 'minio',
      STORAGE_ACCESS_KEY_ID: 'veorec_dev', STORAGE_SECRET_ACCESS_KEY: 'veorec_local_dev_secret',
      STORAGE_REGION: 'auto', STORAGE_FORCE_PATH_STYLE: 'true', DATABASE_URL_TEST: env.databaseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) {
      try { ready = (await fetch('http://127.0.0.1:3271/api/plans')).ok; } catch {}
      if (!ready) await sleep(250);
    }
    ok(ready, 'the legacy server boots with V1_UPLOAD_API=true');
    const unauth = await fetch('http://127.0.0.1:3271/api/v1/uploads', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    ok(unauth.status === 401, 'the mounted v1 route requires authentication');
    // The message gained '+ recordings' when T-302 mounted its router on the same
    // flag; assert the stable part rather than the exact sentence.
    ok(/upload session.*ENABLED/.test(out), 'the mount is logged');
    // The legacy upload route must be completely unaffected.
    const legacy = await fetch('http://127.0.0.1:3271/api/upload', { method: 'POST' });
    ok(legacy.status === 401 || legacy.status === 400,
      'the LEGACY upload route still responds exactly as before');
  } finally {
    child.kill();
    await sleep(300);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────
  const listed = await provider.listObjects('sources/rec_');
  for (const o of listed.objects) await provider.deleteObject(o.key).catch(() => {});
  await pool.end().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
