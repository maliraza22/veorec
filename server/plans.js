// ─────────────────────────────────────────────────────────────────────────────
// PLAN CATALOG  —  the single source of truth for what each plan can do.
//
// CORE RULE: never hardcode plan names in business logic. Code asks
//   plan.features.analyticsEnabled
// never
//   user.plan === 'pro'
//
// A "plan" describes CAPABILITIES + LIMITS. Billing cycle (monthly vs yearly)
// lives on the Subscription, NOT here — Pro Monthly and Pro Annual are the SAME
// plan (identical capabilities), just billed differently. That is why the spec
// says annual is "Everything included in Pro Monthly".
//
// Adding Business / Enterprise later = add an entry here. No code changes, no DB
// rewrite. They are defined (so the system already understands them) but NOT sold
// — `purchasable: false` keeps them off the pricing page until you flip it on.
// ─────────────────────────────────────────────────────────────────────────────

const GB = 1024 * 1024 * 1024;

// Paddle price IDs are resolved from env so we never hardcode them in source.
// (See billing.config.js for the structured Paddle product map.)
const env = (k) => process.env[k] || null;
// Environment-aware Paddle price lookup — mirrors billing.config so the reverse
// price-id → plan mapping (resolvePlanByPriceId) works in sandbox AND production.
const _padEnv = (process.env.PADDLE_ENVIRONMENT || process.env.PADDLE_ENV || 'sandbox').trim().toLowerCase();
const IS_SANDBOX = !(_padEnv === 'production' || _padEnv === 'live');
const priceEnv = (base, alias) => IS_SANDBOX ? env(`${base}_SANDBOX`) : (env(base) || (alias ? env(alias) : null));

/**
 * @typedef {Object} PlanFeatures
 * @property {boolean} analyticsEnabled
 * @property {boolean} customThumbnailEnabled
 * @property {boolean} removeBrandingEnabled
 * @property {boolean} priorityProcessingEnabled
 * @property {boolean} passwordProtectedVideosEnabled
 * @property {boolean} advancedSharingEnabled
 * @property {boolean} basicSharingEnabled
 * @property {boolean} transcriptionEnabled
 */

