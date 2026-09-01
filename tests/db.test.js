// T-101 database foundation tests (run: cd db && npm test)
//
// Part A — environment/safety guards: pure unit tests, no database needed.
// Part B — live database: connectivity, migration runner against a CLEAN
//          database, idempotency, reset/re-migrate repeatability, and that the
//          foundation supports the docs/07 constraint conventions.
//
// Part B runs against APP_ENV=test → DATABASE_URL_TEST (a SEPARATE database
// whose schema is dropped on every run — never the development database).
// If no database is reachable it SKIPS loudly (exit 0) so the repo suite stays
// runnable on machines without infrastructure; set DB_TESTS_REQUIRED=1 (CI) to
// turn an unreachable database into a failure instead.
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const DB_DIR = path.join(__dirname, '..', 'db');
// Only require modules from db/src — they resolve pg/drizzle from db/node_modules.
const { loadEnv, assertDestructiveAllowed, redactUrl, EnvError } = require(path.join(DB_DIR, 'src', 'env.js'));
const { createPool, checkConnection } = require(path.join(DB_DIR, 'src', 'pool.js'));
const { migrationState, readJournal } = require(path.join(DB_DIR, 'src', 'migration-state.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEST_ENV = { ...process.env, APP_ENV: 'test' };
function runCli(script) {
  return spawnSync(process.execPath, [path.join(DB_DIR, 'src', 'cli', script)], {
    cwd: DB_DIR, env: TEST_ENV, encoding: 'utf8',
  });
}

// ── Part A: env resolution + safety guards (no DB) ───────────────────────────
function envTests() {
  // APP_ENV validation
  let threw = null;
  try { loadEnv({ appEnv: 'prod' }); } catch (e) { threw = e; }
  ok(threw instanceof EnvError, 'rejects an unknown APP_ENV');

  // Deployed environments must not silently fall back to a local database.
  // (restore() must not resurrect an unset variable as the string "undefined")
  const restore = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  const saved = { url: process.env.DATABASE_URL, test: process.env.DATABASE_URL_TEST };
  delete process.env.DATABASE_URL; delete process.env.DATABASE_URL_TEST;
  threw = null;
  try { loadEnv({ appEnv: 'production' }); } catch (e) { threw = e; }
  ok(threw instanceof EnvError && /DATABASE_URL is required/.test(threw.message),
    'production requires an explicit DATABASE_URL (no default)');
  threw = null;
  try { loadEnv({ appEnv: 'staging' }); } catch (e) { threw = e; }
  ok(threw instanceof EnvError, 'staging requires an explicit DATABASE_URL');
  const localEnv = loadEnv({ appEnv: 'local' });
  ok(/127\.0\.0\.1:5433\/veorec$/.test(localEnv.databaseUrl), 'local falls back to the documented dev default');
  restore('DATABASE_URL', saved.url); restore('DATABASE_URL_TEST', saved.test);

  // Destructive guard
  const prodEnv = loadEnv({ appEnv: 'production', databaseUrl: 'postgres://u:p@db.example.com:5432/prod' });
  ok(prodEnv.destructiveAllowed === false, 'production is never destructive-allowed');
  threw = null;
  try { assertDestructiveAllowed(prodEnv, 'db:reset'); } catch (e) { threw = e; }
  ok(threw instanceof EnvError && /Refusing/.test(threw.message), 'assertDestructiveAllowed blocks production');
  ok(loadEnv({ appEnv: 'staging', databaseUrl: 'postgres://u:p@h:5432/s' }).destructiveAllowed === false,
    'staging is not destructive-allowed');
  ok(loadEnv({ appEnv: 'test' }).destructiveAllowed === true, 'test is destructive-allowed');

  // SSL defaults: require when deployed, disable locally (unless overridden).
  const savedSsl = process.env.DATABASE_SSL; delete process.env.DATABASE_SSL;
  ok(loadEnv({ appEnv: 'production', databaseUrl: 'postgres://u:p@h:5432/d' }).sslMode === 'require',
    'deployed defaults to ssl=require');
  ok(loadEnv({ appEnv: 'local' }).sslMode === 'disable', 'local defaults to ssl=disable');
  restore('DATABASE_SSL', savedSsl);

  // Credential redaction
  ok(redactUrl('postgres://user:supersecret@host:5432/db') === 'postgres://user:***@host:5432/db',
    'redactUrl hides the password');
  ok(!redactUrl('postgres://user:supersecret@host:5432/db').includes('supersecret'),
    'redacted URL contains no password material');

  // Journal is well-formed and ordered
  const journal = readJournal(path.join(DB_DIR, 'migrations'));
  ok(journal.length >= 1 && journal[0].tag === '0000_foundation', 'journal lists 0000_foundation first');
  ok(journal.every((e, i) => i === 0 || e.idx > journal[i - 1].idx), 'journal entries are strictly ordered');
}

// ── Part B: live database ────────────────────────────────────────────────────
async function dbTests() {
  const env = loadEnv({ appEnv: 'test' });
  const probe = await checkConnection(createPool({ env, max: 1 }));
  if (!probe.ok) {
    const msg = `database unreachable at ${env.databaseUrlRedacted}: ${probe.error && probe.error.message}`;
    if (process.env.DB_TESTS_REQUIRED === '1') { console.log('  FAIL:', msg); fail++; return; }
    console.log('\n' + '='.repeat(72));
    console.log('SKIPPED: live database tests — ' + msg);
    console.log('Start infrastructure with:  docker compose up -d postgres');
    console.log('(set DB_TESTS_REQUIRED=1 to make this a failure instead)');
    console.log('='.repeat(72));
    return;
  }
  ok(true, `connected to the test database (${probe.database})`);
  ok(probe.database !== 'veorec', 'tests do NOT run against the development database');

  // Start from a genuinely clean database: reset drops everything, then
  // migrates. This is also the "migration runner against a clean DB" case.
  // Count-agnostic: the journal grows with every future migration.
  const journalCount = readJournal(path.join(DB_DIR, 'migrations')).length;
  const reset = runCli('reset.js');
  ok(reset.status === 0, `db:reset succeeds (exit ${reset.status})\n${reset.stderr || ''}`);
  ok(/schema dropped and recreated/.test(reset.stdout || ''), 'db:reset reports dropping the schema');
  ok(new RegExp(`applied ${journalCount} migration`).test(reset.stdout || ''),
    `db:reset re-applies all ${journalCount} migration(s) from scratch`);
  ok(!/veorec_local_dev/.test((reset.stdout || '') + (reset.stderr || '')), 'db:reset never prints the password');

  const pool = createPool({ env, max: 2, applicationName: 'veorec-db-test' });
  try {
    // Migrations are recorded and none are pending.
    const state = await migrationState(pool, env.migrationsFolder);
    ok(state.pending.length === 0 && state.applied.length === state.total,
      `all ${state.total} migration(s) applied, none pending`);

    // Foundation objects created by 0000 exist.
    const ext = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'citext'");
    ok(ext.rowCount === 1, 'citext extension installed by migration 0000');
    const fn = await pool.query("SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at'");
    ok(fn.rowCount === 1, 'set_updated_at() trigger function created by migration 0000');

    // Re-running migrate is a no-op (idempotent, safe to run on every deploy).
    const again = runCli('migrate.js');
    ok(again.status === 0 && /nothing to do/.test(again.stdout || ''), 'db:migrate is idempotent');
    const state2 = await migrationState(pool, env.migrationsFolder);
    ok(state2.applied.length === state.applied.length, 're-running migrate applies nothing new');

    // db:status exits 0 when up to date.
    const status = runCli('status.js');
    ok(status.status === 0 && new RegExp(`${journalCount}/${journalCount} applied`).test(status.stdout || ''),
      'db:status reports an up-to-date database');

    // ── Constraint conventions (docs/07 §1) verified on scratch tables ───────
    // Proves the foundation supports what T-102's tables will rely on, without
    // creating application tables early.
    await pool.query('CREATE SCHEMA IF NOT EXISTS t101_scratch');
    await pool.query(`
      CREATE TABLE t101_scratch.owner (
        id text PRIMARY KEY,
        email citext NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await pool.query(`
      CREATE TABLE t101_scratch.child (
        id text PRIMARY KEY,
        owner_id text NOT NULL REFERENCES t101_scratch.owner(id) ON DELETE CASCADE,
        status text NOT NULL CHECK (status IN ('queued','active','done')),
        bytes bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0)
      )`);
    await pool.query(`
      CREATE TRIGGER set_updated_at BEFORE UPDATE ON t101_scratch.owner
      FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);

    await pool.query("INSERT INTO t101_scratch.owner (id, email) VALUES ('usr_1', 'Person@Example.com')");

    const expectReject = async (sql, label, code) => {
      try { await pool.query(sql); ok(false, `${label} (expected rejection, none happened)`); }
      catch (e) { ok(!code || e.code === code, `${label} (rejected: ${e.code})`); }
    };
    await expectReject("INSERT INTO t101_scratch.owner (id, email) VALUES ('usr_2', 'person@example.com')",
      'citext UNIQUE rejects a case-different duplicate email', '23505');
    await expectReject("INSERT INTO t101_scratch.child (id, owner_id, status) VALUES ('c1','usr_missing','queued')",
      'foreign key rejects an unknown owner', '23503');
    await expectReject("INSERT INTO t101_scratch.child (id, owner_id, status) VALUES ('c2','usr_1','bogus')",
      'status CHECK rejects an invalid value', '23514');
    await expectReject("INSERT INTO t101_scratch.child (id, owner_id, status, bytes) VALUES ('c3','usr_1','queued',-1)",
      'non-negative CHECK rejects a negative counter', '23514');
    await expectReject("INSERT INTO t101_scratch.owner (id, email) VALUES ('usr_3', NULL)",
      'NOT NULL is enforced', '23502');

    // ON DELETE CASCADE
    await pool.query("INSERT INTO t101_scratch.child (id, owner_id, status, bytes) VALUES ('c_ok','usr_1','queued',5)");
    await pool.query("DELETE FROM t101_scratch.owner WHERE id = 'usr_1'");
    const orphans = await pool.query('SELECT count(*)::int AS n FROM t101_scratch.child');
    ok(orphans.rows[0].n === 0, 'ON DELETE CASCADE removes dependent rows');

    // updated_at trigger fires on UPDATE
    await pool.query("INSERT INTO t101_scratch.owner (id, email) VALUES ('usr_t','trigger@example.com')");
    const t1 = (await pool.query("SELECT updated_at FROM t101_scratch.owner WHERE id='usr_t'")).rows[0].updated_at;
    await sleep(10);
    await pool.query("UPDATE t101_scratch.owner SET email='trigger2@example.com' WHERE id='usr_t'");
    const t2 = (await pool.query("SELECT updated_at FROM t101_scratch.owner WHERE id='usr_t'")).rows[0].updated_at;
    ok(new Date(t2).getTime() > new Date(t1).getTime(), 'set_updated_at() advances updated_at on UPDATE');

    // Teardown leaves the database clean for the next run.
    await pool.query('DROP SCHEMA t101_scratch CASCADE');
    const gone = await pool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name='t101_scratch'");
    ok(gone.rowCount === 0, 'test teardown removes scratch objects');
  } finally {
    await pool.end().catch(() => {});
  }
}

(async () => {
  envTests();
  await dbTests();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test harness error:', e); process.exit(1); });
