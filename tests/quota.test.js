// T-306 quota ledger & atomic reservation tests (run: cd api && npm run test:quota)
//
// docs/20 §7.1 Q-suite. Real PostgreSQL + real object storage (MinIO): the
// whole point of an atomic reservation is what happens under REAL concurrency
// on a REAL row lock, which no mock can show.
//
// Q13 (worker failure mid-transcode) and Q17 (recorder hits its ceiling
// mid-recording) need the Phase 7 workers and the recorder matrix; Q17's
// client half is covered by tests/uploader.test.js (T-303). Both are recorded
// as deferred in docs/24, not claimed here.
//
// SKIPS LOUDLY without infrastructure; QUOTA_TESTS_REQUIRED=1 makes that a failure.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const API_DIR = path.join(ROOT, 'api');
const STORAGE_DIR = path.join(ROOT, 'storage');
const SERVER_DIR = path.join(ROOT, 'server');

const express = require(path.join(API_DIR, 'node_modules', 'express'));
const { loadEnv, createPool, createClient, createRepositories, withTransaction: rawTx } =
  require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));
const { createUploadRouter, createRecordingsRouter, createMeRouter, createQuota, computeReservation,
  MSG_STORAGE_V2, MSG_VIDEOS_V2 } = require(path.join(API_DIR, 'src', 'index.js'));