/** @type {Record<string, any>} */
const PLANS = {
  // ── FREE ───────────────────────────────────────────────────────────────────
  free: {
    id: 'plan_free',
    name: 'Free',
    slug: 'free',
    purchasable: true,           // shown on pricing page, but $0 / no checkout
    order: 0,
    monthlyPrice: 0,
    yearlyPrice: 0,
    maxVideos: 30,               // free is gated by video COUNT, not storage size
    storageLimitGB: 20,          // generous so the 30-video count is the binding limit
    storageLimitBytes: 20 * GB,
    recordingLimitMinutes: 10,
    exportQuality: '720p',
    branding: true,              // VeoRec watermark/branding ON
    features: {
      basicSharingEnabled: true,
      advancedSharingEnabled: false,
      analyticsEnabled: false,
      customThumbnailEnabled: false,
      removeBrandingEnabled: false,
      priorityProcessingEnabled: false,
      passwordProtectedVideosEnabled: false,
      // AI transcription + auto-title run on our self-hosted Whisper, so they're
      // free & unlimited for everyone (matches the in-app "free & unlimited" copy).
      transcriptionEnabled: true,
      // Advanced AI (summaries/chapters/translation), clip stitching, lead
      // capture and Slack sharing are Pro.
      aiDocsEnabled: false,
      clipStitchEnabled: false,
      leadCaptureEnabled: false,
      slackEnabled: false,
    },
    paddle: { monthlyPriceId: null, yearlyPriceId: null },
  },

  // ── PRO ──────────────────────────────────────────────────────────────────────
  // One plan, two prices. $7.99/mo or $79/yr ("2 months free").
  pro: {
    id: 'plan_pro',
    name: 'Pro',
    slug: 'pro',
    purchasable: true,
    order: 1,
    badge: 'Most Popular',
    monthlyPrice: 7.99,
    yearlyPrice: 79,
    yearlyBadge: '2 Months Free',
    maxVideos: null,             // unlimited videos
    storageLimitGB: 1024,        // effectively unlimited storage
    storageLimitBytes: 1024 * GB,
    recordingLimitMinutes: 600,  // effectively unlimited recording length
    exportQuality: '1080p',
    branding: false,
    features: {
      basicSharingEnabled: true,
      advancedSharingEnabled: true,
      analyticsEnabled: true,
      customThumbnailEnabled: true,
      removeBrandingEnabled: true,
      priorityProcessingEnabled: true,
      passwordProtectedVideosEnabled: true,
      transcriptionEnabled: true,
      aiDocsEnabled: true,
      clipStitchEnabled: true,
      leadCaptureEnabled: true,
      slackEnabled: true,
    },
    paddle: {
      monthlyPriceId: priceEnv('PADDLE_PRICE_PRO_MONTHLY', 'PADDLE_PRICE_ID'),
      yearlyPriceId: priceEnv('PADDLE_PRICE_PRO_YEARLY'),
    },
  },

  // ── BUSINESS (architected, NOT sold) ────────────────────────────────────────
  business: {
    id: 'plan_business',
    name: 'Business',
    slug: 'business',
    purchasable: false,
    order: 2,
    monthlyPrice: 24,
    yearlyPrice: 240,
    storageLimitGB: 1024,
    storageLimitBytes: 1024 * GB,
    recordingLimitMinutes: 240,
    exportQuality: '1080p',
    branding: false,
    features: {
      basicSharingEnabled: true,
      advancedSharingEnabled: true,
      analyticsEnabled: true,
      customThumbnailEnabled: true,
      removeBrandingEnabled: true,
      priorityProcessingEnabled: true,
      passwordProtectedVideosEnabled: true,
      transcriptionEnabled: true,
      // room to grow: teamsEnabled, ssoEnabled, customDomainsEnabled, …
    },
    paddle: {
      monthlyPriceId: priceEnv('PADDLE_PRICE_BUSINESS_MONTHLY'),
      yearlyPriceId: priceEnv('PADDLE_PRICE_BUSINESS_YEARLY'),
    },
  },

  // ── ENTERPRISE (architected, NOT sold) ──────────────────────────────────────
  enterprise: {
    id: 'plan_enterprise',
    name: 'Enterprise',
    slug: 'enterprise',
    purchasable: false,
    order: 3,
    monthlyPrice: null,          // "Contact us"
    yearlyPrice: null,
    storageLimitGB: 10240,
    storageLimitBytes: 10240 * GB,
    recordingLimitMinutes: 600,
    exportQuality: '4k',
    branding: false,
    features: {
      basicSharingEnabled: true,
      advancedSharingEnabled: true,
      analyticsEnabled: true,
      customThumbnailEnabled: true,
      removeBrandingEnabled: true,
      priorityProcessingEnabled: true,
      passwordProtectedVideosEnabled: true,
      transcriptionEnabled: true,
    },
    paddle: { monthlyPriceId: null, yearlyPriceId: null },
  },
};

const DEFAULT_PLAN_SLUG = 'free';

// ── Runtime overrides ─────────────────────────────────────────────────────────
// The admin panel can change prices/limits/features without a code deploy. Those
// edits are persisted to plan_overrides.json and merged over the code defaults
// here. A tiny in-memory cache avoids re-reading the file on every request.
const fs = require('fs');
const path = require('path');
const DATA_DIR = process.env.DATA_DIR || __dirname;
const OVERRIDES_FILE = path.join(DATA_DIR, 'plan_overrides.json');
const GB_BYTES = GB;

let _cache = null;
let _cacheAt = 0;
function loadOverrides() {
  if (_cache && Date.now() - _cacheAt < 3000) return _cache;
  try { _cache = fs.existsSync(OVERRIDES_FILE) ? JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')) : {}; }
  catch { _cache = {}; }
  _cacheAt = Date.now();
  return _cache;
}
function saveOverrides(obj) {
  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(obj, null, 2));
  _cache = obj; _cacheAt = Date.now();
}

