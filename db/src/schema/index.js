// ─────────────────────────────────────────────────────────────────────────────
// DRIZZLE SCHEMA — table definitions
//
// INTENTIONALLY EMPTY IN T-101.
//
// T-101 delivers only the database *foundation* (pool, Drizzle client, SQL
// migration runner, local infrastructure). Application tables — users,
// workspaces, recordings, video_assets, upload_sessions, storage_reservations,
// usage, processing_jobs, transcripts, edit_sessions, billing_events, … — are
// specified in docs/07 and implemented by **T-102** (schema migration 0001).
//
// Adding tables here early would violate the phased plan (docs/26 §1.2) and
// would put schema in the repo before the migration that creates it.
//
// When T-102 lands: one file per table group (users.js, recordings.js, …),
// re-exported from this barrel so `drizzle(pool, { schema })` gets typed
// relations and drizzle-kit can diff them into migrations/.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

module.exports = {};
