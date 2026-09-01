// T-104 legacy importer tests (run: cd db && npm run test:import)
//
// Fixture-driven, against REAL PostgreSQL. Covers the required matrix: empty
// source, single/multiple users, multiple recordings, ownership preservation,
// asset/folder relationships, duplicate import, interrupted import + resume,
// partial failure, orphans, invalid legacy data, legacy media mapping,
// duplicate media assets, deterministic mapping, dry-run purity, rollback,
// re-run producing no duplicates, reconciliation accuracy, and proof that the
// legacy sources are never modified.
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DB_DIR = path.join(__dirname, '..', 'db');

const { loadEnv, createPool, checkConnection, createClient, createRepositories } = require(path.join(DB_DIR, 'src', 'index.js'));
const { runImport, idFor, derivedId, parseLegacyPublicId } = require(path.join(DB_DIR, 'src', 'migration', 'importer.js'));
const { fingerprintSources } = require(path.join(DB_DIR, 'src', 'migration', 'sources.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// ── Fixtures ─────────────────────────────────────────────────────────────────
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const R1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const R2ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RORPHAN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const F1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function writeFixtures(dir, { includeMedia = true, invalid = false } = {}) {
  const w = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));
  w('users.json', [
    { id: U1, name: 'Alice', email: 'Alice@Example.com', password: '$2a$10$hashA', plan: 'free', created_at: 1700000000000 },
    { id: U2, name: 'Bob', email: 'bob@example.com', password: '$2a$10$hashB', googleId: 'g-bob', plan: 'pro', created_at: 1700000100000, manualPlan: 'pro' },
    ...(invalid ? [{ id: 'broken', name: 'No Email' }] : []),
  ]);
  w('folders.json', [
    { id: F1, userId: U1, name: 'Demos', created_at: 1700000200000 },
    { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', userId: 'ghost-user', name: 'Orphan folder', created_at: 1700000200000 },
  ]);
  w('meta.json', {
    [R1]: {
      title: 'Alice recording', description: 'desc', privacy: 'public', folder: F1,
      views: 2, viewKeys: ['v:visitor-1', 'u:' + U2], viewers: [{ name: 'Bob', at: 1700000500000 }],
      engagement: { sum: 1.4, n: 2, completed: 1 },
      comments: [{ id: 'c1', name: 'Bob', text: 'nice one', t: 3.5, at: 1700000600000 }],
      reactions: [{ emoji: '👍', name: 'Bob', t: 4, at: 1700000700000 }],
      leads: [{ email: 'lead@example.com', name: 'Lead', at: 1700000800000 }],
      tags: ['demo'], audience: { comments: true, requireEmail: false },
      trimStart: 1, trimEnd: 20, recommendedSpeed: 1.5,
      transcript: { status: 'done', language: 'en', text: 'hello world', created_at: 1700000900000,
        segments: [{ start: 0, end: 1.2, text: 'hello' }, { start: 1.2, end: 2.4, text: 'world' }] },
    },
    [R2ID]: { title: 'Bob recording', privacy: 'password', passwordHash: '$2a$10$pw', reactions: { '🔥': 2 } },
    // Metadata for a recording no ownership source knows about → orphan.
    [RORPHAN]: { title: 'Ghost recording', views: 5 },
  });
  w('subscriptions.json', {
    [U2]: { id: 'sub-legacy-1', userId: U2, paddleSubscriptionId: 'psub_1', planSlug: 'pro',
      status: 'active', billingCycle: 'monthly', currentPeriodEnd: 1800000000000, createdAt: 1700000000000 },
    'ghost-user': { userId: 'ghost-user', planSlug: 'pro', status: 'active' },
  });
  w('usage.json', {
    [U1]: { userId: U1, storageUsedBytes: 4096, videoCount: 1, recordingMinutesUsed: 2.5, monthlyUploads: 1, monthlyUploadsPeriod: '2026-08' },
  });
  w('contacts.json', {
    'ctc-1': { id: 'ctc-1', name: 'Carol', email: 'carol@example.com', subject: 'hi', message: 'hello', status: 'new', createdAt: 1700001000000 },
  });
  w('notif-reads.json', { [U1]: 1700001100000 });
  w('plan_overrides.json', { free: { maxVideos: 50, storageLimitGB: 5 } });
  w('upgrade_events.json', [
    { userId: U1, featureRequested: 'storage_limit_reached', userPlan: 'free', meta: {}, timestamp: 1700001200000 },
    { userId: U1, featureRequested: 'analytics_attempted', userPlan: 'free', meta: {}, timestamp: 1700001300000 },
  ]);
  w('recordings.json', []);

  const mediaFile = path.join(dir, 'media.json');
  if (includeMedia) {
    fs.writeFileSync(mediaFile, JSON.stringify({
      exportedAt: new Date().toISOString(), provider: 'cloudinary',
      resources: [
        { public_id: `screenrec/${U1}/${R1}`, secure_url: 'https://res.cloudinary.com/x/v1/a.webm',
          bytes: 4096, duration: 12.5, width: 1920, height: 1080, format: 'webm',
          created_at: '2026-08-01T10:00:00Z', context: { rec_id: R1, user_id: U1, title: 'Alice recording' } },
        { public_id: `screenrec/${U2}/${R2ID}`, secure_url: 'https://res.cloudinary.com/x/v1/b.webm',
          bytes: 8192, duration: 30, width: 1280, height: 720, format: 'webm',
          created_at: '2026-08-02T10:00:00Z', context: { rec_id: R2ID, user_id: U2 } },
        // Editor artefact that must be ignored, and a duplicate of R1.
        { public_id: `screenrec/${U1}/${R1}__trim_1700000000000`, secure_url: 'x', bytes: 1, context: {} },
        { public_id: `screenrec/${U1}/${R1}`, secure_url: 'https://res.cloudinary.com/x/v1/a-dup.webm',
          bytes: 4096, duration: 12.5, format: 'webm', context: { rec_id: R1, user_id: U1 } },
      ],
    }, null, 2));
  }
  return includeMedia ? mediaFile : null;
}

const count = async (client, table) => {
  const res = await client.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`));
  return Number((res.rows || res)[0].n);
};
const snapshot = async (client) => ({
  users: await count(client, 'users'), recordings: await count(client, 'recordings'),
  folders: await count(client, 'folders'), comments: await count(client, 'comments'),
  reactions: await count(client, 'reactions'), views: await count(client, 'view_sessions'),
  leads: await count(client, 'leads'), transcripts: await count(client, 'transcripts'),
  segments: await count(client, 'transcript_segments'), usage: await count(client, 'usage'),
  subscriptions: await count(client, 'subscriptions'), contacts: await count(client, 'contacts'),
  analytics: await count(client, 'analytics_events'), mediaMap: await count(client, 'legacy.media_map'),
  assets: await count(client, 'video_assets'),
});

async function main() {
  const env = loadEnv({ appEnv: 'test' });
  const probe = await checkConnection(createPool({ env, max: 1 }));
  if (!probe.ok) {
    const msg = `database unreachable at ${env.databaseUrlRedacted}: ${probe.error && probe.error.message}`;
    if (process.env.DB_TESTS_REQUIRED === '1') { console.log('  FAIL:', msg); console.log('\n0 passed, 1 failed'); process.exit(1); }
    console.log('\n' + '='.repeat(72));
    console.log('SKIPPED: importer tests — ' + msg);
    console.log('='.repeat(72));
    process.exit(0);
  }
  ok(probe.database !== 'veorec', 'tests do NOT run against the development database');

  const reset = () => spawnSync(process.execPath, [path.join(DB_DIR, 'src', 'cli', 'reset.js')],
    { cwd: DB_DIR, env: { ...process.env, APP_ENV: 'test' }, encoding: 'utf8' });
  ok(reset().status === 0, 'clean database prepared');

  const pool = createPool({ env, max: 4, applicationName: 'veorec-import-test' });
  const client = createClient(pool);
  const repos = createRepositories(client);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'veorec-import-'));

  try {
    // ── 1. Empty source ─────────────────────────────────────────────────────
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veorec-empty-'));
    const emptyReport = await runImport({ repos, db: client, dataDir: emptyDir, dryRun: false });
    ok(emptyReport.totals.imported === 0 && emptyReport.totals.failed === 0,
      'an empty source imports nothing and reports no failures');
    ok((await snapshot(client)).users === 0, 'empty source leaves the database empty');

    // ── 2. Dry run performs ZERO writes ─────────────────────────────────────
    const mediaFile = writeFixtures(tmp);
    const before = await snapshot(client);
    const dry = await runImport({ repos, db: client, dataDir: tmp, mediaListingFile: mediaFile, dryRun: true });
    const afterDry = await snapshot(client);
    ok(JSON.stringify(before) === JSON.stringify(afterDry), 'dry run performs zero database writes');
    ok(dry.dryRun === true && dry.entities.users.imported === 2, 'dry run still reports what WOULD be imported');
    ok(dry.entities.recordings.orphan === 1, 'dry run detects the ownerless recording');

    // ── 3–7. Real import: users, ownership, folders, assets/media, relations ─
    const rep = await runImport({ repos, db: client, dataDir: tmp, mediaListingFile: mediaFile, dryRun: false });
    const snap = await snapshot(client);

    ok(snap.users === 2, 'both valid users imported (multiple users)');
    ok(snap.recordings === 2, 'both owned recordings imported (multiple recordings)');
    const alice = await repos.users.findById(idFor('usr', U1));
    ok(alice && alice.email === 'alice@example.com', 'user identity preserved (email lowercased, citext)');
    ok(alice.createdAt.getTime() === 1700000000000, 'legacy created_at timestamp preserved');
    const bob = await repos.users.findById(idFor('usr', U2));
    ok(bob.manualPlan === 'pro' && bob.googleId === 'g-bob', 'entitlement/identity fields preserved');
    const withSecrets = await repos.users.findByEmailWithSecrets('alice@example.com');
    ok(withSecrets.passwordHash === '$2a$10$hashA', 'password hash carried over so users can still sign in');
    ok(withSecrets.resetTokenHash === null, 'legacy plaintext reset tokens are NOT imported');

    const scopeA = { userId: idFor('usr', U1) };
    const scopeB = { userId: idFor('usr', U2) };
    const recA = await repos.recordings.get(scopeA, idFor('rec', R1));
    ok(recA !== null, 'recording ownership preserved (Alice owns her recording)');
    ok(await repos.recordings.get(scopeB, idFor('rec', R1)) === null, 'ownership is not leaked to another user');
    ok(recA.folderId === idFor('fld', F1), 'folder relationship preserved');
    ok(recA.title === 'Alice recording' && recA.privacy === 'public', 'recording metadata preserved');
    ok(Number(recA.duration) === 12.5 && recA.sizeBytes === 4096 && recA.width === 1920,
      'media facts from the legacy listing preserved');
    ok(recA.createdAt.getTime() === new Date('2026-08-01T10:00:00Z').getTime(), 'recording timestamp preserved');
    ok(Number(recA.trimStart) === 1 && Number(recA.recommendedSpeed) === 1.5, 'virtual edits and playback prefs preserved');
    const recB = await repos.recordings.get(scopeB, idFor('rec', R2ID));
    ok(recB.privacy === 'password' && recB.passwordHash === '$2a$10$pw', 'password-protected recording preserved');

    ok(snap.folders === 1, 'only the owned folder is imported (orphan folder quarantined)');
    ok(rep.entities.folders.orphan === 1, 'orphan folder reported, not guessed onto another user');

    ok(snap.comments === 1 && snap.reactions === 3, 'comments and reactions imported (incl. legacy tally form)');
    ok(snap.views === 2, 'unique viewers imported from viewKeys');
    ok((await repos.viewSessions.countUnique(idFor('rec', R1))) === 2, 'unique-view count preserved exactly');
    ok(snap.leads === 1 && snap.transcripts === 1 && snap.segments === 2, 'leads and transcript+segments imported');
    ok(snap.usage === 1 && snap.subscriptions === 1 && snap.contacts === 1, 'usage, subscription and contact imported');
    const usageRow = await repos.usage.get(scopeA);
    ok(usageRow.storageRetainedBytes === 4096 && usageRow.recordingSeconds === 150,
      'usage counters converted correctly (minutes → seconds)');

    // ── 13/14. Legacy media mapping, duplicates and artefacts ───────────────
    ok(snap.mediaMap === 2, 'one legacy media pointer per recording (duplicate listing entry collapses)');
    ok(snap.assets === 0, 'NO video_assets rows are created — media is not in R2 yet');
    const map = await client.execute(sql`SELECT * FROM legacy.media_map WHERE recording_id = ${idFor('rec', R1)}`);
    const mapRow = (map.rows || map)[0];
    ok(mapRow.legacy_provider === 'cloudinary' && mapRow.legacy_public_id === `screenrec/${U1}/${R1}`,
      'legacy Cloudinary identifier recorded for the T-204 backfill');
    ok(mapRow.backfilled_at === null, 'media is flagged as not yet backfilled to R2');
    const artefact = await client.execute(sql`SELECT count(*)::int AS n FROM legacy.media_map WHERE legacy_public_id LIKE '%__trim_%'`);
    ok(Number((artefact.rows || artefact)[0].n) === 0, 'editor trim artefacts are ignored, not imported as recordings');

    // ── 11/12. Orphans and invalid data ─────────────────────────────────────
    ok(rep.entities.recordings.orphan === 1, 'recording known only to meta.json is quarantined as an orphan');
    ok(rep.problems.some((p) => p.kind === 'orphan' && p.key === RORPHAN), 'the orphan is reported with its identifier');
    ok(rep.entities.subscriptions.orphan === 1, 'subscription for an unknown user is quarantined');
    ok((await count(client, 'recordings')) === 2, 'orphaned records are never written with a guessed owner');

    // ── 19. Reconciliation accuracy ─────────────────────────────────────────
    ok(rep.entities.users.source === 2 && rep.entities.users.imported === 2, 'user counts reconcile');
    ok(rep.entities.recordings.source === 3 && rep.entities.recordings.imported === 2 && rep.entities.recordings.orphan === 1,
      'recording counts reconcile (3 seen = 2 imported + 1 orphan)');
    ok(rep.entities.recordings.unmappedMedia === 2, 'both recordings reported as having media still outside R2');
    ok(rep.hasProblems === true, 'a run containing orphans is flagged as needing attention');

    // ── 8/18. Re-running produces no duplicates ─────────────────────────────
    const rep2 = await runImport({ repos, db: client, dataDir: tmp, mediaListingFile: mediaFile, dryRun: false });
    const snap2 = await snapshot(client);
    ok(JSON.stringify(snap) === JSON.stringify(snap2), 're-running the importer creates zero duplicate rows');
    ok(rep2.entities.users.alreadyImported === 2 && rep2.entities.users.imported === 0,
      'the second run reports everything as already imported');
    ok(rep2.entities.analytics_events.alreadyImported === 2,
      'append-only conversion events are checkpointed, not re-appended');

    const rep3 = await runImport({ repos, db: client, dataDir: tmp, mediaListingFile: mediaFile, dryRun: false });
    ok(JSON.stringify(await snapshot(client)) === JSON.stringify(snap), 'a third run is still a no-op (converged)');

    // ── 15. Deterministic mapping ───────────────────────────────────────────
    ok(idFor('rec', R1) === `rec_${R1}`, 'legacy ids map deterministically to new ids');
    ok(derivedId('rct', 'a', 'b') === derivedId('rct', 'a', 'b'), 'derived ids are stable across runs');
    ok(derivedId('rct', 'a', 'b') !== derivedId('rct', 'a', 'c'), 'derived ids distinguish different records');
    ok(parseLegacyPublicId('screenrec/u1/r1').legacyUserId === 'u1', 'ownership is parsed from the legacy public id');

    // ── 9/10. Interrupted import → resume; partial failure ──────────────────
    ok(reset().status === 0, 'database reset for the interruption scenario');
    // Simulate a crash: import users only, then let the full run continue.
    const partialDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veorec-partial-'));
    writeFixtures(partialDir, { includeMedia: false });
    await runImport({ repos, db: client, dataDir: partialDir, dryRun: false });   // no media ⇒ recordings orphaned
    const midway = await snapshot(client);
    ok(midway.users === 2 && midway.recordings === 0, 'interrupted state: users present, recordings not yet importable');
    const resumed = await runImport({ repos, db: client, dataDir: tmp, mediaListingFile: mediaFile, dryRun: false });
    const afterResume = await snapshot(client);
    ok(afterResume.users === 2 && afterResume.recordings === 2,
      'resuming completes the import without starting over or duplicating users');
    ok(resumed.entities.users.alreadyImported === 2 && resumed.entities.recordings.imported === 2,
      'resume reports users as already imported and finishes the remaining work');

    // Partial failure: one invalid record must not abort the rest of the run.
    const invalidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veorec-invalid-'));
    const invalidMedia = writeFixtures(invalidDir, { invalid: true });
    const repInvalid = await runImport({ repos, db: client, dataDir: invalidDir, mediaListingFile: invalidMedia, dryRun: false });
    ok(repInvalid.entities.users.failed === 1, 'an invalid legacy user is reported as failed');
    ok(repInvalid.entities.users.alreadyImported === 2, 'valid users are still processed despite the invalid one');
    ok(repInvalid.hasProblems === true, 'a run with failures is flagged — failures never count as successes');

    // ── 12b. Malformed JSON fails loudly instead of importing nothing ───────
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veorec-bad-'));
    fs.writeFileSync(path.join(badDir, 'users.json'), '{ this is not json');
    let threw = null;
    try { await runImport({ repos, db: client, dataDir: badDir, dryRun: true }); } catch (e) { threw = e; }
    ok(threw && /not valid JSON/.test(threw.message),
      'malformed legacy JSON throws instead of silently importing an empty dataset');

    // ── 20. Legacy sources unchanged ────────────────────────────────────────
    const fpBefore = fingerprintSources(tmp, mediaFile);
    await runImport({ repos, db: client, dataDir: tmp, mediaListingFile: mediaFile, dryRun: false });
    const fpAfter = fingerprintSources(tmp, mediaFile);
    ok(JSON.stringify(fpBefore) === JSON.stringify(fpAfter), 'every legacy source file is byte-identical after an import');

    // ── 17. Rollback: a failing transaction leaves no partial state ─────────
    const { withTransaction } = require(path.join(DB_DIR, 'src', 'index.js'));
    const preTx = await count(client, 'contacts');
    let rolled = false;
    try {
      await withTransaction(async (tx) => {
        await tx.db.execute(sql`INSERT INTO contacts (id, name, email, message) VALUES ('ctc_rollback','X','x@y.z','m')`);
        throw new Error('simulated failure mid-import');
      }, client);
    } catch { rolled = true; }
    ok(rolled && (await count(client, 'contacts')) === preTx, 'a failure inside a transaction rolls back cleanly');

    // ── Run bookkeeping ─────────────────────────────────────────────────────
    const runs = await client.execute(sql`SELECT count(*)::int AS n FROM legacy.import_runs WHERE dry_run = false`);
    ok(Number((runs.rows || runs)[0].n) >= 1, 'each applied run is recorded in legacy.import_runs');
    const audits = await repos.audit.listAsAdmin({ action: 'legacy.import' }, 'test');
    ok(audits.length >= 1, 'the import writes an audit entry');
  } finally {
    await pool.end().catch(() => {});
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('test harness error:', e); process.exit(1); });
