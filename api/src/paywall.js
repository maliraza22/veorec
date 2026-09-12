// PAYWALL EVENTS (T-1003, docs/13 §4, docs/08 §4)
//
// Every v1 route that answers `403 feature_locked` records ONE
// `analytics_events` row `paywall_hit` with the CANONICAL trigger name the
// legacy conversion log used (`server/conversion.js` TRIGGERS), so the
// conversion funnel survives the migration and historical comparisons keep
// working. The event is recorded best-effort — a logging failure never turns
// a paywall into a 500 — and the response body is unchanged.
'use strict';

const { forbidden } = require('./errors');

/** Feature key (entitlement name) → the legacy trigger name (conversion.js). */
const TRIGGER_BY_FEATURE = {
  analyticsEnabled: 'analytics_attempted',
  analytics: 'analytics_attempted',
  customThumbnailEnabled: 'thumbnail_attempted',
  passwordProtection: 'password_protection_attempted',
  removeBranding: 'remove_branding_attempted',
  priorityProcessing: 'priority_processing_attempted',
  slackEnabled: 'advanced_sharing_attempted',
  slack: 'advanced_sharing_attempted',
  leadCapture: 'advanced_sharing_attempted',
  transcriptionEnabled: 'transcription_attempted',
  aiDocsEnabled: 'ai_docs_attempted',
  storageLimit: 'storage_limit_reached',
  recordingLimit: 'recording_over_limit',
  videoLimit: 'video_limit_reached',
};

/** The canonical trigger for a feature key (falls back to `<feature>_attempted`). */
function triggerFor(feature) {
  return TRIGGER_BY_FEATURE[feature] || `${String(feature || 'feature').replace(/[^a-z0-9_]/gi, '_').toLowerCase()}_attempted`;
}

/**
 * Record a paywall hit. Never throws.
 * @param {object} repos            repositories (needs `analytics.record`)
 * @param {{userId?: string|null, recordingId?: string|null, feature: string, plan?: string|null, meta?: object}} hit
 */
async function recordPaywall(repos, { userId = null, recordingId = null, feature, plan = null, meta = {} }, logger = null) {
  try {
    await repos.analytics.record({
      event: 'paywall_hit', recordingId, userId,
      props: { trigger: triggerFor(feature), feature, plan, ...meta },
    });
  } catch (e) {
    if (logger && logger.warn) logger.warn({ err: e && e.message, feature }, 'T-1003: paywall event not recorded');
  }
}

/**
 * Build the `403 feature_locked` error AND record the paywall event.
 * Usage: `throw await paywall(repos, { userId, feature, message, recordingId })`.
 */
async function paywall(repos, { userId = null, recordingId = null, feature, message, plan = null, meta = {} }, logger = null) {
  await recordPaywall(repos, { userId, recordingId, feature, plan, meta }, logger);
  return forbidden('feature_locked', message || 'This is a Pro feature. Upgrade to unlock it.', { upgradeRequired: true, details: { feature } });
}

module.exports = { TRIGGER_BY_FEATURE, triggerFor, recordPaywall, paywall };