const { usageSync } = require(path.join(DB_DIR, 'src', 'maintenance', 'usage-sync.js'));
const { uploadExpiry } = require(path.join(DB_DIR, 'src', 'maintenance', 'upload-expiry.js'));
const plans = require(path.join(SERVER_DIR, 'plans.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.QUOTA_TESTS_REQUIRED === '1';
const MINIO = process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100';
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const RUN = crypto.randomBytes(4).toString('hex');
let n = 0;
const nextId = () => `q${RUN}${(n += 1)}`;

// A tight free plan so the interesting edges are reachable with small files:
// 5 GiB storage, 50 videos, 512 MiB per-take, 64 MiB floor — the docs/16 §1.1
// integers exactly — and a "legacy" set for the switch tests.
const V2 = plans.limitsFor(plans.getPlan('free'), { QUOTA_ENFORCEMENT_V2: 'true' });
const LEGACY = plans.limitsFor(plans.getPlan('free'), {});

(async () => {
  console.log('T-306 quota ledger & atomic reservation tests');

  // ── A. Pure algorithm (no infrastructure) ───────────────────────────────
  console.log('\nA. Reservation arithmetic and the plan switch');
  ok(V2.model === 'v2' && V2.maxActiveVideos === 50 && V2.maxStorageBytes === 5368709120
    && V2.maxUploadBytes === 536870912 && V2.minStartBytes === 67108864, 'the v2 limit set is the docs/16 §1.1 integers');
  ok(LEGACY.model === 'legacy' && LEGACY.maxActiveVideos === 30 && LEGACY.maxStorageBytes === 20 * GiB,
    'with the switch OFF the limit set is today\'s legacy fields (30 videos / 20 GB)');
  for (const bad of ['TRUE', '1', 'yes', ' true', '']) {
    ok(plans.limitsFor(plans.getPlan('free'), { QUOTA_ENFORCEMENT_V2: bad }).model === 'legacy', `QUOTA_ENFORCEMENT_V2=${JSON.stringify(bad)} stays legacy`);
  }
  ok(plans.limitsFor(plans.getPlan('pro'), { QUOTA_ENFORCEMENT_V2: 'true' }).maxActiveVideos === null, 'pro has no video cap');
  const empty = { storageRetainedBytes: 0, activeVideoCount: 0 };
  const zero = { storageReservedBytes: 0, reservedVideoSlots: 0 };
  ok(computeReservation(V2, empty, zero).reserveBytes === 512 * MiB, 'a fresh user reserves the full per-take ceiling (512 MiB)');
  // docs/16 §4.3 worked example: 4.7 GiB retained of 5 GiB.
  const nearFull = { storageRetainedBytes: Math.round(4.7 * GiB), activeVideoCount: 3 };
  const r47 = computeReservation(V2, nearFull, zero);
  ok(r47.reserveBytes === V2.maxStorageBytes - Math.round(4.7 * GiB) && r47.reserveBytes < 512 * MiB && r47.reserveBytes > 64 * MiB,
    'at 4.7/5 GiB the reservation is the remaining ~300 MiB, not the full ceiling');
  const afterFirst = { storageReservedBytes: r47.reserveBytes, reservedVideoSlots: 1 };
  ok(computeReservation(V2, nearFull, afterFirst).availableBytes === 0, 'after the first tab reserves it, nothing is left for a second');
  ok(computeReservation(V2, { storageRetainedBytes: 0, activeVideoCount: 50 }, zero).availableSlots === 0, '50 active videos leave no slot');
  ok(computeReservation(V2, { storageRetainedBytes: 0, activeVideoCount: 49 }, { storageReservedBytes: 0, reservedVideoSlots: 1 }).availableSlots === 0,
    '49 active + 1 reserved slot leaves no slot (a reservation counts)');
  ok(computeReservation(V2, empty, zero, { maxBytes: 32 * MiB }).reserveBytes === 32 * MiB, 'single mode caps the reservation at its own ceiling');
  ok(MSG_STORAGE_V2 === "You've reached your 5 GB free storage limit. Delete a video or upgrade to continue recording."
    && MSG_VIDEOS_V2 === "You've reached your 50-video free limit. Delete a video or upgrade to continue recording.",
    'the block messages are the docs/16 §4.6 copy, exactly');

  // ── Infrastructure ──────────────────────────────────────────────────────
  const env = loadEnv({ appEnv: 'test' });
  const pool = createPool({ env, max: 60 });
  let pgUp = false;
  try { await pool.query('select 1'); pgUp = true; } catch {}
  let storageUp = false;
  try { storageUp = (await fetch(`${MINIO}/minio/health/live`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
  if (!pgUp || !storageUp) {
    console.log(`\n  SKIPPED — ${!pgUp ? 'PostgreSQL unreachable' : ''}${!pgUp && !storageUp ? ' and ' : ''}${!storageUp ? `no object storage at ${MINIO}` : ''}`);
    console.log('  The quota ledger was NOT verified against real infrastructure by this run.');
    await pool.end().catch(() => {});
    if (REQUIRED) { console.log('  FAIL: QUOTA_TESTS_REQUIRED=1'); process.exit(1); }
    console.log(`\n${pass} passed, ${fail} failed (infrastructure sections skipped)`);
    process.exit(fail ? 1 : 0);
  }
  const db = createClient(pool);
  const storagePkg = require(path.join(STORAGE_DIR, 'src', 'index.js'));
  const provider = storagePkg.createStorageProvider({ appEnv: 'test' });
  await db.execute(sql`truncate table storage_reservations, video_assets, upload_parts, upload_sessions, processing_jobs, recordings, usage, users restart identity cascade`);

  // ── Harness: real routers, a per-user injectable limit set. ─────────────
  const limitsByUser = new Map();                 // legacyUserId → limits
  let currentUser = null;
  const quota = createQuota({ resolveLimits: (req) => limitsByUser.get(req.legacyUserId) || V2, logger: { info() {}, warn() {} } });
  const repositories = () => createRepositories(db);
  const withTransaction = (fn) => rawTx(fn, db);
  const requireAuth = (req, res, next) => {
    if (!currentUser) return res.status(401).json({ error: { code: 'unauthorized', message: 'no' } });
    req.userId = currentUser; req.id = 'req_q'; next();
  };
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const app = express();
  app.use('/api/v1', createUploadRouter({ rateLimits: { sessions: { max: 100000, windowMs: 3600000 } }, repositories, withTransaction, storage: provider, keys: storagePkg.keys, requireAuth, logger: quiet, quota }));
  app.use('/api/v1', createRecordingsRouter({ repositories, withTransaction, storage: provider, requireAuth, logger: quiet }));
  app.use('/api/v1', createMeRouter({ repositories, requireAuth, quota, logger: quiet }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const api = async (method, url, { body, headers = {}, as } = {}) => {
    if (as !== undefined) currentUser = as;
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, body: json };
  };
  const pgId = (legacyId) => `usr_${legacyId}`;
  async function seedUser(limits = V2) {
    const legacyId = `u_${nextId()}`;
    await db.execute(sql`INSERT INTO users (id,email,name,password_hash) VALUES (${pgId(legacyId)}, ${`${legacyId}@example.com`}, 'U', 'x')`);
    // The importer gives every user a ledger row; do the same here.
    await db.execute(sql`INSERT INTO usage (user_id) VALUES (${pgId(legacyId)}) ON CONFLICT DO NOTHING`);
    limitsByUser.set(legacyId, limits);
    return legacyId;
  }
  async function seedRecording(user, { status = 'recording', sizeBytes = null } = {}) {
    const rid = `rec_${nextId()}`;
    await db.execute(sql`INSERT INTO recordings (id,user_id,title,status,source_kind,privacy,size_bytes)
      VALUES (${rid}, ${pgId(user)}, 'Q', ${status}, 'extension', 'unlisted', ${sizeBytes})`);
    return rid;
  }
  const ledger = async (user) => (await db.execute(sql`select storage_retained_bytes r, storage_reserved_bytes v, reserved_video_slots s, active_video_count a, storage_pending_deletion_bytes p from usage where user_id = ${pgId(user)}`)).rows[0] || null;
  const reservations = async (user) => (await db.execute(sql`select status, reserved_bytes, reconciled_bytes from storage_reservations where user_id = ${pgId(user)} order by created_at`)).rows;
  const createSession = (rid, key, as, extra = {}) => api('POST', '/uploads', { as, headers: { 'Idempotency-Key': key }, body: { recordingId: rid, mimeType: 'video/webm', ...extra } });
  // Because concurrency tests hit one server with a shared `currentUser`, run
  // them as raw fetches with an explicit per-request identity header instead.
  const rawCreate = (rid, key, user, extra = {}) => {
    currentUser = user;
    return fetch(`${base}/uploads`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ recordingId: rid, mimeType: 'video/webm', ...extra }) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  };
  async function putSingle(user, rid, bytes, key) {
    const c = await createSession(rid, key, user, { mode: 'single', sizeBytes: bytes.length });
    if (c.status !== 201) return { create: c };
    const put = await fetch(c.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'video/webm' }, body: bytes });
    const done = await api('POST', `/uploads/${c.body.uploadSessionId}/complete`, { as: user, body: { parts: [] } });
    return { create: c, put, done, sessionId: c.body.uploadSessionId };
  }

  try {
    // ── B. Reserve / reconcile / release on one user ────────────────────────
    console.log('\nB. Lifecycle');
    const alice = await seedUser();
    const r1 = await seedRecording(alice);
    const c1 = await createSession(r1, 'k1', alice);
    ok(c1.status === 201 && c1.body.byteCeiling === 512 * MiB, 'a session reserves the full per-take ceiling and reports it as byteCeiling');
    let L = await ledger(alice);
    ok(Number(L.v) === 512 * MiB && Number(L.s) === 1, 'reserved bytes and one slot are on the ledger');
    ok((await reservations(alice))[0].status === 'held', 'a held reservation row exists');
    const meters = await api('GET', '/me/usage', { as: alice });
    ok(meters.status === 200 && meters.body.storage.reservedBytes === 512 * MiB && meters.body.videos.reserved === 1
      && meters.body.storage.limitBytes === V2.maxStorageBytes && meters.body.videos.max === 50
      && meters.body.storage.display === '0 GB / 5 GB' && meters.body.videos.display === '0 / 50',
      '/me/usage shows two SEPARATE meters with the reservation visible');
    ok(!('percent' in meters.body) && !('storagePercent' in meters.body), 'no blended percentage anywhere in the body');

    // Q4 — same Idempotency-Key ⇒ same session, reservation taken ONCE.
    const c1b = await createSession(r1, 'k1', alice);
    ok(c1b.status === 200 && c1b.body.uploadSessionId === c1.body.uploadSessionId, 'Q4: a replayed create returns the same session');
    L = await ledger(alice);
    ok(Number(L.v) === 512 * MiB && Number(L.s) === 1 && (await reservations(alice)).length === 1, 'Q4: the reservation was taken exactly once');

    // Q7 — abort releases once; re-abort idempotent.
    const ab = await api('DELETE', `/uploads/${c1.body.uploadSessionId}`, { as: alice });
    ok(ab.status === 200, 'Q7: abort succeeds');
    L = await ledger(alice);
    ok(Number(L.v) === 0 && Number(L.s) === 0, 'Q7: abort returns the bytes and the slot');
    ok((await reservations(alice))[0].status === 'released', 'Q7: the reservation is released');
    await api('DELETE', `/uploads/${c1.body.uploadSessionId}`, { as: alice });
    L = await ledger(alice);
    ok(Number(L.v) === 0 && Number(L.s) === 0, 'Q7: a second abort releases nothing more (no negative counters)');

    // Q5/Q8 — complete reconciles with the REAL HEAD size, exactly once.
    const r2 = await seedRecording(alice);
    const bytes = crypto.randomBytes(3 * MiB + 17);
    const up = await putSingle(alice, r2, bytes, 'k2');
    ok(up.done && up.done.status === 200, 'a single-PUT upload completes');
    L = await ledger(alice);
    ok(Number(L.r) === bytes.length && Number(L.a) === 1 && Number(L.v) === 0 && Number(L.s) === 0,
      'Q8: reconciliation uses the real stored size; reserved bytes and slot are returned; active count +1');
    const rs = await reservations(alice);
    ok(rs[1].status === 'reconciled' && Number(rs[1].reconciled_bytes) === bytes.length, 'the reservation is reconciled with the real bytes');
    const again = await api('POST', `/uploads/${up.sessionId}/complete`, { as: alice, body: { parts: [] } });
    ok(again.status === 200, 'Q5: a duplicate completion replays');
    L = await ledger(alice);
    ok(Number(L.r) === bytes.length && Number(L.a) === 1, 'Q5: retained bytes and video count incremented exactly once');
    const m2 = await api('GET', '/me/usage', { as: alice });
    ok(m2.body.storage.usedBytes === bytes.length && m2.body.videos.count === 1, '/me/usage reflects the completed upload');

    // ── C. Q1 / Q16 — the two-tabs race, exactly one wins ───────────────────
    console.log('\nC. Concurrency');
    const bob = await seedUser();
    // 4.7 GiB already retained: one reservation of ~300 MiB left.
    await seedRecording(bob, { status: 'ready', sizeBytes: Math.round(4.7 * GiB) });
    const bRec = [await seedRecording(bob), await seedRecording(bob)];
    const [t1, t2] = await Promise.all([rawCreate(bRec[0], 'b1', bob), rawCreate(bRec[1], 'b2', bob)]);
    const wins = [t1, t2].filter((t) => t.status === 201);
    const loses = [t1, t2].filter((t) => t.status === 403);
    ok(wins.length === 1 && loses.length === 1, 'Q16: two simultaneous tabs — exactly one succeeds');
    ok(wins[0].body.byteCeiling === V2.maxStorageBytes - Math.round(4.7 * GiB), 'Q16: the winner is byte-capped at the remaining ~300 MiB, disclosed up front');
    ok(loses[0].body.error.code === 'storage_limit' && loses[0].body.error.message === MSG_STORAGE_V2
      && loses[0].body.error.upgradeRequired === true && loses[0].body.error.meta.limitBytes === V2.maxStorageBytes,
      'Q16: the loser gets 403 storage_limit with the exact message and real numbers in meta');
    L = await ledger(bob);
    ok(Number(L.v) === wins[0].body.byteCeiling && Number(L.s) === 1, 'Q1: the ledger holds exactly one reservation — never over-reserved');
    ok((await db.execute(sql`select count(*)::int c from upload_sessions where user_id = ${pgId(bob)}`)).rows[0].c === 1, 'Q1: the refused create left NO session row');

    // Q1 at scale — 50 parallel attempts against exactly one slot.
    const carol = await seedUser({ ...V2, maxActiveVideos: 1 });
    const cRecs = [];
    for (let i = 0; i < 50; i += 1) cRecs.push(await seedRecording(carol));
    const attempts = await Promise.all(cRecs.map((rid, i) => rawCreate(rid, `c${i}`, carol)));
    const won = attempts.filter((a) => a.status === 201).length;
    const refused = attempts.filter((a) => a.status === 403 && a.body.error.code === 'video_limit').length;
    ok(won === 1 && refused === 49, `Q1: 50 parallel creations, one slot — exactly one wins (${won}), 49 refused with video_limit (${refused})`);
    L = await ledger(carol);
    ok(Number(L.s) === 1 && Number(L.v) === 512 * MiB, 'Q1: the ledger holds exactly one slot and one reservation after 50 parallel attempts');
    // T-1003: every plan-limit refusal is also a recorded conversion fact with the legacy trigger name.
    const hits = (await db.execute(sql`select recording_id, props from analytics_events where event = 'paywall_hit' and user_id = ${pgId(carol)}`)).rows;
    ok(hits.length === 49 && hits.every((h) => h.props.trigger === 'video_limit_reached' && h.props.feature === 'videoLimit' && cRecs.includes(h.recording_id)), `T-1003: 49 paywall_hit events (video_limit_reached) recorded AFTER the rolled-back reservations (${hits.length})`);
    ok(attempts.filter((a) => a.status === 403)[0].body.error.message === MSG_VIDEOS_V2, 'Q3: the video-limit message is the docs/16 §4.6 copy');

    // Q2 — several tabs within quota: independent reservations, sums correct.
    const dave = await seedUser();
    const dRecs = [await seedRecording(dave), await seedRecording(dave), await seedRecording(dave)];
    const dSes = await Promise.all(dRecs.map((rid, i) => rawCreate(rid, `d${i}`, dave)));
    ok(dSes.every((s) => s.status === 201), 'Q2: three concurrent tabs within quota all get sessions');
    L = await ledger(dave);
    ok(Number(L.v) === 3 * 512 * MiB && Number(L.s) === 3, 'Q2: the ledger sums three independent reservations');
    ok((await reservations(dave)).filter((r) => r.status === 'held').length === 3, 'Q2: three held reservation rows');

    // Q3 — 49 active, two simultaneous: one slot.
    const erin = await seedUser();
    for (let i = 0; i < 49; i += 1) await seedRecording(erin, { status: 'ready', sizeBytes: 1000 });
    const eRecs = [await seedRecording(erin), await seedRecording(erin)];
    const [e1, e2] = await Promise.all([rawCreate(eRecs[0], 'e1', erin), rawCreate(eRecs[1], 'e2', erin)]);
    ok([e1, e2].filter((x) => x.status === 201).length === 1 && [e1, e2].some((x) => x.status === 403 && x.body.error.code === 'video_limit'),
      'Q3: at 49 active videos, two simultaneous recordings — one slot, the other gets video_limit');

    // Q9 — a delete racing an upload completion: both serialise on the row.
    const fay = await seedUser();
    const fOld = await seedRecording(fay, { status: 'ready', sizeBytes: 2 * MiB });
    // Give fay's ledger the counters a sync would (so the delete's decrement is meaningful).
    await db.execute(sql`update usage set storage_retained_bytes = ${2 * MiB}, active_video_count = 1 where user_id = ${pgId(fay)}`);
    const fNew = await seedRecording(fay);
    const fBytes = crypto.randomBytes(1 * MiB + 5);
    const fCreate = await createSession(fNew, 'f1', fay, { mode: 'single', sizeBytes: fBytes.length });
    await fetch(fCreate.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'video/webm' }, body: fBytes });
    currentUser = fay;
    const [delRes, compRes] = await Promise.all([
      fetch(`${base}/recordings/${fOld}`, { method: 'DELETE', headers: { 'content-type': 'application/json' } }),
      fetch(`${base}/uploads/${fCreate.body.uploadSessionId}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parts: [] }) }),
    ]);
    ok(delRes.status === 200 && compRes.status === 200, 'Q9: a delete and a completion run concurrently without deadlock');
    const live = await createRepositories(db).usage.liveTotals({ userId: pgId(fay) });
    ok(live.storageRetainedBytes === fBytes.length && live.activeVideoCount === 1 && live.storagePendingDeletionBytes === 2 * MiB,
      'Q9: final live ledger = −deleted +uploaded (2 MiB pending deletion, 1 MiB retained, 1 active)');
    L = await ledger(fay);
    ok(Number(L.r) >= 0 && Number(L.a) >= 0 && Number(L.v) === 0 && Number(L.s) === 0, 'Q9: no negative counters (CHECK constraints intact), reservation settled');

    // ── D. Q14 — hostile client vs the byte ceiling ─────────────────────────
    console.log('\nD. Byte ceiling');
    // A coherent tight set: the start floor must not exceed the per-take ceiling.
    const gus = await seedUser({ ...V2, maxUploadBytes: 6 * MiB, minStartBytes: 1 * MiB });
    const gRec = await seedRecording(gus);
    const gSes = await createSession(gRec, 'g1', gus);
    ok(gSes.body.byteCeiling === 6 * MiB, 'the reservation IS the ceiling (6 MiB here)');
    const before = await ledger(gus);
    const presign = await api('POST', `/uploads/${gSes.body.uploadSessionId}/parts`, { as: gus, body: { parts: [{ partNumber: 1, size: 5 * MiB }, { partNumber: 2, size: 5 * MiB }] } });
    ok(presign.status === 403 && presign.body.error.code === 'storage_limit', 'Q14: presigning beyond the ceiling is refused (403)');
    const okPre = await api('POST', `/uploads/${gSes.body.uploadSessionId}/parts`, { as: gus, body: { parts: [{ partNumber: 1, size: 5 * MiB }] } });
    ok(okPre.status === 200, 'Q14: presigning within the ceiling works');
    const oversize = await fetch(okPre.body.parts[0].url, { method: 'PUT', body: crypto.randomBytes(5 * MiB + 1) });
    ok(oversize.status === 403 || oversize.status === 400, 'Q14: an oversized PUT is rejected by STORAGE (signed Content-Length)');
    const manifest = await api('POST', `/uploads/${gSes.body.uploadSessionId}/complete`, { as: gus, body: { parts: [{ partNumber: 1, etag: 'x', size: 7 * MiB }] } });
    ok(manifest.status === 422 && manifest.body.error.code === 'upload_manifest_invalid', 'Q14: a manifest over the ceiling is 422');
    const after = await ledger(gus);
    ok(Number(after.r) === Number(before.r) && Number(after.a) === Number(before.a), 'Q14: no retained bytes or count changed');
    ok(Number(after.v) === 0 && Number(after.s) === 0, 'Q14: the over-ceiling manifest aborted the session and released its reservation');

    // ── E. Q6 / Q12 — abandoned sessions: expiry releases, restart loses nothing
    console.log('\nE. Expiry and restart');
    const hal = await seedUser();
    const hRec = await seedRecording(hal);
    const hSes = await createSession(hRec, 'h1', hal);
    ok(hSes.status === 201, 'a session is opened and then abandoned');
    // "Server restart": a brand-new repository set sees the same reservation.
    const fresh = createRepositories(createClient(pool));
    const surviving = await fresh.uploads.findReservationBySession({ userId: pgId(hal) }, hSes.body.uploadSessionId);
    ok(surviving && surviving.status === 'held', 'Q12: the reservation lives in PostgreSQL and survives a restart');
    // Not yet expired: the job leaves it alone.
    let rep = await uploadExpiry({ repositories, withTransaction, storage: provider, logger: quiet });
    ok(rep.expired === 0, 'Q6: an unexpired session is not touched');
    // Age it past expiry, then run the hourly job.
    await db.execute(sql`update upload_sessions set expires_at = now() - interval '1 hour' where id = ${hSes.body.uploadSessionId}`);
    await db.execute(sql`update storage_reservations set expires_at = now() - interval '1 hour' where upload_session_id = ${hSes.body.uploadSessionId}`);
    rep = await uploadExpiry({ repositories, withTransaction, storage: provider, logger: quiet });
    ok(rep.expired === 1 && rep.released === 1, 'Q6: the expiry job expires the session and releases its reservation');
    L = await ledger(hal);
    ok(Number(L.v) === 0 && Number(L.s) === 0, 'Q6: quota is back to the pre-session values');
    ok((await reservations(hal))[0].status === 'expired', 'Q6: the reservation is marked expired');
    const st = await api('GET', `/uploads/${hSes.body.uploadSessionId}`, { as: hal });
    ok(st.body.status === 'expired', 'Q6: the session reads as expired');
    rep = await uploadExpiry({ repositories, withTransaction, storage: provider, logger: quiet });
    ok(rep.expired === 0, 'Q6: running expiry again releases nothing twice');

    // ── F. Q11 — usage_sync heals injected drift; mirror clobber cannot fool the guard
    console.log('\nF. Reconciliation and the legacy mirror');
    const ivy = await seedUser();
    await seedRecording(ivy, { status: 'ready', sizeBytes: 100 * MiB });
    await seedRecording(ivy, { status: 'ready', sizeBytes: 200 * MiB });
    // Simulate what dualwrite.usage / the reconciler do: overwrite the counters
    // with a legacy snapshot that knows nothing about these recordings.
    await db.execute(sql`update usage set storage_retained_bytes = 7, active_video_count = 0 where user_id = ${pgId(ivy)}`);
    const iMeters = await api('GET', '/me/usage', { as: ivy });
    ok(iMeters.body.storage.usedBytes === 300 * MiB && iMeters.body.videos.count === 2,
      'the meters read the ROWS, so a clobbered counter cannot misreport usage');
    const tight = await seedUser({ ...V2, maxStorageBytes: 300 * MiB + 100 * MiB });  // 100 MiB of headroom
    await seedRecording(tight, { status: 'ready', sizeBytes: 300 * MiB });
    await db.execute(sql`update usage set storage_retained_bytes = 0, active_video_count = 0 where user_id = ${pgId(tight)}`);
    const tRec = await seedRecording(tight);
    const tSes = await createSession(tRec, 't1', tight);
    ok(tSes.status === 201 && tSes.body.byteCeiling === 100 * MiB,
      'the guard reads the ROWS: with counters clobbered to zero it still caps the take at the real 100 MiB headroom');
    const syncRep = await usageSync({ repositories, withTransaction, logger: quiet });
    ok(syncRep.synced >= 2 && syncRep.drifted >= 1, 'Q11: usage_sync re-derived the counters and reported drift');
    L = await ledger(ivy);
    ok(Number(L.r) === 300 * MiB && Number(L.a) === 2, 'Q11: after usage_sync the counters match the row aggregates');
    ok(syncRep.drift.some((d) => d.userId === pgId(ivy) && d.retainedBefore === 7 && d.retainedAfter === 300 * MiB), 'Q11: the drift entry names the corrected values');

    // ── G. Q15 — soft delete frees quota immediately; meters reflect it ─────
    console.log('\nG. Soft delete');
    const jo = await seedUser();
    const jRec = await seedRecording(jo);
    const jBytes = crypto.randomBytes(2 * MiB + 3);
    const jUp = await putSingle(jo, jRec, jBytes, 'j1');
    ok(jUp.done.status === 200, 'an upload lands');
    let jm = await api('GET', '/me/usage', { as: jo });
    ok(jm.body.storage.usedBytes === jBytes.length && jm.body.videos.count === 1, 'Q15: the meters show the upload');
    ok((await api('DELETE', `/recordings/${jRec}`, { as: jo })).status === 200, 'Q15: soft delete');
    jm = await api('GET', '/me/usage', { as: jo });
    ok(jm.body.storage.usedBytes === 0 && jm.body.videos.count === 0 && jm.body.storage.pendingDeletionBytes === jBytes.length,
      'Q15: quota is freed IMMEDIATELY and the bytes show as pending deletion (hard purge is the Phase 6 cleanup job)');
    const jRec2 = await seedRecording(jo);
    ok((await createSession(jRec2, 'j2', jo)).status === 201, 'Q15: a new recording can start right after the delete');

    // ── H. The downgrade race at completion (docs/06 §7.5) ──────────────────
    console.log('\nH. Completion re-check');
    const kim = await seedUser();
    const kRec = await seedRecording(kim);
    const kBytes = crypto.randomBytes(1 * MiB);
    const kSes = await createSession(kRec, 'k1', kim, { mode: 'single', sizeBytes: kBytes.length });
    await fetch(kSes.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'video/webm' }, body: kBytes });
    limitsByUser.set(kim, { ...V2, maxActiveVideos: 0 });    // "downgraded" mid-upload
    const kDone = await api('POST', `/uploads/${kSes.body.uploadSessionId}/complete`, { as: kim, body: { parts: [] } });
    ok(kDone.status === 403 && kDone.body.error.code === 'video_limit' && kDone.body.error.upgradeRequired === true,
      'a plan that no longer allows the video rejects at completion with the real size');
    const kRow = (await db.execute(sql`select status from recordings where id = ${kRec}`)).rows[0];
    ok(kRow.status === 'rejected_limit', 'the recording is rejected_limit — the source is NOT deleted (7-day grace)');
    ok(!!(await provider.headObject(`sources/${kRec}/source.webm`).catch(() => null)), 'the object is still in storage');
    L = await ledger(kim);
    ok(Number(L.v) === 0 && Number(L.s) === 0 && Number(L.a) === 0, 'the reservation was released and nothing was counted');

    // ── I. Sessions that predate the ledger ─────────────────────────────────
    console.log('\nI. Pre-T-306 sessions');
    const lee = await seedUser();
    const lRec = await seedRecording(lee);
    // A session created before reservations existed: row only, no reservation.
    await db.execute(sql`INSERT INTO upload_sessions (id,recording_id,user_id,storage_key,mode,part_size,byte_ceiling,client_mime,idempotency_key,expires_at)
      VALUES ('up_legacy_q', ${lRec}, ${pgId(lee)}, ${`sources/${lRec}/source.webm`}, 'single', 1000, 1000, 'video/webm', 'legacy-q', now() + interval '1 day')`);
    const lBytes = crypto.randomBytes(1000);
    const lUrl = await provider.getSignedUploadUrl(`sources/${lRec}/source.webm`, { expiresIn: 60, contentLength: 1000 });
    await fetch(lUrl, { method: 'PUT', body: lBytes });
    const lDone = await api('POST', '/uploads/up_legacy_q/complete', { as: lee, body: { parts: [] } });
    ok(lDone.status === 200, 'a session with no reservation still completes');
    L = await ledger(lee);
    ok(Number(L.r) === 1000 && Number(L.a) === 1 && Number(L.v) === 0 && Number(L.s) === 0, 'its bytes and count are recorded; nothing is released below zero');

    // ── J. Boundaries ───────────────────────────────────────────────────────
    console.log('\nJ. Boundaries');
    const rawCode = fs.readFileSync(path.join(API_DIR, 'src', 'quota.js'), 'utf8') + fs.readFileSync(path.join(API_DIR, 'src', 'me.router.js'), 'utf8');
    const code = rawCode.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');   // comments may NAME the catalog; code may not touch it
    ok(!/\bsql`|SELECT |UPDATE .* SET |db\.execute|drizzle/i.test(code), 'the quota module contains no SQL — the guard lives in the usage repository');
    ok(!/require\([^)]*(plans|server\/)/.test(code), 'the quota module knows no plan catalog (limits are injected)');
    const repoSrc = fs.readFileSync(path.join(DB_DIR, 'src', 'repositories', 'usage.repo.js'), 'utf8');
    ok(/::bigint >= .*::bigint/.test(repoSrc), 'the guard casts its parameters explicitly (untyped params compare as text)');
    ok(/reserveGuarded must run inside withTransaction/.test(repoSrc), 'reserveGuarded refuses to run outside a transaction');
    ok(!/storage_retained_bytes\s*\+\s*storage_reserved_bytes\s*\+/.test(repoSrc.split('UPDATE usage')[1] || ''), 'the guard does NOT read the clobber-prone retained counter');
  } finally {
    server.close();
  }

  // Cleanup of test objects in storage.
  const listed = await provider.listObjects('sources/rec_');
  for (const o of listed.objects) await provider.deleteObject(o.key).catch(() => {});
  await pool.end().catch(() => {});

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
