// T-102 application-schema tests (run: cd db && npm run test:schema)
//
//  1. Schema parity   — every Drizzle-declared table/column exists in Postgres
//                       (the "schema snapshot" acceptance test).
//  2. ER parity       — introspected foreign keys match docs/07 §12.
//  3. Provider neutrality — no storage-provider (Cloudinary) leakage anywhere.
//  4. Constraints     — FK, UNIQUE, CHECK, NOT NULL behave as designed.
//  5. Deletion        — cascade / set-null behaviour per docs/07 §11.
//  6. Triggers        — updated_at maintained by the database.
//
// Runs against APP_ENV=test → DATABASE_URL_TEST, and RESETS that database.
// Skips loudly when no database is reachable; DB_TESTS_REQUIRED=1 enforces.
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const DB_DIR = path.join(__dirname, '..', 'db');

const { loadEnv } = require(path.join(DB_DIR, 'src', 'env.js'));
const { createPool, checkConnection } = require(path.join(DB_DIR, 'src', 'pool.js'));
const schema = require(path.join(DB_DIR, 'src', 'schema'));
const { getTableName, getTableColumns } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Expected FK graph — transcribed from the docs/07 §12 ER diagram.
// [child table, column, parent table]
const EXPECTED_FKS = [
  ['sessions', 'user_id', 'users'],
  ['workspaces', 'owner_user_id', 'users'],
  ['workspace_members', 'workspace_id', 'workspaces'],
  ['workspace_members', 'user_id', 'users'],
  ['workspace_members', 'invited_by', 'users'],
  ['folders', 'user_id', 'users'],
  ['recordings', 'user_id', 'users'],
  ['recordings', 'workspace_id', 'workspaces'],
  ['recordings', 'folder_id', 'folders'],
  ['video_assets', 'recording_id', 'recordings'],
  ['video_assets', 'created_by_job_id', 'processing_jobs'],
  ['processing_jobs', 'recording_id', 'recordings'],
  ['upload_sessions', 'recording_id', 'recordings'],
  ['upload_sessions', 'user_id', 'users'],
  ['upload_parts', 'upload_session_id', 'upload_sessions'],
  ['storage_reservations', 'user_id', 'users'],
  ['storage_reservations', 'upload_session_id', 'upload_sessions'],
  ['storage_reservations', 'render_job_id', 'render_jobs'],
  ['share_links', 'recording_id', 'recordings'],
  ['share_links', 'created_by', 'users'],
  ['comments', 'recording_id', 'recordings'],
  ['comments', 'parent_id', 'comments'],
  ['comments', 'user_id', 'users'],
  ['reactions', 'recording_id', 'recordings'],
  ['reactions', 'user_id', 'users'],
  ['view_sessions', 'recording_id', 'recordings'],
  ['view_sessions', 'viewer_user_id', 'users'],
  ['analytics_events', 'recording_id', 'recordings'],
  ['analytics_events', 'user_id', 'users'],
  ['leads', 'recording_id', 'recordings'],
  ['transcripts', 'recording_id', 'recordings'],
  ['transcript_segments', 'transcript_id', 'transcripts'],
  ['transcript_translations', 'transcript_id', 'transcripts'],
  ['edit_sessions', 'recording_id', 'recordings'],
  ['edit_sessions', 'user_id', 'users'],
  ['edit_operations', 'edit_session_id', 'edit_sessions'],
  ['render_jobs', 'edit_session_id', 'edit_sessions'],
  ['render_jobs', 'processing_job_id', 'processing_jobs'],
  ['render_jobs', 'output_recording_id', 'recordings'],
  ['render_jobs', 'output_asset_id', 'video_assets'],
  ['subscriptions', 'user_id', 'users'],
  ['billing_events', 'user_id', 'users'],
  ['usage', 'user_id', 'users'],
  ['plan_overrides', 'updated_by', 'users'],
  ['contacts', 'user_id', 'users'],
  ['notification_reads', 'user_id', 'users'],
  ['audit_logs', 'actor_user_id', 'users'],
];

