// Public surface of @veorec/db. Consumers (API server, workers, tests) import
// from here — never from pg or drizzle directly, so the pool/env/safety rules
// stay in one place.
'use strict';

const { loadEnv, assertDestructiveAllowed, redactUrl, EnvError } = require('./env');
const { createPool, getPool, closePool, checkConnection } = require('./pool');
const { createClient, schema } = require('./client');
const { readJournal, listApplied, migrationState } = require('./migration-state');

module.exports = {
  loadEnv, assertDestructiveAllowed, redactUrl, EnvError,
  createPool, getPool, closePool, checkConnection,
  createClient, schema,
  readJournal, listApplied, migrationState,
};
