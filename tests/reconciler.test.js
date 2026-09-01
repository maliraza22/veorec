// T-106 reconciliation safety-net tests (run: cd db && npm run test:reconcile)
//
// Every detection class is exercised against real PostgreSQL with a fixture
// legacy directory, plus the safety properties that matter most:
//   • report mode performs ZERO writes,
//   • repair is additive and idempotent,
//   • NOTHING is ever hard-deleted from PostgreSQL,
//   • stale rows (unmirrored deletes) are never repaired without an explicit
//     opt-in, and even then only soft-deleted,
//   • delete detection is SKIPPED rather than guessed when the legacy side
//     cannot be enumerated (which would otherwise flag live data as stale).
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DB_DIR = path.join(__dirname, '..', 'db');

const { loadEnv, createPool, checkConnection, createClient } = require(path.join(DB_DIR, 'src', 'index.js'));
const { reconcile } = require(path.join(DB_DIR, 'src', 'migration', 'reconciler.js'));
const { runImport } = require(path.join(DB_DIR, 'src', 'migration', 'importer.js'));
const { createRepositories } = require(path.join(DB_DIR, 'src', 'repositories'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const R1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const R2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const F1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** Write a coherent legacy fixture; `mutate` lets a test diverge one side. */
function writeLegacy(dir, mutate = () => {}) {
  const data = {
    users: [
      { id: U1, name: 'Alice', email: 'alice@example.com', password: '$2a$10$hashA', created_at: 1700000000000 },
      { id: U2, name: 'Bob', email: 'bob@example.com', password: '$2a$10$hashB', created_at: 1700000100000 },
    ],
    folders: [{ id: F1, userId: U1, name: 'Demos', created_at: 1700000200000 }],
    meta: {
      [R1]: { title: 'Alice recording', description: 'desc', privacy: 'public', folder: F1, archived: false },
      [R2]: { title: 'Bob recording', privacy: 'public' },
    },
    subscriptions: { [U2]: { id: 'sub-1', userId: U2, planSlug: 'pro', status: 'active', billingCycle: 'monthly' } },
    usage: { [U1]: { userId: U1, storageUsedBytes: 4096, videoCount: 1, recordingMinutesUsed: 2 } },
    contacts: {},
    notifReads: {},
    planOverrides: {},
    upgradeEvents: [],
    media: [
      { public_id: `screenrec/${U1}/${R1}`, secure_url: 'https://x/a.webm', bytes: 4096, duration: 12.5,
        format: 'webm', context: { rec_id: R1, user_id: U1, title: 'Alice recording' } },
      { public_id: `screenrec/${U2}/${R2}`, secure_url: 'https://x/b.webm', bytes: 8192, duration: 30,
        format: 'webm', context: { rec_id: R2, user_id: U2, title: 'Bob recording' } },
    ],
  };
  mutate(data);
  const w = (n, v) => fs.writeFileSync(path.join(dir, n), JSON.stringify(v, null, 2));
  w('users.json', data.users); w('folders.json', data.folders); w('meta.json', data.meta);
  w('subscriptions.json', data.subscriptions); w('usage.json', data.usage); w('contacts.json', data.contacts);
  w('notif-reads.json', data.notifReads); w('plan_overrides.json', data.planOverrides);
  w('upgrade_events.json', data.upgradeEvents); w('recordings.json', []);
  const mediaFile = path.join(dir, 'media.json');
  fs.writeFileSync(mediaFile, JSON.stringify({ resources: data.media }, null, 2));
  return mediaFile;
}

const fixture = (mutate) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veorec-rec-'));
  return { dir, media: writeLegacy(dir, mutate) };
};
const rows = (r) => (r && r.rows) ? r.rows : r;
const snapshot = async (db) => rows(await db.execute(sql`
  SELECT (SELECT count(*)::int FROM users) u, (SELECT count(*)::int FROM recordings) r,
         (SELECT count(*)::int FROM folders) f, (SELECT count(*)::int FROM subscriptions) s,
         (SELECT count(*)::int FROM recordings WHERE deleted_at IS NOT NULL) d`))[0];
const checks = (rep) => rep.byCheck;

async function main() {
  const env = loadEnv({ appEnv: 'test' });
  const probe = await checkConnection(createPool({ env, max: 1 }));
  if (!probe.ok) {
    const msg = `database unreachable at ${env.databaseUrlRedacted}: ${probe.error && probe.error.message}`;
    if (process.env.DB_TESTS_REQUIRED === '1') { console.log('  FAIL:', msg); console.log('\n0 passed, 1 failed'); process.exit(1); }
    console.log('\n' + '='.repeat(72));
    console.log('SKIPPED: reconciler tests — ' + msg);
    console.log('='.repeat(72));
    process.exit(0);
  }
  ok(probe.database !== 'veorec', 'tests do NOT run against the development database');

  const resetDb = () => spawnSync(process.execPath, [path.join(DB_DIR, 'src', 'cli', 'reset.js')],
    { cwd: DB_DIR, env: { ...process.env, APP_ENV: 'test' }, encoding: 'utf8' });
  const pool = createPool({ env, max: 4, applicationName: 'veorec-reconcile-test' });
  const db = createClient(pool);
  const repos = createRepositories(db);

  try {
    // ── 1. Converged system reports clean ───────────────────────────────────
    ok(resetDb().status === 0, 'clean database prepared');
    const base = fixture();
    await runImport({ repos, db, dataDir: base.dir, mediaListingFile: base.media, dryRun: false });
    let rep = await reconcile({ db, dataDir: base.dir, mediaListingFile: base.media });
    ok(rep.clean, `a fully imported system reconciles clean (findings: ${JSON.stringify(rep.byCheck)})`);
    ok(rep.mode === 'report', 'report is the default mode');
    ok(rep.counts.users.legacy === 2 && rep.counts.users.postgres === 2, 'counts are reported per entity and side');
    ok(rep.counts.recordings.legacy === 2 && rep.counts.recordings.postgres === 2, 'recording counts match');

    // ── 2. Report mode performs ZERO writes ─────────────────────────────────
    const before = await snapshot(db);
    await db.execute(sql`DELETE FROM folders`);                 // introduce divergence
    const afterDelete = await snapshot(db);
    const repMissing = await reconcile({ db, dataDir: base.dir, mediaListingFile: base.media });
    const afterReport = await snapshot(db);
    ok(JSON.stringify(afterDelete) === JSON.stringify(afterReport), 'report mode writes nothing to PostgreSQL');
    ok(checks(repMissing).legacy_missing_in_pg >= 1, 'legacy record missing in PostgreSQL is detected');
    ok(repMissing.findings.some((f) => f.entity === 'folders' && f.repairable),
      'the missing folder is flagged as automatically repairable');

    // ── 3. Repair mode restores it (additive, idempotent) ───────────────────
    const repaired = await reconcile({ db, dataDir: base.dir, mediaListingFile: base.media, mode: 'repair' });
    ok(repaired.repairs.length >= 1, 'repair mode applies the missing-row repair');
    const afterRepair = await snapshot(db);
    ok(afterRepair.f === before.f, 'the folder is restored to its original state');
    const rerun = await reconcile({ db, dataDir: base.dir, mediaListingFile: base.media, mode: 'repair' });
    ok(rerun.clean && rerun.repairs.length === 0, 'a second repair run is a no-op (idempotent, converged)');

    // ── 4. Field drift ──────────────────────────────────────────────────────
    await db.execute(sql`UPDATE recordings SET title = 'TAMPERED', privacy = 'login' WHERE id = ${'rec_' + R1}`);
    await db.execute(sql`UPDATE users SET name = 'Wrong Name' WHERE id = ${'usr_' + U1}`);
    const drift = await reconcile({ db, dataDir: base.dir, mediaListingFile: base.media });
    ok(checks(drift).field_drift >= 2, 'field drift is detected on both users and recordings');
    ok(drift.findings.some((f) => f.entity === 'recordings' && /title/.test(f.detail)), 'the drifted column is named');
    await reconcile({ db, dataDir: base.dir, mediaListingFile: base.media, mode: 'repair' });
    const fixedRow = rows(await db.execute(sql`SELECT title, privacy FROM recordings WHERE id = ${'rec_' + R1}`))[0];
    ok(fixedRow.title === 'Alice recording' && fixedRow.privacy === 'public', 'repair restores drifted fields');

    // ── 5. Entitlement drift is critical ────────────────────────────────────
    await db.execute(sql`UPDATE subscriptions SET status = 'canceled' WHERE user_id = ${'usr_' + U2}`);
    const subDrift = await reconcile({ db, dataDir: base.dir, mediaListingFile: base.media });
    ok(subDrift.findings.some((f) => f.entity === 'subscriptions' && f.severity === 'critical'),
      'subscription/entitlement drift is reported as critical');
    await reconcile({ db, dataDir: base.dir, mediaListingFile: base.media, mode: 'repair' });

    // ── 6. UNMIRRORED DELETE: legacy removed a recording, PostgreSQL kept it ──
    const deleted = fixture((d) => {
      delete d.meta[R2];                                   // legacy delete removes meta…
      d.media = d.media.filter((m) => !m.public_id.endsWith(R2));   // …and the media
    });
    const staleRep = await reconcile({ db, dataDir: deleted.dir, mediaListingFile: deleted.media });
    ok(checks(staleRep).stale_in_pg >= 1, 'a recording deleted in legacy but present in PostgreSQL is detected');
    const staleFinding = staleRep.findings.find((f) => f.check === 'stale_in_pg' && f.entity === 'recordings');
    ok(staleFinding && staleFinding.severity === 'critical', 'the unmirrored delete is critical');
    ok(staleFinding && /UNMIRRORED DELETE/.test(staleFinding.detail), 'it is labelled as an unmirrored delete');
    ok(staleFinding && staleFinding.repairable === false, 'a stale row is NEVER marked automatically repairable');

    // Plain repair must not touch it.
    const staleRepair = await reconcile({ db, dataDir: deleted.dir, mediaListingFile: deleted.media, mode: 'repair' });
    const afterStaleRepair = await snapshot(db);
    ok(afterStaleRepair.r === 2 && afterStaleRepair.d === 0,
      'repair mode does NOT delete or soft-delete the stale recording');
    ok(!staleRepair.repairs.some((r) => r.action === 'soft_delete'), 'no soft-delete happens without the explicit opt-in');

    // Explicit opt-in soft-deletes only (reversible), never hard-deletes.
    await reconcile({ db, dataDir: deleted.dir, mediaListingFile: deleted.media, mode: 'repair', allowStaleSoftDelete: true });
    const afterOptIn = await snapshot(db);
    ok(afterOptIn.r === 2, 'the row still EXISTS after the opt-in — nothing is hard-deleted');
    ok(afterOptIn.d === 1, 'the stale recording is soft-deleted (reversible) under the explicit opt-in');
    const revived = await reconcile({ db, dataDir: deleted.dir, mediaListingFile: deleted.media });
    ok(!revived.findings.some((f) => f.check === 'stale_in_pg' && f.pgId === 'rec_' + R2),
      'once soft-deleted, the row no longer reports as stale (converged)');

    // ── 7. Delete detection is SKIPPED, not guessed, without a listing ───────
    const noListing = await reconcile({ db, dataDir: deleted.dir, mediaListingFile: null });
    ok(noListing.skippedChecks.some((s) => /stale_in_pg/.test(s.check)),
      'without a media listing, delete detection is skipped rather than flagging live data');
    ok(!noListing.findings.some((f) => f.check === 'stale_in_pg' && f.entity === 'recordings'),
      'no recording is falsely reported as deleted when the legacy side cannot be enumerated');

    // ── 8. Orphaned child records ───────────────────────────────────────────
    ok(resetDb().status === 0, 'database reset for the orphan scenario');
    const orphanFx = fixture();
    await runImport({ repos, db, dataDir: orphanFx.dir, mediaListingFile: orphanFx.media, dryRun: false });
    await db.execute(sql`INSERT INTO comments (id, recording_id, author_name, body)
                         VALUES ('cmt_orphan', ${'rec_' + R1}, 'V', 'hi')`);
    await db.execute(sql`ALTER TABLE comments DROP CONSTRAINT comments_recording_id_recordings_id_fk`);
    await db.execute(sql`UPDATE comments SET recording_id = 'rec_ghost' WHERE id = 'cmt_orphan'`);
    const orphanRep = await reconcile({ db, dataDir: orphanFx.dir, mediaListingFile: orphanFx.media });
    ok(checks(orphanRep).orphaned_child >= 1, 'a child row whose parent is missing is detected');
    ok(orphanRep.findings.some((f) => f.check === 'orphaned_child' && f.entity === 'comments' && f.severity === 'critical'),
      'orphaned children are critical and name the entity');
    await db.execute(sql`DELETE FROM comments WHERE id = 'cmt_orphan'`);
    await db.execute(sql`ALTER TABLE comments ADD CONSTRAINT comments_recording_id_recordings_id_fk
                         FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE`);

    // ── 9. Mapping inconsistencies ──────────────────────────────────────────
    await db.execute(sql`UPDATE recordings SET user_id = ${'usr_' + U2} WHERE id = ${'rec_' + R1}`);
    const ownerRep = await reconcile({ db, dataDir: orphanFx.dir, mediaListingFile: orphanFx.media });
    ok(checks(ownerRep).mapping_inconsistency >= 1, 'ownership that disagrees with legacy is detected');
    const own = ownerRep.findings.find((f) => f.check === 'mapping_inconsistency');
    ok(own.severity === 'critical' && own.repairable === false,
      'an ownership mismatch is critical and never auto-repaired (data could belong to another user)');
    const beforeOwnerRepair = rows(await db.execute(sql`SELECT user_id FROM recordings WHERE id = ${'rec_' + R1}`))[0];
    await reconcile({ db, dataDir: orphanFx.dir, mediaListingFile: orphanFx.media, mode: 'repair' });
    const afterOwnerRepair = rows(await db.execute(sql`SELECT user_id FROM recordings WHERE id = ${'rec_' + R1}`))[0];
    ok(beforeOwnerRepair.user_id === afterOwnerRepair.user_id,
      'repair leaves an ownership mismatch untouched for a human to resolve');
    await db.execute(sql`UPDATE recordings SET user_id = ${'usr_' + U1} WHERE id = ${'rec_' + R1}`);

    // Non-derivable id.
    await db.execute(sql`INSERT INTO users (id, email, name) VALUES ('weird-id', 'weird@example.com', 'W')`);
    const idRep = await reconcile({ db, dataDir: orphanFx.dir, mediaListingFile: orphanFx.media });
    ok(idRep.findings.some((f) => f.check === 'mapping_inconsistency' && f.pgId === 'weird-id'),
      'an id that does not follow the deterministic mapping is detected');
    await db.execute(sql`DELETE FROM users WHERE id = 'weird-id'`);

    // ── 10. Unsafe: ambiguous identity is never auto-resolved ───────────────
    const dupFx = fixture((d) => { d.users[1].email = 'alice@example.com'; });   // two users, one email
    const dupRep = await reconcile({ db, dataDir: dupFx.dir, mediaListingFile: dupFx.media });
    ok(dupRep.findings.some((f) => f.check === 'unsafe' || f.check === 'field_drift'),
      'a duplicate legacy email surfaces as a finding rather than being merged');
    const dupRepair = await reconcile({ db, dataDir: dupFx.dir, mediaListingFile: dupFx.media, mode: 'repair' });
    ok(dupRepair.findings.some((f) => f.check === 'repair_failed' || f.check === 'unsafe' || f.check === 'field_drift'),
      'repair reports rather than silently corrupting ambiguous identity');
    const usersStill = rows(await db.execute(sql`SELECT count(*)::int AS n FROM users WHERE deleted_at IS NULL`))[0];
    ok(Number(usersStill.n) >= 2, 'no user row is destroyed while resolving ambiguity');

    // ── 11. Outstanding dual-write journal entries ──────────────────────────
    ok(resetDb().status === 0, 'database reset for the journal scenario');
    const jFx = fixture();
    fs.writeFileSync(path.join(jFx.dir, 'dual-write-failures.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), op: 'user.upsert', entity: 'users', legacyId: U1, retryable: true }) + '\n');
    const jRep = await reconcile({ db, dataDir: jFx.dir, mediaListingFile: jFx.media });
    ok(jRep.findings.some((f) => f.check === 'failed_dual_write'),
      'journalled dual-write failures that are still missing are reported');
    await runImport({ repos, db, dataDir: jFx.dir, mediaListingFile: jFx.media, dryRun: false });
    const jRep2 = await reconcile({ db, dataDir: jFx.dir, mediaListingFile: jFx.media });
    ok(!jRep2.findings.some((f) => f.check === 'failed_dual_write'),
      'once the record exists, the journal entry no longer counts as outstanding');

    // ── 12. CLI contract: default report, exit codes, no writes ─────────────
    const cli = (args) => spawnSync(process.execPath, [path.join(DB_DIR, 'src', 'cli', 'reconcile.js'), ...args],
      { cwd: DB_DIR, env: { ...process.env, APP_ENV: 'test' }, encoding: 'utf8' });
    const cleanRun = cli([`--data-dir=${jFx.dir}`, `--media-listing=${jFx.media}`, '--json']);
    ok(cleanRun.status === 0, 'CLI exits 0 when convergent');
    ok(/REPORT mode/.test(cleanRun.stdout), 'CLI announces report mode by default');
    await db.execute(sql`DELETE FROM folders`);
    const dirtyRun = cli([`--data-dir=${jFx.dir}`, `--media-listing=${jFx.media}`]);
    ok(dirtyRun.status === 2, 'CLI exits 2 when findings exist (nightly alert signal)');
    ok(/human decision|repaired automatically/.test(dirtyRun.stdout), 'CLI explains what needs a human');
    const guard = cli([`--data-dir=${jFx.dir}`, '--allow-stale-soft-delete']);
    ok(guard.status === 1 && /requires --repair/.test(guard.stderr + guard.stdout),
      'the soft-delete opt-in is refused outside repair mode');
  } finally {
    await pool.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('test harness error:', e); process.exit(1); });
