// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION STATE (T-101)
//
// Reads the Drizzle journal (the ordered, version-controlled list of migration
// files) and the applied-migrations table Drizzle maintains in the database
// (schema "drizzle", table "__drizzle_migrations", where created_at is the
// journal entry's `when` timestamp), and reports applied vs pending.
//
// Used by `db:status` and by the tests. Read-only — it never mutates anything.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const APPLIED_TABLE = '"drizzle"."__drizzle_migrations"';

/** Ordered migration entries from migrations/meta/_journal.json. */
function readJournal(migrationsFolder) {
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  if (!fs.existsSync(journalPath)) return [];
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  return (journal.entries || [])
    .slice()
    .sort((a, b) => a.idx - b.idx)
    .map((e) => ({ idx: e.idx, tag: e.tag, when: e.when }));
}

/** Rows from the applied-migrations table ([] when it does not exist yet). */
async function listApplied(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT hash, created_at FROM ${APPLIED_TABLE} ORDER BY created_at ASC`
    );
    return rows.map((r) => ({ hash: r.hash, when: Number(r.created_at) }));
  } catch (err) {
    if (err && err.code === '42P01') return []; // undefined_table — nothing applied yet
    throw err;
  }
}

/** @returns {{applied: object[], pending: object[], total: number}} */
async function migrationState(pool, migrationsFolder) {
  const journal = readJournal(migrationsFolder);
  const applied = await listApplied(pool);
  const appliedWhen = new Set(applied.map((a) => a.when));
  return {
    total: journal.length,
    applied: journal.filter((j) => appliedWhen.has(j.when)),
    pending: journal.filter((j) => !appliedWhen.has(j.when)),
  };
}

module.exports = { readJournal, listApplied, migrationState, APPLIED_TABLE };
