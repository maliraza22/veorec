// T-302 /api/v1/recordings tests (run: cd api && npm run test:recordings)
//
// Real PostgreSQL. The two things the canonical task names explicitly are an
// AUTHZ MATRIX and SOFT DELETE + USAGE TX, so both get the most attention: the
// matrix is exhaustive over every route, and the ledger is exercised
// concurrently, because a delete that double-decrements corrupts a user's quota
// permanently and no mock can demonstrate that a transaction actually
// serialized.
//
// SKIPS LOUDLY without PostgreSQL; RECORDINGS_API_TESTS_REQUIRED=1 makes that a
// failure.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const API_DIR = path.join(ROOT, 'api');

const express = require(path.join(API_DIR, 'node_modules', 'express'));
const { loadEnv, createPool, createClient, createRepositories, withTransaction: rawTx } =
  require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));
const { createRecordingsRouter } = require(path.join(API_DIR, 'src', 'index.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.RECORDINGS_API_TESTS_REQUIRED === '1';
const RUN = crypto.randomBytes(4).toString('hex');
let n = 0;
const nextId = () => `r${RUN}${(n += 1)}`;

(async () => {
  console.log('T-302 /api/v1/recordings tests');

  const env = loadEnv({ appEnv: 'test' });
  const pool = createPool({ env, max: 8 });
  let pgUp = false;
  try { await pool.query('select 1'); pgUp = true; } catch {}
  if (!pgUp) {
    console.log('\n  SKIPPED — PostgreSQL unreachable; the recordings API was NOT verified.');
    await pool.end().catch(() => {});
    if (REQUIRED) { console.log('  FAIL: RECORDINGS_API_TESTS_REQUIRED=1'); process.exit(1); }
    console.log('\n0 passed, 0 failed (skipped)');
    process.exit(0);
  }

  const db = createClient(pool);
  await db.execute(sql`truncate table video_assets, upload_parts, upload_sessions, processing_jobs, recordings, folders, usage, users restart identity cascade`);

  let currentUser = null;
  let proFeatures = false;

  const app = express();
  app.use('/api/v1', createRecordingsRouter({
    repositories: () => createRepositories(db),
    withTransaction: rawTx,
    storage: null,                      // signed-URL minting is exercised in T-301
    requireAuth: (req, res, next) => {
      if (!currentUser) return res.status(401).json({ error: { code: 'unauthorized', message: 'no' } });
      req.userId = currentUser; req.id = 'req_test'; next();
    },
    entitlements: {
      async canCreateRecording() { return { allowed: true }; },
      async isFeatureEnabled() { return proFeatures; },
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;

  const api = async (method, url, { body, headers = {}, as } = {}) => {
    if (as !== undefined) currentUser = as;
    const res = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, body: json };
  };

  // Callers authenticate with a LEGACY id; the mirrored PostgreSQL row is
  // `usr_<legacyId>`. These suites therefore go through the identity bridge.
  const pgId = (legacyId) => `usr_${legacyId}`;
  async function seedUser(legacyId) {
    await db.execute(sql`INSERT INTO users (id,email,name,password_hash)
      VALUES (${pgId(legacyId)}, ${`${legacyId}@example.com`}, 'U', 'x') ON CONFLICT (id) DO NOTHING`);
    await db.execute(sql`INSERT INTO usage (user_id) VALUES (${pgId(legacyId)}) ON CONFLICT (user_id) DO NOTHING`);
    return legacyId;
  }
  const usageOf = async (legacyId) =>
    (await db.execute(sql`select * from usage where user_id = ${pgId(legacyId)}`)).rows[0];

  try {
    const alice = await seedUser(`usr_${nextId()}`);
    const bob = await seedUser(`usr_${nextId()}`);

    // ── A. Create ────────────────────────────────────────────────────────────
    console.log('\nA. Create');
    const c1 = await api('POST', '/recordings', { body: { title: 'First', source: 'extension' }, as: alice });
    ok(c1.status === 201, `create returns 201 (got ${c1.status})`);
    ok(!!c1.body.id && c1.body.status === 'recording', 'create returns an id and status=recording');
    const rec1 = c1.body.id;
    const stored = (await db.execute(sql`select * from recordings where id = ${rec1}`)).rows[0];
    ok(stored.user_id === pgId(alice), "the row is owned by the caller's POSTGRESQL identity");
    ok(stored.source_kind === 'extension' && stored.title === 'First', 'source and title are stored');

    ok((await api('POST', '/recordings', { body: { source: 'nope' }, as: alice })).status === 400,
      'an invalid source is rejected');
    ok((await api('POST', '/recordings', { body: { title: '   ', source: 'extension' }, as: alice })).status === 400,
      'a whitespace-only title is rejected');
    ok((await api('POST', '/recordings', { body: { title: 'x'.repeat(201), source: 'extension' }, as: alice })).status === 400,
      'a title over 200 characters is rejected');
    const defaulted = await api('POST', '/recordings', { body: { source: 'web_upload' }, as: alice });
    ok(defaulted.status === 201, 'title is optional');

    // Idempotency-Key
    const k = 'idem-key-1';
    const i1 = await api('POST', '/recordings', { body: { title: 'Idem', source: 'extension' }, headers: { 'Idempotency-Key': k }, as: alice });
    const i2 = await api('POST', '/recordings', { body: { title: 'Idem', source: 'extension' }, headers: { 'Idempotency-Key': k }, as: alice });
    ok(i1.status === 201 && i2.status === 200, 'a replayed create returns 200, not a second 201');
    ok(i1.body.id === i2.body.id, 'a replayed create returns the SAME recording');
    ok((await db.execute(sql`select count(*)::int n from recordings where title = 'Idem'`)).rows[0].n === 1,
      'a replayed create makes no second row');
    // The same key from a DIFFERENT user must not collide.
    const bobSame = await api('POST', '/recordings', { body: { title: 'Idem', source: 'extension' }, headers: { 'Idempotency-Key': k }, as: bob });
    ok(bobSame.status === 201 && bobSame.body.id !== i1.body.id,
      "another user's identical Idempotency-Key yields a different recording");

    // ── B. Authz matrix — every route, every direction ───────────────────────
    console.log('\nB. Authorization matrix');
    const routes = [
      ['GET', `/recordings/${rec1}`, null],
      ['PATCH', `/recordings/${rec1}`, { title: 'hax' }],
      ['PATCH', `/recordings/${rec1}/meta`, { description: 'hax' }],
      ['DELETE', `/recordings/${rec1}`, null],
    ];
    for (const [method, url, body] of routes) {
      const res = await api(method, url, { body, as: bob });
      // DELETE is idempotent and answers 200 for "not visible to you", which is
      // the same answer as "already deleted" — it must not reveal existence.
      const expected = method === 'DELETE' ? 200 : 404;
      ok(res.status === expected,
        `${method} ${url.split('/')[2]} by a non-owner → ${expected} (got ${res.status})`);
    }
    ok((await db.execute(sql`select deleted_at from recordings where id = ${rec1}`)).rows[0].deleted_at === null,
      "a non-owner's DELETE did NOT delete the recording");
    ok((await db.execute(sql`select title from recordings where id = ${rec1}`)).rows[0].title === 'First',
      "a non-owner's PATCH did not change the title");

    currentUser = null;
    for (const [method, url] of routes) {
      ok((await api(method, url)).status === 401, `${method} unauthenticated → 401`);
    }
    ok((await api('GET', '/recordings')).status === 401, 'GET list unauthenticated → 401');
    ok((await api('POST', '/recordings', { body: { source: 'extension' } })).status === 401,
      'POST unauthenticated → 401');

    // Not-found and not-yours are indistinguishable.
    const ghost = await api('GET', '/recordings/rec_does_not_exist', { as: alice });
    const foreign = await api('GET', `/recordings/${rec1}`, { as: bob });
    ok(ghost.status === foreign.status && ghost.body.error.code === foreign.body.error.code,
      'a missing recording and another user\'s recording are indistinguishable');

    // ── C. List — from the database, scoped ──────────────────────────────────
    console.log('\nC. List');
    const bobRec = (await api('POST', '/recordings', { body: { title: "Bob's", source: 'extension' }, as: bob })).body.id;
    const list = await api('GET', '/recordings', { as: alice });
    ok(list.status === 200 && Array.isArray(list.body.items), 'list returns items');
    ok(list.body.items.every((r) => r.id !== bobRec), "another user's recordings never appear");
    ok(list.body.items.length >= 3, 'the caller sees their own recordings');
    const item = list.body.items[0];
    for (const field of ['id', 'title', 'status', 'duration', 'size_bytes', 'created_at',
      'privacy', 'folder_id', 'archived', 'tags', 'views', 'commentCount']) {
      ok(field in item, `RecordingSummary includes ${field}`);
    }
    ok(!('storage_key' in item) && !('password_hash' in item) && !('passwordHash' in item),
      'the summary exposes no storage key and no password hash');

    // Pagination
    const page1 = await api('GET', '/recordings?limit=2', { as: alice });
    ok(page1.body.items.length === 2, 'limit is honoured');
    ok(!!page1.body.nextCursor, 'a nextCursor is returned when more remain');
    const page2 = await api('GET', `/recordings?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`, { as: alice });
    ok(page2.body.items.every((r) => !page1.body.items.some((p) => p.id === r.id)),
      'the next page does not repeat the first');
    ok((await api('GET', '/recordings?limit=9999', { as: alice })).status === 200, 'an over-large limit is clamped, not rejected');
    ok((await api('GET', '/recordings?cursor=not-a-date', { as: alice })).status === 400, 'a malformed cursor is rejected');

    // Archived filter
    await api('PATCH', `/recordings/${rec1}/meta`, { body: { archived: true }, as: alice });
    const active = await api('GET', '/recordings', { as: alice });
    ok(!active.body.items.some((r) => r.id === rec1), 'archived recordings are excluded by default');
    const archived = await api('GET', '/recordings?archived=true', { as: alice });
    ok(archived.body.items.some((r) => r.id === rec1), 'archived=true returns them');
    await api('PATCH', `/recordings/${rec1}/meta`, { body: { archived: false }, as: alice });

    // ── D. Detail ────────────────────────────────────────────────────────────
    console.log('\nD. Detail');
    const detail = await api('GET', `/recordings/${rec1}`, { as: alice });
    ok(detail.status === 200 && detail.body.id === rec1, 'detail returns the recording');
    ok('assets' in detail.body && Array.isArray(detail.body.assets), 'detail includes an assets summary');
    ok('canTranscribe' in detail.body && 'canStitch' in detail.body, 'detail includes capability flags');
    ok(!JSON.stringify(detail.body).includes('storageKey') && !JSON.stringify(detail.body).includes('storage_key'),
      'detail never exposes a storage key');

    // ── E. Update ────────────────────────────────────────────────────────────
    console.log('\nE. Update');
    const t1 = await api('PATCH', `/recordings/${rec1}`, { body: { title: '  Renamed  ' }, as: alice });
    ok(t1.status === 200 && t1.body.title === 'Renamed', 'title is trimmed and saved');
    ok((await api('PATCH', `/recordings/${rec1}`, { body: {}, as: alice })).status === 400, 'PATCH without a title is rejected');
    ok((await api('PATCH', `/recordings/${rec1}`, { body: { title: '' }, as: alice })).status === 400, 'an empty title is rejected');

    const meta = await api('PATCH', `/recordings/${rec1}/meta`, {
      body: { description: 'Desc', tags: ['a', 'b', 'a'], privacy: 'login', recommendedSpeed: 1.25 }, as: alice });
    ok(meta.status === 200, 'meta updates');
    ok(meta.body.description === 'Desc' && meta.body.privacy === 'login', 'meta fields are saved');
    ok(meta.body.tags.length === 2, 'duplicate tags are collapsed');
    ok(Number(meta.body.recommendedSpeed) === 1.25, 'numeric meta round-trips');

    ok((await api('PATCH', `/recordings/${rec1}/meta`, { body: { privacy: 'nope' }, as: alice })).status === 400,
      'an invalid privacy value is rejected');
    ok((await api('PATCH', `/recordings/${rec1}/meta`, { body: { tags: new Array(21).fill('t') }, as: alice })).status === 400,
      'too many tags are rejected');
    ok((await api('PATCH', `/recordings/${rec1}/meta`, { body: { trimStart: 10, trimEnd: 5 }, as: alice })).status === 400,
      'trimEnd before trimStart is rejected');
    ok((await api('PATCH', `/recordings/${rec1}/meta`, { body: {}, as: alice })).status === 400,
      'a meta patch with no supported field is rejected');
    ok((await api('PATCH', `/recordings/${rec1}/meta`, { body: { folder: 'fld_not_mine' }, as: alice })).status === 404,
      'moving into a folder the caller does not own is refused');

    // Pro gates are paywalls, not silent drops.
    proFeatures = false;
    const locked = await api('PATCH', `/recordings/${rec1}/meta`, { body: { password: 'hunter2' }, as: alice });
    ok(locked.status === 403 && locked.body.error.code === 'feature_locked',
      'a Pro-gated field returns 403 feature_locked');
    ok(locked.body.error.upgradeRequired === true, 'the paywall carries upgradeRequired');
    ok((await db.execute(sql`select password_hash from recordings where id = ${rec1}`)).rows[0].password_hash === null,
      'the gated field was NOT silently applied');
    proFeatures = true;
    const unlocked = await api('PATCH', `/recordings/${rec1}/meta`, { body: { password: 'hunter2' }, as: alice });
    ok(unlocked.status === 200 && unlocked.body.passwordProtected === true, 'with the feature enabled the password is set');
    ok(!JSON.stringify(unlocked.body).includes('hunter2'), 'the plaintext password is never echoed back');
    const pwRow = (await db.execute(sql`select password_hash from recordings where id = ${rec1}`)).rows[0];
    ok(pwRow.password_hash && pwRow.password_hash !== 'hunter2', 'the password is stored hashed, never in plaintext');
    proFeatures = false;

    // ── F. Soft delete + usage transaction (the canonical requirement) ──────
    console.log('\nF. Soft delete + usage transaction');
    const delRec = (await api('POST', '/recordings', { body: { title: 'ToDelete', source: 'extension' }, as: alice })).body.id;
    await db.execute(sql`update recordings set size_bytes = 1000, duration = 60 where id = ${delRec}`);
    await db.execute(sql`update usage set storage_retained_bytes = 5000, active_video_count = 3,
      recording_seconds = 300 where user_id = ${pgId(alice)}`);

    const before = await usageOf(alice);
    const del = await api('DELETE', `/recordings/${delRec}`, { as: alice });
    ok(del.status === 200 && del.body.ok === true, 'delete returns ok');
    const after = await usageOf(alice);
    ok(Number(after.storage_retained_bytes) === Number(before.storage_retained_bytes) - 1000,
      'retained bytes decrease by the recording size');
    ok(Number(after.storage_pending_deletion_bytes) === Number(before.storage_pending_deletion_bytes) + 1000,
      'the bytes move to pending deletion, awaiting the 30-day purge');
    ok(Number(after.active_video_count) === Number(before.active_video_count) - 1,
      'the active video count decreases by one');
    ok(Number(after.recording_seconds) === Number(before.recording_seconds) - 60,
      'recorded seconds decrease by the duration');

    const delRow = (await db.execute(sql`select deleted_at from recordings where id = ${delRec}`)).rows[0];
    ok(delRow.deleted_at !== null, 'the recording is SOFT deleted — the row still exists');
    ok((await api('GET', `/recordings/${delRec}`, { as: alice })).status === 404, 'a deleted recording is no longer readable');
    ok(!(await api('GET', '/recordings', { as: alice })).body.items.some((r) => r.id === delRec),
      'a deleted recording disappears from the list');

    // Idempotent: a repeated delete must not decrement twice.
    const mid = await usageOf(alice);
    const del2 = await api('DELETE', `/recordings/${delRec}`, { as: alice });
    ok(del2.status === 200, 'deleting an already-deleted recording returns 200');
    const post = await usageOf(alice);
    ok(Number(post.storage_retained_bytes) === Number(mid.storage_retained_bytes),
      'a repeated delete does NOT decrement the ledger again');
    ok(Number(post.active_video_count) === Number(mid.active_video_count),
      'a repeated delete does not double-decrement the video count');

    // Concurrency: simultaneous deletes of the SAME recording.
    const raceRec = (await api('POST', '/recordings', { body: { title: 'Race', source: 'extension' }, as: alice })).body.id;
    await db.execute(sql`update recordings set size_bytes = 500, duration = 30 where id = ${raceRec}`);
    const beforeRace = await usageOf(alice);
    const [d1, d2, d3] = await Promise.all([
      api('DELETE', `/recordings/${raceRec}`, { as: alice }),
      api('DELETE', `/recordings/${raceRec}`, { as: alice }),
      api('DELETE', `/recordings/${raceRec}`, { as: alice }),
    ]);
    ok([d1, d2, d3].every((d) => d.status === 200), 'three simultaneous deletes all succeed');
    const afterRace = await usageOf(alice);
    ok(Number(afterRace.storage_retained_bytes) === Number(beforeRace.storage_retained_bytes) - 500,
      'concurrent deletes decrement the ledger EXACTLY ONCE');
    ok(Number(afterRace.active_video_count) === Number(beforeRace.active_video_count) - 1,
      'concurrent deletes decrement the video count exactly once');

    // The ledger can never be driven negative into its CHECK constraints.
    const zeroUser = await seedUser(`usr_${nextId()}`);
    const zeroRec = (await api('POST', '/recordings', { body: { title: 'Zero', source: 'extension' }, as: zeroUser })).body.id;
    await db.execute(sql`update recordings set size_bytes = 999999, duration = 9999 where id = ${zeroRec}`);
    const zdel = await api('DELETE', `/recordings/${zeroRec}`, { as: zeroUser });
    ok(zdel.status === 200, 'deleting with an empty ledger succeeds');
    const zu = await usageOf(zeroUser);
    ok(Number(zu.storage_retained_bytes) === 0 && Number(zu.active_video_count) === 0,
      'the ledger clamps at zero rather than violating its CHECK constraints');

    // Rollback: if the ledger write fails, the delete must not stand.
    const rbRec = (await api('POST', '/recordings', { body: { title: 'Rollback', source: 'extension' }, as: alice })).body.id;
    const rbApp = express();
    rbApp.use('/api/v1', createRecordingsRouter({
      repositories: () => createRepositories(db),
      withTransaction: (fn) => rawTx(async (tx) => fn({
        ...tx, usage: { ...tx.usage, applyDelta: async () => { throw new Error('injected ledger failure'); } },
      })),
      storage: null,
      requireAuth: (req, _res, next) => { req.userId = alice; req.id = 'req_t'; next(); },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    }));
    const rbSrv = await new Promise((r) => { const s = rbApp.listen(0, '127.0.0.1', () => r(s)); });
    const rbRes = await fetch(`http://127.0.0.1:${rbSrv.address().port}/api/v1/recordings/${rbRec}`, { method: 'DELETE' });
    const rbBody = await rbRes.json();
    ok(rbRes.status >= 500, `an injected ledger failure surfaces as a server error (got ${rbRes.status})`);
    ok(!/injected ledger failure/.test(JSON.stringify(rbBody)), 'the internal failure is not leaked');
    ok((await db.execute(sql`select deleted_at from recordings where id = ${rbRec}`)).rows[0].deleted_at === null,
      'the soft delete ROLLED BACK with the failed ledger write — the recording is intact');
    rbSrv.close();

    // ── G. Boundaries ────────────────────────────────────────────────────────
    console.log('\nG. Boundaries');
    const src = fs.readFileSync(path.join(API_DIR, 'src', 'recordings.router.js'), 'utf8');
    const code = src.split('\n').filter((l) => {
      const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    }).join('\n');
    ok(!/@aws-sdk|S3Client/.test(code), 'the recordings router contains no storage SDK');
    ok(!/cloudinary/i.test(code), 'the recordings router contains no Cloudinary logic');
    ok(!/sql`|SELECT |INSERT INTO|db\.execute|drizzle/i.test(code), 'the recordings router contains no raw SQL');
    const err = await api('GET', '/recordings/nope', { as: alice });
    ok(err.body.error && typeof err.body.error.code === 'string' && 'requestId' in err.body.error,
      'errors use the nested /api/v1 contract with a requestId');
  } finally {
    server.close();
  }

  await pool.end().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