// Whitelisted fields an admin may override (never the Paddle ids or internal id).
const OVERRIDABLE = ['name', 'monthlyPrice', 'yearlyPrice', 'storageLimitGB',
  'recordingLimitMinutes', 'exportQuality', 'branding', 'badge', 'yearlyBadge', 'purchasable'];

function applyOverride(base) {
  const ov = loadOverrides()[base.slug];
  if (!ov) return base;
  const merged = { ...base, features: { ...base.features } };
  for (const k of OVERRIDABLE) if (k in ov) merged[k] = ov[k];
  if (ov.features) merged.features = { ...base.features, ...ov.features };
  // keep derived field in sync if storage was changed
  if ('storageLimitGB' in ov) merged.storageLimitBytes = ov.storageLimitGB * GB_BYTES;
  return merged;
}

/** Resolve a plan by slug (with admin overrides applied). Unknown → free. */
function getPlan(slug) {
  const base = (slug && PLANS[String(slug).toLowerCase()]) || PLANS[DEFAULT_PLAN_SLUG];
  return applyOverride(base);
}

/** Persist an admin edit to a plan. Returns the merged plan. */
function setPlanOverride(slug, fields) {
  if (!PLANS[slug]) return null;
  const all = loadOverrides();
  const cur = all[slug] || {};
  for (const k of Object.keys(fields)) {
    if (k === 'features' && fields.features) cur.features = { ...(cur.features || {}), ...fields.features };
    else if (OVERRIDABLE.includes(k)) cur[k] = fields[k];
  }
  all[slug] = cur;
  saveOverrides(all);
  return getPlan(slug);
}

/** Clear overrides for a plan (revert to code defaults). */
function clearPlanOverride(slug) {
  const all = loadOverrides();
  delete all[slug];
  saveOverrides(all);
  return getPlan(slug);
}

/** All plans the public pricing page should render (purchasable, ordered). */
function listPublicPlans() {
  return Object.values(PLANS)
    .map((p) => getPlan(p.slug))
    .filter((p) => p.purchasable)
    .sort((a, b) => a.order - b.order);
}

/** All plans (incl. future), overrides applied — for admin tooling. */
function listAllPlans() {
  return Object.values(PLANS).map((p) => getPlan(p.slug)).sort((a, b) => a.order - b.order);
}

/**
 * Given a Paddle price id, find which plan + billing cycle it belongs to.
 * Used by the webhook to map an incoming subscription back to a plan WITHOUT
 * hardcoding any ids in the handler.
 * @returns {{ plan: any, billingCycle: 'monthly'|'yearly' } | null}
 */
function resolvePlanByPriceId(priceId) {
  if (!priceId) return null;
  for (const plan of Object.values(PLANS)) {
    if (plan.paddle?.monthlyPriceId === priceId) return { plan, billingCycle: 'monthly' };
    if (plan.paddle?.yearlyPriceId === priceId) return { plan, billingCycle: 'yearly' };
  }
  return null;
}

/** A trimmed, client-safe view of a plan (no internal ids leak). */
function publicPlan(plan) {
  if (!plan) return null;
  return {
    name: plan.name,
    slug: plan.slug,
    badge: plan.badge || null,
    yearlyBadge: plan.yearlyBadge || null,
    monthlyPrice: plan.monthlyPrice,
    yearlyPrice: plan.yearlyPrice,
    storageLimitGB: plan.storageLimitGB,
    maxVideos: plan.maxVideos ?? null,
    recordingLimitMinutes: plan.recordingLimitMinutes,
    exportQuality: plan.exportQuality,
    branding: plan.branding,
    features: { ...plan.features },
    // expose which billing cycles can actually be purchased
    canBuyMonthly: !!plan.paddle?.monthlyPriceId,
    canBuyYearly: !!plan.paddle?.yearlyPriceId,
  };
}

