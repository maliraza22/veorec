// ─────────────────────────────────────────────────────────────────────────────
// PERMISSIONS SERVICE  —  the authority for "is this user allowed to …".
//
// SECURITY: this runs server-side only. Never trust frontend plan/usage state.
// Every premium endpoint calls one of these BEFORE doing the privileged action.
//
// Every function returns the same shape:
//   { allowed: boolean, reason?: string, upgradeRequired?: boolean,
//     meta?: object }   // meta carries numbers for nice UI (limits, usage…)
// ─────────────────────────────────────────────────────────────────────────────
const entitlements = require('./entitlements');
const usageService = require('./usage.service');
const plans = require('./plans');

const ALLOW = (meta) => ({ allowed: true, meta });
const DENY = (reason, meta) => ({ allowed: false, reason, upgradeRequired: true, meta });

// ── Feature gates (capability-based — note: never `plan === 'pro'`) ───────────
function gate(user, featureKey, reason) {
  const plan = entitlements.resolve(user);
  return plan.features[featureKey]
    ? ALLOW({ plan: plan.slug })
    : DENY(reason, { plan: plan.slug, feature: featureKey });
}

function canUseAnalytics(user) {
  return gate(user, 'analyticsEnabled',
    'Viewer analytics is a Pro feature. Upgrade to see who watched and for how long.');
}

function canUploadThumbnail(user) {
  return gate(user, 'customThumbnailEnabled',
    'Custom thumbnails are a Pro feature. Upgrade to brand your video previews.');
}

function canRemoveBranding(user) {
  return gate(user, 'removeBrandingEnabled',
    'Removing VeoRec branding is a Pro feature. Upgrade to share clean, white-label videos.');
}

function canUsePriorityProcessing(user) {
  return gate(user, 'priorityProcessingEnabled',
    'Priority processing is a Pro feature. Upgrade to skip the queue.');
}

function canUsePasswordProtectedVideos(user) {
  return gate(user, 'passwordProtectedVideosEnabled',
    'Password-protected videos are a Pro feature. Upgrade to control who can watch.');
}

function canUseAdvancedSharing(user) {
  return gate(user, 'advancedSharingEnabled',
    'Advanced sharing controls are a Pro feature. Upgrade to unlock them.');
}

function canUseTranscription(user) {
  return gate(user, 'transcriptionEnabled',
    'AI transcription is a Pro feature. Upgrade to auto-generate searchable transcripts.');
}

function canUseAiDocs(user) {
  return gate(user, 'aiDocsEnabled',
    'AI summaries, chapters & translation are Pro features. Upgrade to unlock the advanced AI.');
}

function canStitchClips(user) {
  return gate(user, 'clipStitchEnabled',
    'Combining clips is a Pro feature. Upgrade to stitch recordings into one video.');
}

function canCaptureLeads(user) {
  return gate(user, 'leadCaptureEnabled',
    'Email capture is a Pro feature. Upgrade to gate videos and collect viewer emails.');
}

function canUseSlack(user) {
  return gate(user, 'slackEnabled',
    'Slack sharing is a Pro feature. Upgrade to post recordings to your Slack channels.');
}

// ── Recording length ──────────────────────────────────────────────────────────
/**
 * Validate a recording's duration against the plan limit.
 * Called BOTH as a hint (frontend countdown) AND authoritatively after upload —
 * never trust the client-reported duration alone.
 * @param {number} durationSeconds
 */
function canRecord(user, durationSeconds = 0) {
  const plan = entitlements.resolve(user);
  // Small grace so a few seconds of encoder/timing jitter past the cap never
  // rejects (and loses) a recording the client already auto-stopped at the limit.
  const GRACE_SEC = 30;
  const limitSec = plan.recordingLimitMinutes * 60;
  if (durationSeconds > limitSec + GRACE_SEC) {
    return DENY(
      `Recordings are limited to ${plan.recordingLimitMinutes} minutes on the ${plan.name} plan. Upgrade to Pro for up to 120-minute recordings.`,
      { limitMinutes: plan.recordingLimitMinutes, attemptedSeconds: Math.round(durationSeconds), plan: plan.slug }
    );
  }
  return ALLOW({ limitMinutes: plan.recordingLimitMinutes, plan: plan.slug });
}

// ── Storage / upload ───────────────────────────────────────────────────────────
/**
 * Can the user upload a file of `incomingBytes`? Primary free-plan limiter.
 * @param {number} incomingBytes
 */
function canUploadVideo(user, incomingBytes = 0) {
  const plan = entitlements.resolve(user);
  const usage = usageService.get(user.id);
  const used = usage.storageUsedBytes || 0;
  // T-306: the active limit set. With QUOTA_ENFORCEMENT_V2 unset this is
  // exactly plan.storageLimitBytes — today's behaviour, byte for byte. With it
  // set to "true" the docs/16 §1.1 integers apply here too (the notice-period
  // flip), with the §4.6 block message.
  const limits = plans.limitsFor(plan);
  const limit = limits.maxStorageBytes;
  const projected = used + incomingBytes;

  if (projected > limit) {
    const limitGB = plan.storageLimitGB;
    return DENY(
      limits.model === 'v2'
        ? (plan.slug === 'free'
          ? "You've reached your 5 GB free storage limit. Delete a video or upgrade to continue recording."
          : `You've reached your ${Math.round(limit / (1024 ** 3))} GB storage limit. Delete a video or upgrade to continue recording.`)
        : (plan.slug === 'free'
          ? `Storage limit reached. Upgrade to Pro for 100GB storage.`
          : `Storage limit of ${limitGB}GB reached. Free up space or contact us to add more.`),
      {
        usedBytes: used,
        limitBytes: limit,
        incomingBytes,
        projectedBytes: projected,
        plan: plan.slug,
      }
    );
  }
  return ALLOW({ usedBytes: used, limitBytes: limit, projectedBytes: projected, plan: plan.slug });
}

/**
 * Can the user add another video? Free is gated by video COUNT (not storage).
 * Unlimited when the plan has no maxVideos.
 */
function canCreateVideo(user) {
  const plan = entitlements.resolve(user);
  // T-306: same switch as canUploadVideo — legacy field when OFF, §1.1 when ON.
  const limits = plans.limitsFor(plan);
  const maxVideos = limits.maxActiveVideos;
  if (maxVideos == null) return ALLOW({ plan: plan.slug });
  const count = usageService.get(user.id).videoCount || 0;
  if (count >= maxVideos) {
    return DENY(
      limits.model === 'v2' && plan.slug === 'free'
        ? "You've reached your 50-video free limit. Delete a video or upgrade to continue recording."
        : `You've reached the ${maxVideos}-video limit on the ${plan.name} plan. Upgrade to Pro for unlimited videos.`,
      { videoCount: count, maxVideos, plan: plan.slug }
    );
  }
  return ALLOW({ videoCount: count, maxVideos, plan: plan.slug });
}

module.exports = {
  canUploadVideo,
  canCreateVideo,
  canRecord,
  canUseAnalytics,
  canUploadThumbnail,
  canRemoveBranding,
  canUsePriorityProcessing,
  canUsePasswordProtectedVideos,
  canUseAdvancedSharing,
  canUseTranscription,
  canUseAiDocs,
  canStitchClips,
  canCaptureLeads,
  canUseSlack,
};
