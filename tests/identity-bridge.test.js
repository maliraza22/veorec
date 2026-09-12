// Legacy → PostgreSQL identity bridge tests (T-304 prerequisite)
//
// Real PostgreSQL. The bridge decides WHOSE data a v1 request touches, so the
// properties worth proving are ownership properties, and a mock cannot show
// that a scoped SQL predicate actually matched the right row.
//
// The central case: a caller presenting a LEGACY id must reach the imported
// `usr_<legacyId>` record — with no second, raw-id user seeded anywhere.
'use strict';

const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const API_DIR = path.join(ROOT, 'api');

const express = require(path.join(API_DIR, 'node_modules', 'express'));
const { loadEnv, createPool, createClient, createRepositories, withTransaction: rawTx } =
  require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));
const {
  createRecordingsRouter, createUploadRouter, canonicalIdFor, scopeOf,
} = require(path.join(API_DIR, 'src', 'index.js'));
const { idFor } = require(path.join(DB_DIR, 'src', 'legacy-ids.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.IDENTITY_TESTS_REQUIRED === '1';
const MINIO = process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100';
const RUN = crypto.randomBytes(4).toString('hex');
let n = 0;
// Legacy ids look like the uuids the legacy JWT actually carries — deliberately
// with no `usr_` prefix, so a missing translation cannot accidentally work.
const nextLegacyId = () => `8332889e-a1e9-45de-9eb9-${RUN}${String(n += 1).padStart(8, '0')}`;

(async () => {
  console.log('Identity bridge tests (legacy JWT id → PostgreSQL usr_<legacyId>)');

  const env = loadEnv({ appEnv: 'test' });
  const pool = createPool({ env, max: 8 });
  let pgUp = false;
  try { await pool.query('select 1'); pgUp = true; } catch {}
  if (!pgUp) {
    console.log('\n  SKIPPED — PostgreSQL unreachable; the identity bridge was NOT verified.');
    await pool.end().catch(() => {});
    if (REQUIRED) { console.log('  FAIL: IDENTITY_TESTS_REQUIRED=1'); process.exit(1); }
    console.log('\n0 passed, 0 failed (skipped)');
    process.exit(0);
  }
  let storageUp = false;
  try {
    const r = await fetch(`${MINIO}/minio/health/live`, { signal: AbortSignal.timeout(2000) });
    storageUp = r.ok;
  } catch {}

  const db = createClient(pool);
  await db.execute(sql`truncate table video_assets, upload_parts, upload_sessions, processing_jobs, recordings, folders, usage, users restart identity cascade`);

  let currentUser = null;
  const auth = (req, res, next) => {
    if (!currentUser) return res.status(401).json({ error: { code: 'unauthorized', message: 'no' } });
    // Exactly what server/auth.js does: the RAW legacy id from the JWT.
    req.userId = currentUser; req.id = 'req_test'; next();
  };

  const app = express();
  app.use('/api/v1', createRecordingsRouter({
    repositories: () => createRepositories(db), withTransaction: rawTx,
    storage: null, requireAuth: auth,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }));
  let storagePkg = null;
  if (storageUp) {
    storagePkg = require(path.join(ROOT, 'storage', 'src', 'index.js'));
    app.use('/api/v1', createUploadRouter({ rateLimits: { sessions: { max: 100000, windowMs: 3600000 } },
      repositories: () => createRepositories(db), withTransaction: rawTx,
      storage: storagePkg.createStorageProvider({ appEnv: 'test' }),
      keys: storagePkg.keys, requireAuth: auth,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    }));
  }
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

  /** Insert ONLY the mirrored row the importer/dual-write would have produced. */
  async function seedMirroredUser(legacyId) {
    await db.execute(sql`INSERT INTO users (id,email,name,password_hash)
      VALUES (${idFor('usr', legacyId)}, ${`${legacyId}@example.com`}, 'U', 'x')`);
    await db.execute(sql`INSERT INTO usage (user_id) VALUES (${idFor('usr', legacyId)})
      ON CONFLICT (user_id) DO NOTHING`);
    return legacyId;
  }

  try {
    // ── 1. The mapping is the canonical one, not a new format ────────────────
    console.log('\n1. The mapping');
    ok(canonicalIdFor() === idFor,
      'the bridge uses the EXACT canonical idFor from db/src/legacy-ids.js, not a copy');
    ok(idFor('usr', 'abc') === 'usr_abc', 'the canonical mapping is usr_<legacyId>');

    // ── 2. A legacy id resolves to the imported PostgreSQL identity ──────────
    console.log('\n2. Legacy id resolves to the imported identity');
    const legacyAlice = await seedMirroredUser(nextLegacyId());
    const before = (await db.execute(sql`select count(*)::int n from users`)).rows[0].n;

    const created = await api('POST', '/recordings',
      { body: { title: 'Bridged', source: 'extension' }, as: legacyAlice });
    ok(created.status === 201,
      `a caller presenting a LEGACY id can create a recording (got ${created.status})`);

    const row = (await db.execute(sql`select * from recordings where id = ${created.body.id}`)).rows[0];
    ok(row.user_id === idFor('usr', legacyAlice),
      'the recording is owned by usr_<legacyId>, the imported identity');
    ok(row.user_id !== legacyAlice, 'the raw legacy id is NOT used as the owner');

    // ── 3. No duplicate user is created ──────────────────────────────────────
    const after = (await db.execute(sql`select count(*)::int n from users`)).rows[0].n;
    ok(after === before, 'NO user row was created at runtime — the bridge only translates');
    ok((await db.execute(sql`select count(*)::int n from users where id = ${legacyAlice}`)).rows[0].n === 0,
      'no raw-legacy-id user exists anywhere');

    // ── 4. T-302 recordings endpoints all work for that user ────────────────
    console.log('\n3. T-302 recordings endpoints work without a hand-seeded raw-id user');
    const recId = created.body.id;
    ok((await api('GET', '/recordings', { as: legacyAlice })).body.items.some((r) => r.id === recId),
      'GET /recordings lists the recording');
    ok((await api('GET', `/recordings/${recId}`, { as: legacyAlice })).status === 200,
      'GET /recordings/:id returns it');
    ok((await api('PATCH', `/recordings/${recId}`, { body: { title: 'Renamed' }, as: legacyAlice })).status === 200,
      'PATCH /recordings/:id updates it');
    ok((await api('PATCH', `/recordings/${recId}/meta`, { body: { description: 'd' }, as: legacyAlice })).status === 200,
      'PATCH /recordings/:id/meta updates it');

    // ── 5. T-301 upload-session endpoints work for that user ────────────────
    console.log('\n4. T-301 upload-session endpoints work for the same caller');
    if (!storageUp) {
      console.log('  (object storage unavailable — upload-session checks skipped)');
      if (REQUIRED) { fail++; console.log('  FAIL: IDENTITY_TESTS_REQUIRED=1 with no object storage'); }
    } else {
      const up = await api('POST', '/uploads', {
        body: { recordingId: recId, mimeType: 'video/webm' },
        headers: { 'Idempotency-Key': `k-${RUN}` }, as: legacyAlice,
      });
      ok(up.status === 201, `POST /uploads succeeds for a legacy-id caller (got ${up.status})`);
      const sess = (await db.execute(sql`select * from upload_sessions where id = ${up.body.uploadSessionId}`)).rows[0];
      ok(sess.user_id === idFor('usr', legacyAlice),
        'the upload session is owned by the imported PostgreSQL identity');
      ok((await api('GET', `/uploads/${up.body.uploadSessionId}`, { as: legacyAlice })).status === 200,
        'GET /uploads/:id resolves for the same caller');
      ok((await api('DELETE', `/uploads/${up.body.uploadSessionId}`, { as: legacyAlice })).status === 200,
        'DELETE /uploads/:id resolves for the same caller');
    }

    // ── 6. Ownership isolation survives the translation ─────────────────────
    console.log('\n5. Ownership isolation');
    const legacyBob = await seedMirroredUser(nextLegacyId());
    ok((await api('GET', `/recordings/${recId}`, { as: legacyBob })).status === 404,
      "another user's recording is still 404 after translation");
    ok((await api('PATCH', `/recordings/${recId}`, { body: { title: 'hax' }, as: legacyBob })).status === 404,
      'a cross-user PATCH is still refused');
    ok((await db.execute(sql`select title from recordings where id = ${recId}`)).rows[0].title === 'Renamed',
      "the cross-user attempt did not modify the owner's recording");
    ok(!(await api('GET', '/recordings', { as: legacyBob })).body.items.some((r) => r.id === recId),
      "another user's list never includes it");

    // Two users whose legacy ids differ must never collide after mapping.
    ok(idFor('usr', legacyAlice) !== idFor('usr', legacyBob),
      'distinct legacy ids map to distinct PostgreSQL identities');

    // ── 7. A missing mirror fails predictably and safely ────────────────────
    console.log('\n6. Missing PostgreSQL mirror');
    const unmirrored = nextLegacyId();              // authenticated, but never imported
    const miss = await api('GET', '/recordings', { as: unmirrored });
    ok(miss.status === 503, `an unmirrored account gets 503, not a crash (got ${miss.status})`);
    ok(miss.body.error.code === 'account_not_migrated',
      'the code names the real cause: the migration has not reached this account');
    ok(miss.status !== 500, 'it is not reported as an internal error');
    ok(miss.status !== 403 && miss.status !== 401,
      'it is not reported as an authorization failure — the caller did nothing wrong');
    // Nothing leaks about other accounts, and nothing is created.
    ok(!JSON.stringify(miss.body).includes('usr_'),
      'the response does not disclose the derived PostgreSQL identity');
    ok((await db.execute(sql`select count(*)::int n from users`)).rows[0].n === after + 1,
      'the failed request created NO user row (only Bob was added above)');
    const missPost = await api('POST', '/recordings',
      { body: { title: 'x', source: 'extension' }, as: unmirrored });
    ok(missPost.status === 503,
      'a write from an unmirrored account fails the same way, not as a foreign-key 422');
    ok((await db.execute(sql`select count(*)::int n from recordings where title = 'x'`)).rows[0].n === 0,
      'no recording row was created for an unmirrored account');

    // An unmirrored caller learns nothing about a real recording's existence.
    const probeReal = await api('GET', `/recordings/${recId}`, { as: unmirrored });
    const probeFake = await api('GET', '/recordings/rec_does_not_exist', { as: unmirrored });
    ok(probeReal.status === probeFake.status && probeReal.body.error.code === probeFake.body.error.code,
      'an unmirrored caller cannot distinguish a real recording from a missing one');

    // ── 8. Unauthenticated still 401, ahead of the bridge ───────────────────
    currentUser = null;
    ok((await api('GET', '/recordings')).status === 401,
      'an unauthenticated request is still 401 — requireAuth runs before the bridge');

    // ── 9. scopeOf refuses to fall back to the legacy id ────────────────────
    console.log('\n7. The scope helper');
    let threw = null;
    try { scopeOf({ userId: 'raw-legacy-id' }); } catch (e) { threw = e; }
    ok(threw && threw.status === 500,
      'scopeOf REFUSES an untranslated request rather than silently using the legacy id');
    ok(scopeOf({ pgUserId: 'usr_x' }).userId === 'usr_x', 'scopeOf returns the PostgreSQL identity');

    // ── 10. The legacy identity is preserved for legacy code ────────────────
    console.log('\n8. Legacy identity preserved');
    const fs = require('fs');
    const bridgeSrc = fs.readFileSync(path.join(API_DIR, 'src', 'identity.js'), 'utf8');
    ok(/req\.legacyUserId = legacyUserId/.test(bridgeSrc), 'the legacy id is preserved explicitly');
    ok(!/req\.userId\s*=/.test(bridgeSrc),
      'the bridge NEVER reassigns req.userId — 59 legacy routes still read it as the legacy id');
    const authSrc = fs.readFileSync(path.join(ROOT, 'server', 'auth.js'), 'utf8');
    ok(/req\.userId = userId/.test(authSrc) && !/usr_/.test(authSrc),
      'server/auth.js is untouched and still yields the raw legacy id');
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
    ok(!/pgUserId/.test(serverSrc), 'the legacy server knows nothing about the translated identity');

    // The translation exists in exactly ONE place.
    const routers = ['uploads.router.js', 'recordings.router.js']
      .map((f2) => fs.readFileSync(path.join(API_DIR, 'src', f2), 'utf8'));
    ok(routers.every((r) => !/idFor\(/.test(r)),
      'no router performs its own translation — there is one adapter');
    ok(routers.every((r) => /createIdentityBridge/.test(r) && /scopeOf\(req\)/.test(r)),
      'every v1 router mounts the bridge and builds its scope through the shared helper');
    ok(routers.every((r) => !/userId: req\.userId/.test(r)),
      'no router builds a scope from the raw legacy id any more');
  } finally {
    server.close();
  }

  await pool.end().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