// ── T-306: the docs/16 §1.1 quota model, behind an enforcement switch ─────────
//
// The target free plan is 50 active videos AND 5 GiB retained (whichever is
// reached first), with a per-recording byte ceiling. docs/23 Phase 3 forbids
// flipping that enforcement on without ≥14 days of in-app notice, so the
// target integers live HERE, beside the legacy fields, and `limitsFor()`
// chooses which set is active:
//
//   QUOTA_ENFORCEMENT_V2 unset / anything but exactly "true"  → legacy limits
//   QUOTA_ENFORCEMENT_V2 = "true"                              → §1.1 integers
//
// OFF is byte-identical to today's entitlements. ON is the notice-period flip.
// "Grandfathering" (docs/23) is not a stored flag: a user already over the new
// cap is simply blocked from NEW recordings by the same guard that blocks
// everyone else, and nothing they own is ever trimmed or deleted.
//
// Exact values — integers, never strings (docs/16 §1.1).
const MiB = 1024 * 1024;
const QUOTA_V2 = {
  free: {
    maxActiveVideos: 50,
    maxStorageBytes: 5_368_709_120,        // 5 GiB (marketed "5 GB")
    maxRecordingDurationSeconds: 600,
    maxUploadBytes: 536_870_912,           // 512 MiB per-recording hard byte ceiling
    minStartBytes: 67_108_864,             // 64 MiB — refuse to start below this much free quota
    maxResolution: { width: 1920, height: 1080 },
  },
  pro: {
    maxActiveVideos: null,                 // unlimited
    maxStorageBytes: 1_099_511_627_776,    // 1 TiB
    maxRecordingDurationSeconds: 36_000,
    maxUploadBytes: 21_474_836_480,        // 20 GiB
    minStartBytes: 67_108_864,
    maxResolution: { width: 1920, height: 1080 },
  },
  business: {
    maxActiveVideos: null,
    maxStorageBytes: 1_099_511_627_776,
    maxRecordingDurationSeconds: 14_400,
    maxUploadBytes: 21_474_836_480,
    minStartBytes: 67_108_864,
    maxResolution: { width: 1920, height: 1080 },
  },
  enterprise: {
    maxActiveVideos: null,
    maxStorageBytes: 10_995_116_277_760,   // 10 TiB
    maxRecordingDurationSeconds: 36_000,
    maxUploadBytes: 21_474_836_480,
    minStartBytes: 67_108_864,
    maxResolution: { width: 3840, height: 2160 },
  },
};

/** Only the literal 'true' turns the new model on. */
function quotaEnforcementV2(env = process.env) {
  return env.QUOTA_ENFORCEMENT_V2 === 'true';
}

/**
 * The limit set the quota guard and the meters use for a plan. The same shape
 * either way, so no caller branches on the switch:
 *   { model, planSlug, maxActiveVideos, maxStorageBytes, maxUploadBytes,
 *     minStartBytes, maxRecordingDurationSeconds, maxResolution }
 * Legacy mode maps today's fields 1:1 (maxVideos, storageLimitBytes,
 * recordingLimitMinutes) — the per-recording ceiling and the start floor did
 * not exist before, so they take the §1.1 values in both modes: they only ever
 * cap a single take, never a user's entitlement.
 */
function limitsFor(plan, env = process.env) {
  const p = plan && plan.slug ? plan : getPlan(plan);
  const v2 = QUOTA_V2[p.slug] || QUOTA_V2.free;
  if (quotaEnforcementV2(env)) {
    return { model: 'v2', planSlug: p.slug, ...v2 };
  }
  return {
    model: 'legacy',
    planSlug: p.slug,
    maxActiveVideos: p.maxVideos == null ? null : Number(p.maxVideos),
    maxStorageBytes: Number(p.storageLimitBytes),
    maxRecordingDurationSeconds: Number(p.recordingLimitMinutes) * 60,
    maxUploadBytes: v2.maxUploadBytes,
    minStartBytes: v2.minStartBytes,
    maxResolution: p.exportQuality === '4k' ? { width: 3840, height: 2160 } : { width: 1920, height: 1080 },
  };
}

module.exports = {
  PLANS,
  GB,
  MiB,
  QUOTA_V2,
  quotaEnforcementV2,
  limitsFor,
  DEFAULT_PLAN_SLUG,
  getPlan,
  listPublicPlans,
  listAllPlans,
  resolvePlanByPriceId,
  publicPlan,
  setPlanOverride,
  clearPlanOverride,
};
