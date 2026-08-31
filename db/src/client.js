// ─────────────────────────────────────────────────────────────────────────────
// DRIZZLE CLIENT (T-101)
//
// Wraps a pg Pool in a Drizzle instance. Drizzle is the query builder/ORM
// (docs/02 §10.3) — chosen for plain, reviewable SQL migrations and a
// first-class raw-SQL escape hatch. The schema object is empty until T-102.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { drizzle } = require('drizzle-orm/node-postgres');
const schema = require('./schema');
const { getPool } = require('./pool');

/** @param {import('pg').Pool} [pool] defaults to the shared process pool. */
function createClient(pool) {
  return drizzle(pool || getPool(), { schema });
}

module.exports = { createClient, schema };
