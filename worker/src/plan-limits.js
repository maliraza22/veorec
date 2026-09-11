// Plan limits for a PostgreSQL user (T-602, docs/16 §2 priority):
//   admin-granted manual plan (unexpired) > entitled subscription > default.
//
// Mirrors server/entitlements.js resolve() over PostgreSQL rows, using the ONE
// plan catalog (server/plans.js limitsFor, honouring QUOTA_ENFORCEMENT_V2).
// PostgreSQL carries no free-text `plan` column, so the legacy "raw stored
// plan string" fallback does not exist here: no entitlement ⇒ the default plan.
'use strict';

const ENTITLED_STATUSES = new Set(['active', 'trialing', 'past_due']);   // docs/07 §9

function createPlanResolver({ plans, env = process.env, now = () => Date.now() }) {
  if (!plans || typeof plans.limitsFor !== 'function' || typeof plans.getPlan !== 'function') {
    throw new Error('createPlanResolver: the plan catalog (server/plans.js) is required');
  }
  return async function resolveLimits({ user, subscription } = {}) {
    let slug = null;
    if (user && user.manualPlan) {
      const expires = user.manualPlanExpires ? new Date(user.manualPlanExpires).getTime() : null;
      if (!expires || expires > now()) slug = plans.getPlan(user.manualPlan).slug;
    }
    // An expired comp falls through to the subscription, as in the legacy resolver.
    if (!slug && subscription && ENTITLED_STATUSES.has(subscription.status)) slug = subscription.planSlug || 'pro';
    return plans.limitsFor(plans.getPlan(slug || plans.DEFAULT_PLAN_SLUG), env);
  };
}

module.exports = { createPlanResolver, ENTITLED_STATUSES };
