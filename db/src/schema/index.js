// ─────────────────────────────────────────────────────────────────────────────
// DRIZZLE SCHEMA — the complete application data model (T-102).
//
// PostgreSQL is the SOLE source of application truth (docs/02 §11): identity,
// ownership, recording lifecycle, upload sessions, quota accounting, processing
// state, engagement, transcripts, editing, billing.
//
// Object storage (Cloudflare R2 in production, MinIO locally, always behind the
// StorageProvider abstraction) holds media BYTES only, addressed by the
// provider-neutral `video_assets.storage_key`. This model contains no
// provider-specific columns — no Cloudinary identifiers, buckets or URLs.
// Cloudinary is LEGACY: still serving the old application, scheduled for
// backfill in T-204 and removal in migration Phase 14 (docs/23).
//
// Canonical specification: docs/07. Migration: migrations/0001_application_schema.sql.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// Tables only — drizzle-kit diffs whatever this barrel exports, so non-table
// constants stay in their own modules.
const identity = require('./identity');
const jobs = require('./jobs');
const recordings = require('./recordings');
const uploads = require('./uploads');
const engagement = require('./engagement');
const transcripts = require('./transcripts');
const editing = require('./editing');
const billing = require('./billing');
const misc = require('./misc');

module.exports = {
  // identity
  users: identity.users,
  sessions: identity.sessions,
  workspaces: identity.workspaces,
  workspaceMembers: identity.workspaceMembers,
  // jobs
  processingJobs: jobs.processingJobs,
  // recordings & media
  folders: recordings.folders,
  recordings: recordings.recordings,
  videoAssets: recordings.videoAssets,
  // uploads & quota reservations
  uploadSessions: uploads.uploadSessions,
  uploadParts: uploads.uploadParts,
  storageReservations: uploads.storageReservations,
  // sharing & engagement
  shareLinks: engagement.shareLinks,
  comments: engagement.comments,
  reactions: engagement.reactions,
  viewSessions: engagement.viewSessions,
  analyticsEvents: engagement.analyticsEvents,
  leads: engagement.leads,
  // transcripts
  transcripts: transcripts.transcripts,
  transcriptSegments: transcripts.transcriptSegments,
  transcriptTranslations: transcripts.transcriptTranslations,
  // editing
  editSessions: editing.editSessions,
  editOperations: editing.editOperations,
  renderJobs: editing.renderJobs,
  // billing & usage
  subscriptions: billing.subscriptions,
  billingEvents: billing.billingEvents,
  usage: billing.usage,
  planOverrides: billing.planOverrides,
  // misc
  contacts: misc.contacts,
  notificationReads: misc.notificationReads,
  auditLogs: misc.auditLogs,
};