async function main() {
  const env = loadEnv({ appEnv: 'test' });
  const probe = await checkConnection(createPool({ env, max: 1 }));
  if (!probe.ok) {
    const msg = `database unreachable at ${env.databaseUrlRedacted}: ${probe.error && probe.error.message}`;
    if (process.env.DB_TESTS_REQUIRED === '1') { console.log('  FAIL:', msg); console.log('\n0 passed, 1 failed'); process.exit(1); }
    console.log('\n' + '='.repeat(72));
    console.log('SKIPPED: schema tests — ' + msg);
    console.log('Start infrastructure with:  docker compose up -d postgres');
    console.log('='.repeat(72));
    process.exit(0);
  }
  ok(probe.database !== 'veorec', 'tests do NOT run against the development database');

  // Clean database → apply 0000 + 0001 from scratch.
  const reset = spawnSync(process.execPath, [path.join(DB_DIR, 'src', 'cli', 'reset.js')], {
    cwd: DB_DIR, env: { ...process.env, APP_ENV: 'test' }, encoding: 'utf8',
  });
  ok(reset.status === 0, `clean-database migration succeeds\n${reset.stderr || ''}`);
  // Count-agnostic: the journal grows with every future migration.
  const { readJournal } = require(path.join(DB_DIR, 'src', 'migration-state.js'));
  const journalCount = readJournal(path.join(DB_DIR, 'migrations')).length;
  ok(new RegExp(`applied ${journalCount} migration`).test(reset.stdout || ''),
    `all ${journalCount} migrations applied from scratch`);

  const pool = createPool({ env, max: 3, applicationName: 'veorec-schema-test' });
  try {
    // ── 1. Schema parity ────────────────────────────────────────────────────
    const declared = Object.values(schema);
    const { rows: dbTables } = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"
    );
    const dbTableSet = new Set(dbTables.map((r) => r.table_name));
    ok(declared.length === 30, `30 tables declared in the Drizzle schema (got ${declared.length})`);
    ok(dbTableSet.size === 30, `30 tables exist in Postgres (got ${dbTableSet.size})`);

    const { rows: dbCols } = await pool.query(
      "SELECT table_name, column_name, is_nullable, data_type FROM information_schema.columns WHERE table_schema='public'"
    );
    const colsByTable = new Map();
    for (const r of dbCols) {
      if (!colsByTable.has(r.table_name)) colsByTable.set(r.table_name, new Map());
      colsByTable.get(r.table_name).set(r.column_name, r);
    }

    let missingTables = [], missingCols = [];
    for (const table of declared) {
      const name = getTableName(table);
      if (!dbTableSet.has(name)) { missingTables.push(name); continue; }
      const dbSet = colsByTable.get(name) || new Map();
      for (const col of Object.values(getTableColumns(table))) {
        if (!dbSet.has(col.name)) missingCols.push(`${name}.${col.name}`);
      }
    }
    ok(missingTables.length === 0, `every declared table exists (missing: ${missingTables.join(', ')})`);
    ok(missingCols.length === 0, `every declared column exists (missing: ${missingCols.join(', ')})`);

    // Spot-check the quota ledger, the heart of docs/16 §4.
    const usageCols = colsByTable.get('usage');
    for (const c of ['storage_retained_bytes', 'storage_reserved_bytes', 'storage_pending_deletion_bytes',
      'active_video_count', 'reserved_video_slots']) {
      ok(usageCols && usageCols.has(c), `usage.${c} exists (quota ledger)`);
    }
    ok(colsByTable.get('video_assets').has('counts_toward_quota'),
      'video_assets.counts_toward_quota exists (derived assets never bill the user)');
    ok(colsByTable.get('upload_sessions').has('byte_ceiling'),
      'upload_sessions.byte_ceiling exists (per-recording hard cap)');

    // ── 2. ER parity (docs/07 §12) ──────────────────────────────────────────
    const { rows: fkRows } = await pool.query(`
      SELECT tc.table_name AS child, kcu.column_name AS col, ccu.table_name AS parent, rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`);
    const fkSet = new Set(fkRows.map((r) => `${r.child}.${r.col}->${r.parent}`));
    const missingFks = EXPECTED_FKS.filter(([c, col, p]) => !fkSet.has(`${c}.${col}->${p}`));
    ok(missingFks.length === 0,
      `all ${EXPECTED_FKS.length} documented relationships exist (missing: ${missingFks.map((f) => f.join('.')).join(', ')})`);

    const deleteRule = (child, col) => (fkRows.find((r) => r.child === child && r.col === col) || {}).delete_rule;
    ok(deleteRule('video_assets', 'recording_id') === 'CASCADE', 'video_assets cascade from recordings');
    ok(deleteRule('upload_parts', 'upload_session_id') === 'CASCADE', 'upload_parts cascade from upload_sessions');
    ok(deleteRule('recordings', 'folder_id') === 'SET NULL', 'deleting a folder nulls recordings.folder_id (docs/07 §11)');
    ok(deleteRule('comments', 'user_id') === 'SET NULL', 'deleting a user anonymises comments rather than deleting them');
    ok(deleteRule('audit_logs', 'actor_user_id') === 'SET NULL', 'audit trail survives actor deletion');

    // ── 3. Provider neutrality ──────────────────────────────────────────────
    const leaked = dbCols.filter((r) => /cloudinary|public_id|secure_url/i.test(r.column_name));
    ok(leaked.length === 0,
      `no storage-provider columns in the schema (found: ${leaked.map((r) => r.table_name + '.' + r.column_name).join(', ')})`);
    ok(colsByTable.get('video_assets').has('storage_key'),
      'media is addressed by the provider-neutral video_assets.storage_key');

    // ── 4/5. Behaviour: constraints and deletion ────────────────────────────
    const U = 'usr_t102', W = 'ws_t102', F = 'fld_t102', R = 'rec_t102';
    await pool.query(`INSERT INTO users (id,email,name) VALUES ('${U}','Owner@Example.com','Owner')`);
    await pool.query(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ('${W}','WS','${U}')`);
    await pool.query(`INSERT INTO folders (id,user_id,name) VALUES ('${F}','${U}','Demos')`);
    await pool.query(`INSERT INTO recordings (id,user_id,workspace_id,folder_id,source_kind) VALUES ('${R}','${U}','${W}','${F}','extension')`);
    await pool.query(`INSERT INTO usage (user_id) VALUES ('${U}')`);

    const reject = async (sql, label, code) => {
      try { await pool.query(sql); ok(false, `${label} (expected rejection, none occurred)`); }
      catch (e) { ok(!code || e.code === code, `${label} (rejected ${e.code})`); }
    };

    // UNIQUE / citext
    await reject(`INSERT INTO users (id,email,name) VALUES ('usr_dup','owner@example.com','Dup')`,
      'user email is case-insensitively unique', '23505');
    // Soft-deleted users free their email (partial unique index)
    await pool.query(`UPDATE users SET deleted_at = now() WHERE id='${U}'`);
    await pool.query(`INSERT INTO users (id,email,name) VALUES ('usr_reuse','owner@example.com','Reuse')`);
    ok(true, 'a soft-deleted account frees its email for re-registration');
    await pool.query(`DELETE FROM users WHERE id='usr_reuse'`);
    await pool.query(`UPDATE users SET deleted_at = NULL WHERE id='${U}'`);

    // CHECK constraints
    await reject(`INSERT INTO recordings (id,user_id,source_kind,status) VALUES ('rec_bad','${U}','extension','bogus')`,
      'recordings.status CHECK rejects an unknown lifecycle value', '23514');
    await reject(`INSERT INTO recordings (id,user_id,source_kind,privacy) VALUES ('rec_bad2','${U}','extension','password')`,
      'password-protected recording requires a password hash', '23514');
    await reject(`UPDATE usage SET storage_retained_bytes = -1 WHERE user_id='${U}'`,
      'quota ledger cannot go negative (retained bytes)', '23514');
    await reject(`UPDATE usage SET active_video_count = -1 WHERE user_id='${U}'`,
      'quota ledger cannot go negative (video count)', '23514');
    await reject(`INSERT INTO view_sessions (id,recording_id,viewer_key,max_progress) VALUES ('vs_bad','${R}','v:x',1.5)`,
      'view progress is constrained to 0..1', '23514');
    await reject(`INSERT INTO comments (id,recording_id,author_name,body) VALUES ('cmt_bad','${R}','A','')`,
      'empty comment body rejected', '23514');
    // FK + NOT NULL
    await reject(`INSERT INTO recordings (id,user_id,source_kind) VALUES ('rec_orphan','usr_missing','extension')`,
      'recording requires an existing owner', '23503');
    await reject(`INSERT INTO recordings (id,user_id) VALUES ('rec_nosrc','${U}')`,
      'recordings.source_kind is NOT NULL', '23502');

    // Upload session + reservation invariants
    await pool.query(`INSERT INTO upload_sessions (id,recording_id,user_id,storage_key,part_size,byte_ceiling,idempotency_key,expires_at)
                      VALUES ('up_t102','${R}','${U}','sources/${R}/source.webm',8388608,536870912,'idem-1', now() + interval '48 hours')`);
    await reject(`INSERT INTO upload_sessions (id,recording_id,user_id,storage_key,part_size,byte_ceiling,idempotency_key,expires_at)
                  VALUES ('up_t102b','${R}','${U}','sources/x',8388608,536870912,'idem-2', now())`,
      'only one active upload session per recording', '23505');
    await reject(`INSERT INTO upload_sessions (id,recording_id,user_id,storage_key,part_size,byte_ceiling,idempotency_key,expires_at)
                  VALUES ('up_t102c','${R}','${U}','sources/y',8388608,536870912,'idem-1', now())`,
      'idempotency key prevents duplicate sessions per user', '23505');
    // Part numbering follows the S3 multipart contract (1..10000).
    await pool.query(`INSERT INTO upload_parts (upload_session_id,part_number,size,status) VALUES ('up_t102',1,8388608,'uploaded')`);
    await reject(`INSERT INTO upload_parts (upload_session_id,part_number,size) VALUES ('up_t102',0,1)`,
      'part number 0 rejected (S3 parts start at 1)', '23514');
    await reject(`INSERT INTO upload_parts (upload_session_id,part_number,size) VALUES ('up_t102',10001,1)`,
      'part number above 10000 rejected (S3 limit)', '23514');
    await reject(`INSERT INTO upload_parts (upload_session_id,part_number,size) VALUES ('up_t102',1,8388608)`,
      'duplicate part number rejected (composite PK)', '23505');

    await pool.query(`INSERT INTO storage_reservations (id,user_id,upload_session_id,reserved_bytes,expires_at)
                      VALUES ('rsv_t102','${U}','up_t102',536870912, now() + interval '48 hours')`);
    await reject(`INSERT INTO storage_reservations (id,user_id,upload_session_id,reserved_bytes,expires_at)
                  VALUES ('rsv_dup','${U}','up_t102',1, now())`,
      'exactly one open reservation per upload session', '23505');
    await reject(`INSERT INTO storage_reservations (id,user_id,reserved_bytes,expires_at)
                  VALUES ('rsv_none','${U}',1, now())`,
      'a reservation must belong to an upload or a render', '23514');

    // One READY asset per (recording, kind, variant)
    await pool.query(`INSERT INTO video_assets (id,recording_id,kind,storage_key,status,immutable,counts_toward_quota)
                      VALUES ('ast_src','${R}','source','sources/${R}/source.webm','ready',true,true)`);
    await reject(`INSERT INTO video_assets (id,recording_id,kind,storage_key,status) VALUES ('ast_src2','${R}','source','sources/other','ready')`,
      'only one ready asset per (recording, kind, variant)', '23505');
    await pool.query(`INSERT INTO video_assets (id,recording_id,kind,storage_key,status) VALUES ('ast_mp4','${R}','mp4','derived/${R}/video.mp4','ready')`);
    ok(true, 'a derived mp4 asset coexists with the immutable source');

    // updated_at trigger
    const t1 = (await pool.query(`SELECT updated_at FROM recordings WHERE id='${R}'`)).rows[0].updated_at;
    await sleep(10);
    await pool.query(`UPDATE recordings SET title='Renamed' WHERE id='${R}'`);
    const t2 = (await pool.query(`SELECT updated_at FROM recordings WHERE id='${R}'`)).rows[0].updated_at;
    ok(new Date(t2) > new Date(t1), 'updated_at is maintained by the database trigger');

    // Deletion behaviour (docs/07 §11)
    await pool.query(`DELETE FROM folders WHERE id='${F}'`);
    ok((await pool.query(`SELECT folder_id FROM recordings WHERE id='${R}'`)).rows[0].folder_id === null,
      'deleting a folder nulls the recording reference instead of deleting the recording');

    await pool.query(`INSERT INTO comments (id,recording_id,author_name,body) VALUES ('cmt_root','${R}','A','root')`);
    await pool.query(`INSERT INTO comments (id,recording_id,parent_id,author_name,body) VALUES ('cmt_reply','${R}','cmt_root','B','reply')`);
    await pool.query(`DELETE FROM comments WHERE id='cmt_root'`);
    ok((await pool.query(`SELECT 1 FROM comments WHERE id='cmt_reply'`)).rowCount === 0, 'deleting a comment cascades its replies');

    await pool.query(`DELETE FROM recordings WHERE id='${R}'`);
    const after = await pool.query(`SELECT
      (SELECT count(*)::int FROM video_assets WHERE recording_id='${R}') AS assets,
      (SELECT count(*)::int FROM upload_sessions WHERE recording_id='${R}') AS sessions,
      (SELECT count(*)::int FROM storage_reservations WHERE id='rsv_t102') AS reservations`);
    ok(after.rows[0].assets === 0 && after.rows[0].sessions === 0 && after.rows[0].reservations === 0,
      'hard-deleting a recording cascades assets, upload sessions and reservations');

    await pool.query(`DELETE FROM users WHERE id='${U}'`);
    ok((await pool.query(`SELECT count(*)::int AS n FROM usage WHERE user_id='${U}'`)).rows[0].n === 0,
      'purging a user cascades their quota ledger row');
  } finally {
    await pool.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('test harness error:', e); process.exit(1); });
