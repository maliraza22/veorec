// @veorec/api — public surface (T-301).
//
// Application code mounts the router; it never reaches into the handlers.
// The router owns orchestration only: PostgreSQL goes through @veorec/db
// repositories and object storage through @veorec/storage, so this package
// contains no SQL and no storage SDK.
'use strict';

const { createUploadRouter, defaultEntitlements } = require('./uploads.router');
const { createRecordingsRouter, defaultEntitlements: defaultRecordingEntitlements } = require('./recordings.router');
const { createMeRouter } = require('./me.router');
const { createAdminJobsRouter } = require('./admin-jobs.router');
const { createAiRouter } = require('./ai.router');
const { createWatchRouter } = require('./watch.router');
const { createFoldersRouter } = require('./folders.router');
const { createNotificationsRouter } = require('./notifications.router');
const { createSharingRouter } = require('./sharing.router');
const { createEngagementRouter } = require('./engagement.router');
const { createWatchContext } = require('./watch-context');
const { createAnalyticsRouter } = require('./analytics.router');
const billing = require('./billing');
const entitlements = require('./entitlements');
const { createEditingRouter } = require('./editing.router');
const paywall = require('./paywall');
const authz = require('./authz');
const rateLimit = require('./rate-limit');
const quota = require('./quota');
const errors = require('./errors');
const identity = require('./identity');

module.exports = {
  createUploadRouter, defaultEntitlements,
  createRecordingsRouter, defaultRecordingEntitlements,
  // T-306: the quota ledger and the caller's own meters.
  createMeRouter, ...quota,
  // T-601: processing-job triage (the failed rows are the dead-letter queue).
  createAdminJobsRouter,
  // T-603: async transcription/AI triggers + /recordings/:id/status.
  createAiRouter,
  // T-801: the public watch read path — payload, unlock, signed media, HLS playlist proxy, transcript, lead gate.
  createWatchRouter, authz, ...rateLimit,
  // T-803: the signed-in library — folders CRUD and the query-derived notifications feed.
  createFoldersRouter, createNotificationsRouter,
  // T-901: managed share links + Slack share (gate resolution lives in authz / the watch router).
  createSharingRouter,
  // T-1001: engagement (views / progress / comments / reactions) on PostgreSQL, sharing the watch context.
  createEngagementRouter, createWatchContext,
  // T-1002 / T-1003: owner analytics from view_sessions + the unified paywall events.
  createAnalyticsRouter, ...paywall,
  // T-1301 / T-1303: the Paddle webhook ledger and entitlement resolution on PostgreSQL.
  ...billing, ...entitlements,
  // T-1201: edit sessions, render enqueue, silence removal, stitch (the worker renders).
  createEditingRouter,
  ...identity,
  ...errors,
};
