// ─────────────────────────────────────────────────────────────────────────────
// REPOSITORY LAYER (T-103)
//
// The application's only data-access boundary. Everything above it (API
// handlers, services, workers) talks to repositories; nothing above it writes
// SQL, and nothing inside them knows about HTTP, storage providers, FFmpeg or
// the browser.
//
//   const { repositories, withTransaction } = require('@veorec/db');
//
//   const repos = repositories();                       // bound to the shared pool
//   const rec   = await repos.recordings.get(scope, id);
//
//   await withTransaction(async (tx) => {               // all-or-nothing
//     await tx.usage.getForUpdate(scope);               // row lock first
//     await tx.usage.applyDelta(scope, { storageReservedBytes: bytes });
//     await tx.uploads.createReservation(scope, { ... });
//   });
//
// TRANSACTION MODEL
//   • `repositories(db)` binds every repo to ONE executor — the pool, or a
//     transaction. Repos never reach for a connection themselves, so a caller
//     cannot accidentally run half a unit of work outside its transaction.
//   • `withTransaction(fn)` hands back a fully-bound repo set for the
//     transaction; throwing rolls everything back, returning commits.
//   • Operations needing mutual exclusion (the T-306 quota reservation) take a
//     row lock via `usage.getForUpdate`, which REFUSES to run outside a
//     transaction rather than silently providing no isolation.
//
// SCOPE MODEL — see scope.js. Owned-data methods take a Scope first and apply
// the ownership predicate themselves; unscoped access is limited to explicitly
// named `*System` / `*ForPublicWatch` / `*AsAdmin` methods.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { createClient } = require('../client');
const { getPool } = require('../pool');

const usersRepo = require('./users.repo');
const sessionsRepo = require('./sessions.repo');
const recordingsRepo = require('./recordings.repo');
const assetsRepo = require('./assets.repo');
const uploadsRepo = require('./uploads.repo');
const usageRepo = require('./usage.repo');
const engagementRepos = require('./engagement.repo');
const transcriptsRepo = require('./transcripts.repo');
const jobsRepo = require('./jobs.repo');
const billingRepos = require('./billing.repo');
const auditRepo = require('./audit.repo');
const notificationsRepo = require('./notifications.repo');
const editingRepos = require('./editing.repo');

/**
 * Build the repository set bound to one executor.
 * @param {object} db a Drizzle client (pool-backed) or a Drizzle transaction
 */
function createRepositories(db) {
  const engagement = engagementRepos(db);
  const billing = billingRepos(db);
  return {
    db,                                   // escape hatch for migrations/tests only
    users: usersRepo(db),
    workspaces: usersRepo.workspacesRepo(db),   // T-801: membership for the workspace privacy level
    sessions: sessionsRepo(db),
    recordings: recordingsRepo(db),
    folders: recordingsRepo.foldersRepo(db),
    assets: assetsRepo(db),
    uploads: uploadsRepo(db),
    usage: usageRepo(db),
    shareLinks: engagement.shareLinks,
    comments: engagement.comments,
    reactions: engagement.reactions,
    viewSessions: engagement.viewSessions,
    leads: engagement.leads,
    analytics: engagement.analytics,
    transcripts: transcriptsRepo(db),
    jobs: jobsRepo(db),
    subscriptions: billing.subscriptions,
    billingEvents: billing.billingEvents,
    audit: auditRepo(db),
    notifications: notificationsRepo(db),   // T-803: query-derived feed + read marker
    ...editingRepos(db),                     // T-1201: editSessions, renderJobs
  };
}

let shared = null;

/** Repositories bound to the shared process pool. */
function repositories(db) {
  if (db) return createRepositories(db);
  if (!shared) shared = createRepositories(createClient(getPool()));
  return shared;
}

/**
 * Run `fn` inside a database transaction with a transaction-bound repo set.
 * Commits on return, rolls back on throw.
 * @param {(repos: ReturnType<createRepositories>, tx: object) => Promise<any>} fn
 */
async function withTransaction(fn, db) {
  const client = db || createClient(getPool());
  return client.transaction(async (tx) => fn(createRepositories(tx), tx));
}

/** Test/CLI helper: drop the cached shared repo set. */
function resetSharedRepositories() { shared = null; }

module.exports = {
  createRepositories, repositories, withTransaction, resetSharedRepositories,
  ...require('./errors'),
  ...require('./scope'),
};
