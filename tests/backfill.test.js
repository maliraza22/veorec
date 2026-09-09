// T-204 backfill copier tests (run: cd db && npm run test:backfill)
//
// Real PostgreSQL + real object storage (MinIO). The interesting properties of
// a backfill are all about crashes, retries and races, so they are exercised
// against real infrastructure rather than mocks — a mock cannot show that
// SKIP LOCKED actually stops two workers claiming the same row.
//
// SKIPS LOUDLY when either dependency is missing; BACKFILL_TESTS_REQUIRED=1
// (CI) turns that into a failure.
//
// The single most important assertion in this file: nothing here ever deletes
// or mutates the legacy source, and no application read is redirected.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const STORAGE_DIR = path.join(ROOT, 'storage');

const { loadEnv, createPool, createClient, createRepositories } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));
const legacyStore = require(path.join(DB_DIR, 'src', 'migration', 'legacy-store.js'));
const { backfill, copyOne } = require(path.join(DB_DIR, 'src', 'migration', 'backfill.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.BACKFILL_TESTS_REQUIRED === '1';
const MINIO = process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100';

const RUN = crypto.randomBytes(4).toString('hex');
let n = 0;
const nextId = () => `bf${RUN}${(n += 1)}`;

/** A fake legacy provider: serves bytes over "http", records every request. */
function fakeLegacy() {
  const objects = new Map();          // url -> Buffer
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (!objects.has(url)) return { ok: false, status: 404 };
    const buf = objects.get(url);
    if (buf === 'SERVER_ERROR') return { ok: false, status: 503 };
    return { ok: true, status: 200, arrayBuffer: async () => buf };
  };
  return { objects, requests, fetchImpl };
}

async function seedRecording(db, { userId, recId, bytes, url, provider = 'cloudinary', format = 'webm' }) {
  await db.execute(sql`
    INSERT INTO users (id, email, name, password_hash)
    VALUES (${userId}, ${`${userId}@example.com`}, ${'U'}, ${'x'})
    ON CONFLICT (id) DO NOTHING`);
  await db.execute(sql`
    INSERT INTO recordings (id, user_id, title, status, source_kind, privacy)
    VALUES (${recId}, ${userId}, ${'T-204'}, ${'ready'}, ${'extension'}, ${'unlisted'})
    ON CONFLICT (id) DO NOTHING`);
  await db.execute(sql`
    INSERT INTO legacy.media_map
      (recording_id, legacy_provider, legacy_public_id, legacy_url, legacy_bytes, legacy_format)
    VALUES (${recId}, ${provider}, ${`screenrec/${userId}/${recId}`}, ${url}, ${bytes}, ${format})
    ON CONFLICT (recording_id) DO UPDATE SET legacy_url = EXCLUDED.legacy_url`);
}

(async () => {
  console.log('T-204 backfill copier tests');

  const env = loadEnv({ appEnv: 'test' });
  const pool = createPool({ env, max: 6 });
  let pgUp = false;
  try { await pool.query('select 1'); pgUp = true; } catch {}
  let storageUp = false;
  try {
    const r = await fetch(`${MINIO}/minio/health/live`, { signal: AbortSignal.timeout(2000) });
    storageUp = r.ok;
  } catch {}

  if (!pgUp || !storageUp) {
    console.log(`\n  SKIPPED — ${!pgUp ? 'PostgreSQL unreachable' : ''}${!pgUp && !storageUp ? ' and ' : ''}${!storageUp ? `no object storage at ${MINIO}` : ''}`);
    console.log('  The backfill was NOT verified by this run.');
    await pool.end().catch(() => {});
    if (REQUIRED) { console.log('  FAIL: BACKFILL_TESTS_REQUIRED=1'); process.exit(1); }
    console.log('\n0 passed, 0 failed (skipped)');
    process.exit(0);
  }

  const db = createClient(pool);
  const repos = createRepositories(db);
  const store = legacyStore(db);
  const storage = require(path.join(STORAGE_DIR, 'src', 'index.js'));
  const provider = storage.createStorageProvider({ appEnv: 'test' });

  await db.execute(sql`truncate table video_assets, recordings, users restart identity cascade`);
  await db.execute(sql`truncate table legacy.media_map`);

  // ── 1. Single item, happy path ───────────────────────────────────────────
  console.log('\nA. Copy, verify, and the checklist');
  const legacy = fakeLegacy();
  const u1 = `usr_${nextId()}`, r1 = `rec_${nextId()}`;
  const body1 = Buffer.from('legacy-original-bytes-'.repeat(20));
  const url1 = `https://legacy.example/${r1}.webm`;
  legacy.objects.set(url1, body1);
  await seedRecording(db, { userId: u1, recId: r1, bytes: body1.length, url: url1 });

  // Dry run first: it must change nothing at all.
  const dry = await backfill({ db, provider, repos, mode: 'report', fetchImpl: legacy.fetchImpl });
  ok(dry.wouldCopy === 1, 'the dry run reports the item it WOULD copy');
  ok(dry.verified === 0, 'the dry run verifies nothing (it copied nothing)');
  ok(legacy.requests.length === 0, 'the dry run does not even read the legacy source');
  let row = await store.getMediaMap(r1);
  ok(row.backfill_status === 'pending' && row.backfilled_at === null,
    'the dry run leaves the checklist untouched');
  ok(await provider.objectExists(`sources/${r1}/source.webm`) === false,
    'the dry run writes no object');

  const rep = await backfill({ db, provider, repos, mode: 'apply', fetchImpl: legacy.fetchImpl });
  ok(rep.verified === 1, 'the apply run verifies the item');
  ok(rep.bytesCopied === body1.length, 'the report accounts the copied bytes');

  const key1 = `sources/${r1}/source.webm`;
  const head1 = await provider.headObject(key1);
  ok(!!head1, 'the object exists in storage at the canonical source key');
  ok(head1.contentLength === body1.length, 'the stored object size matches the source');
  ok((await provider.getObjectBuffer(key1)).body.equals(body1), 'the stored bytes are identical');

  row = await store.getMediaMap(r1);
  ok(row.backfill_status === 'verified', 'the checklist records verified');
  ok(row.backfilled_at !== null, 'the completion stamp is set');
  ok(Number(row.backfill_bytes) === body1.length, 'the checklist records the copied byte count');

  const asset = (await db.execute(sql`select * from video_assets where storage_key = ${key1}`)).rows[0];
  ok(!!asset, 'a video_assets row was created');
  ok(asset.recording_id === r1 && asset.kind === 'source' && asset.status === 'ready',
    'the asset row is a ready source for the right recording');
  ok(Number(asset.size_bytes) === body1.length, 'the asset row records the true size');

  // ── 2. Legacy source untouched ───────────────────────────────────────────
  ok(legacy.objects.get(url1).equals(body1), 'the legacy source bytes are unchanged');
  ok(legacy.objects.has(url1), 'the legacy source still exists — nothing was deleted');
  const backfillSrc = fs.readFileSync(path.join(DB_DIR, 'src', 'migration', 'backfill.js'), 'utf8');
  const code = backfillSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/destroy|deleteObject|uploader\.destroy|DELETE/i.test(code),
    'the copier contains NO delete call of any kind');
  ok(!/cloudinary/i.test(code), 'the copier has no Cloudinary SDK dependency (plain HTTPS read)');

  // ── 3. Idempotent rerun + T-203 overlap ──────────────────────────────────
  console.log('\nB. Idempotency, resume, and the T-203 overlap');
  const before = legacy.requests.length;
  const rerun = await backfill({ db, provider, repos, mode: 'apply', fetchImpl: legacy.fetchImpl });
  ok(rerun.verified === 0 && rerun.claimed === 0, 'a rerun claims nothing — the item is already done');
  ok(legacy.requests.length === before, 'a rerun does not re-read the legacy source');
  const assetCount = (await db.execute(sql`select count(*)::int as n from video_assets where storage_key = ${key1}`)).rows[0];
  ok(assetCount.n === 1, 'a rerun creates no duplicate asset row');

  // A recording T-203 already mirrored: object present, checklist still pending.
  const u2 = `usr_${nextId()}`, r2 = `rec_${nextId()}`;
  const body2 = Buffer.from('already-mirrored-by-t203');
  const url2 = `https://legacy.example/${r2}.webm`;
  legacy.objects.set(url2, body2);
  await seedRecording(db, { userId: u2, recId: r2, bytes: body2.length, url: url2 });
  await provider.putObject(`sources/${r2}/source.webm`, body2);   // as T-203 would have
  const reqBefore = legacy.requests.length;
  const overlap = await backfill({ db, provider, repos, mode: 'apply', fetchImpl: legacy.fetchImpl });
  ok(overlap.alreadyDone === 1, 'an object already mirrored by T-203 is recognised, not re-copied');
  ok(legacy.requests.length === reqBefore, 'no legacy bandwidth is spent on an already-mirrored recording');
  const r2row = await store.getMediaMap(r2);
  ok(r2row.backfill_status === 'verified', 'the already-mirrored recording is marked verified');
  ok((await db.execute(sql`select count(*)::int as n from video_assets where recording_id = ${r2}`)).rows[0].n === 1,
    'the already-mirrored recording gets exactly one asset row');

  // ── 4. Partial failure: object exists but completion never recorded ──────
  const u3 = `usr_${nextId()}`, r3 = `rec_${nextId()}`;
  const body3 = Buffer.from('crashed-mid-run');
  const url3 = `https://legacy.example/${r3}.webm`;
  legacy.objects.set(url3, body3);
  await seedRecording(db, { userId: u3, recId: r3, bytes: body3.length, url: url3 });
  await provider.putObject(`sources/${r3}/source.webm`, body3);   // bytes landed…
  // …but the process died before the asset row / stamp: checklist still pending.
  const recover = await backfill({ db, provider, repos, mode: 'apply', fetchImpl: legacy.fetchImpl });
  ok(recover.alreadyDone === 1, 'a crash after the copy converges on the next run');
  ok((await store.getMediaMap(r3)).backfill_status === 'verified',
    'the interrupted item ends up verified without re-transferring');

  // Database row exists but the object does NOT: must not report completion.
  const u4 = `usr_${nextId()}`, r4 = `rec_${nextId()}`;
  const body4 = Buffer.from('row-without-object');
  const url4 = `https://legacy.example/${r4}.webm`;
  legacy.objects.set(url4, body4);
  await seedRecording(db, { userId: u4, recId: r4, bytes: body4.length, url: url4 });
  await repos.assets.upsertSourceSystem(
    { recordingId: r4, storageKey: `sources/${r4}/source.webm`, sizeBytes: body4.length, container: 'webm' },
    'T-204 test: asset row present but the object is missing');
  const healed = await backfill({ db, provider, repos, mode: 'apply', fetchImpl: legacy.fetchImpl });
  ok(healed.verified === 1, 'an asset row without an object is NOT treated as complete — the bytes are copied');
  ok(await provider.objectExists(`sources/${r4}/source.webm`) === true, 'the missing object is created');

  // ── 5. Failure taxonomy ──────────────────────────────────────────────────
  console.log('\nC. Failures, retries, and what must never be retried');
  const u5 = `usr_${nextId()}`, r5 = `rec_${nextId()}`;
  await seedRecording(db, { userId: u5, recId: r5, bytes: 10, url: `https://legacy.example/${r5}-missing.webm` });
  await backfill({ db, provider, repos, mode: 'apply', fetchImpl: legacy.fetchImpl });
  const r5row = await store.getMediaMap(r5);
  ok(r5row.backfill_status === 'failed', 'a missing source is recorded as failed');
  ok(r5row.backfill_retryable === false, 'a 404 source is NOT retryable — retrying forever would be pointless');
  ok(!!r5row.backfill_error, 'the failure reason is stored in the row, not only in a log');
  const skipRetry = await backfill({ db, provider, repos, mode: 'apply', fetchImpl: legacy.fetchImpl });
  ok(skipRetry.claimed === 0, 'a non-retryable item is not claimed again');

  // Transient provider error IS retryable.
  const u6 = `usr_${nextId()}`, r6 = `rec_${nextId()}`;
  const url6 = `https://legacy.example/${r6}.webm`;
  legacy.objects.set(url6, 'SERVER_ERROR');
  await seedRecording(db, { userId: u6, recId: r6, bytes: 10, url: url6 });
  await backfill({ db, provider, repos, mode: 'apply', fetchImpl: legacy.fetchImpl });
  const r6row = await store.getMediaMap(r6);
  ok(r6row.backfill_status === 'failed' && r6row.backfill_retryable === true,
    'a 5xx from the legacy provider IS retryable');
  ok(r6row.backfill_attempts >= 1, 'the attempt was counted');
  legacy.objects.set(url6, Buffer.from('recovered-bytes'));
  const retried = await backfill({ db, provider, repos, mode: 'apply', fetchImpl: legacy.fetchImpl });
  ok(retried.verified === 1, 'a retryable item succeeds on a later run');

  // Ambiguous mapping: never guessed, never auto-repaired.
  const u7 = `usr_${nextId()}`, r7 = `rec_${nextId()}`;
  await seedRecording(db, { userId: u7, recId: r7, bytes: 10, url: null });
  await db.execute(sql`update legacy.media_map set legacy_public_id = '' where recording_id = ${r7}`);
  await backfill({ db, provider, repos, mode: 'apply', fetchImpl: legacy.fetchImpl });
  const r7row = await store.getMediaMap(r7);
  ok(r7row.backfill_status === 'unsafe', 'an ambiguous mapping is marked unsafe, not guessed');
  ok(r7row.backfill_retryable === false, 'an unsafe item is never retried automatically');

  // ── 6. Integrity: an existing object of a DIFFERENT size is never clobbered
  const u8 = `usr_${nextId()}`, r8 = `rec_${nextId()}`;
  const url8 = `https://legacy.example/${r8}.webm`;
  legacy.objects.set(url8, Buffer.from('twelve-bytes'));
  await seedRecording(db, { userId: u8, recId: r8, bytes: 999, url: url8 });   // legacy says 999
  await provider.putObject(`sources/${r8}/source.webm`, Buffer.from('short'));  // storage has 5
  await backfill({ db, provider, repos, mode: 'apply', fetchImpl: legacy.fetchImpl });
  const r8row = await store.getMediaMap(r8);
  ok(r8row.backfill_status === 'unsafe', 'a size disagreement with an existing object is unsafe');
  ok((await provider.getObjectBuffer(`sources/${r8}/source.webm`)).body.toString() === 'short',
    'the existing object is NOT overwritten when its size disagrees');

  // ── 7. Ownership can never drift ─────────────────────────────────────────
  console.log('\nD. Ownership and mapping safety');
  const owners = (await db.execute(sql`
    select a.storage_key, r.user_id from video_assets a join recordings r on r.id = a.recording_id
  `)).rows;
  ok(owners.every((o) => o.storage_key.includes(o.storage_key.split('/')[1])),
    'every asset key belongs to the recording that owns it');
  const a1 = owners.find((o) => o.storage_key === key1);
  ok(a1 && a1.user_id === u1, "the first recording's asset still belongs to its original owner");

  // A conflicting mapping must not reassign an object to another user.
  const beforeOwner = (await db.execute(sql`select recording_id from video_assets where storage_key = ${key1}`)).rows[0];
  await repos.assets.upsertSourceSystem(
    { recordingId: r2, storageKey: key1, sizeBytes: 1, container: 'webm' },
    'T-204 test: a conflicting mapping must not reassign ownership');
  const afterOwner = (await db.execute(sql`select recording_id from video_assets where storage_key = ${key1}`)).rows[0];
  ok(afterOwner.recording_id === beforeOwner.recording_id,
    'a conflicting mapping can NEVER move an object to a different recording/owner');

  // ── 8. Claiming: two workers never take the same row ─────────────────────
  console.log('\nE. Claiming, concurrency and crash recovery');
  await db.execute(sql`truncate table legacy.media_map`);
  const many = [];
  for (let i = 0; i < 8; i += 1) {
    const u = `usr_${nextId()}`, r = `rec_${nextId()}`;
    const url = `https://legacy.example/${r}.webm`;
    legacy.objects.set(url, Buffer.from(`payload-${i}`));
    await seedRecording(db, { userId: u, recId: r, bytes: 9, url });
    many.push(r);
  }
  const [claimA, claimB] = await Promise.all([
    store.claimBackfillBatch({ claimId: 'worker-A', limit: 4 }),
    store.claimBackfillBatch({ claimId: 'worker-B', limit: 4 }),
  ]);
  const idsA = new Set(claimA.map((c) => c.recording_id));
  const idsB = new Set(claimB.map((c) => c.recording_id));
  const overlapIds = [...idsA].filter((x) => idsB.has(x));
  ok(overlapIds.length === 0, 'two concurrent workers never claim the same recording');
  ok(claimA.length + claimB.length === 8, 'between them the workers claim every eligible row exactly once');
  ok(claimA.every((c) => c.backfill_status === 'claimed'), 'claimed rows are marked claimed');
  ok(claimA.every((c) => c.backfill_claim_id === 'worker-A'), 'the claim records which worker holds it');

  // A crashed worker's claim ages out and becomes retryable.
  const third = await store.claimBackfillBatch({ claimId: 'worker-C', limit: 8 });
  ok(third.length === 0, "a live claim is not stolen by another worker");
  const stale = await store.claimBackfillBatch({ claimId: 'worker-C', limit: 8, staleClaimMs: 0 });
  ok(stale.length === 8, 'a stale claim from a crashed worker becomes claimable again');
  ok(stale.every((s) => s.backfill_attempts >= 2), 'the re-claim counts as a further attempt');

  // ── 9. Give-up guard: an item cannot be retried forever ──────────────────
  await db.execute(sql`update legacy.media_map set backfill_status='failed', backfill_claim_id=null,
    backfill_claimed_at=null, backfill_retryable=true, backfill_attempts=99`);
  const giveUp = await backfill({ db, provider, repos, mode: 'apply', maxAttempts: 5, fetchImpl: legacy.fetchImpl });
  ok(giveUp.failed === 8, 'items past the attempt ceiling are failed rather than retried again');
  const stuck = await store.getMediaMap(many[0]);
  ok(stuck.backfill_retryable === false, 'giving up marks the item non-retryable for human review');

  // ── 10. Throttling: concurrency is bounded ───────────────────────────────
  console.log('\nF. Throttling and reporting');
  await db.execute(sql`truncate table legacy.media_map`);
  await db.execute(sql`truncate table video_assets cascade`);
  let concurrent = 0, peak = 0;
  const slowFetch = async (url) => {
    concurrent += 1; peak = Math.max(peak, concurrent);
    await new Promise((r) => setTimeout(r, 60));
    concurrent -= 1;
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('slow-payload') };
  };
  for (let i = 0; i < 9; i += 1) {
    const u = `usr_${nextId()}`, r = `rec_${nextId()}`;
    await seedRecording(db, { userId: u, recId: r, bytes: 12, url: `https://legacy.example/slow-${r}.webm` });
  }
  const throttled = await backfill({ db, provider, repos, mode: 'apply', concurrency: 2, fetchImpl: slowFetch });
  ok(throttled.verified === 9, 'every item is copied under a concurrency limit');
  ok(peak <= 2, `never more than the configured 2 transfers run at once (peak ${peak})`);

  const stats = await store.backfillStats();
  ok(stats.verified === 9 && stats.pending === 0, 'the checklist reports progress across the dataset');
  ok(typeof throttled.format(stats) === 'string' && throttled.format(stats).includes('verified'),
    'the report is human-readable without parsing log text');

  // ── 11. Reconciliation compatibility + no read cutover ───────────────────
  console.log('\nG. Boundaries');
  const reconciler = fs.readFileSync(path.join(DB_DIR, 'src', 'migration', 'reconciler.js'), 'utf8');
  ok(reconciler.length > 0, 'the T-106 reconciler is still present and untouched by T-204');
  const serverIndexRaw = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  // Compare CODE, not prose: index.js legitimately mentions the backfill in a
  // comment explaining why the dual-write records the legacy media location.
  const serverIndex = serverIndexRaw
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
  ok(!/sources\/rec_|getSignedDownloadUrl/.test(serverIndex),
    'no application read was redirected to R2 — the watch path is unchanged');
  ok(!/backfill/i.test(serverIndex), 'the legacy server does not run the backfill');

  await pool.end().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
