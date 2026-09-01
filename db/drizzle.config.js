// drizzle-kit configuration — used by `npm run db:generate` to diff the schema
// in src/schema against migrations/ and emit a new reviewable .sql file.
//
// NOTE: generation is a development-time authoring aid only. Migrations are
// applied exclusively by `npm run db:migrate` (the tracked, forward-only
// runner). `drizzle-kit push` (automatic destructive sync) is never used
// against any environment — docs/07 §14.
'use strict';

const path = require('path');
const { loadEnv } = require('./src/env');

const env = loadEnv();

/** @type {import('drizzle-kit').Config} */
module.exports = {
  dialect: 'postgresql',
  schema: './src/schema/*.js',
  out: path.join(__dirname, 'migrations'),
  dbCredentials: { url: env.databaseUrl },
  // Only the application model is diffed; the transitional `legacy` schema
  // (T-104) is invisible to drizzle-kit and is dropped wholesale in Phase 14.
  schemaFilter: ['public'],
  strict: true,
  verbose: true,
};
