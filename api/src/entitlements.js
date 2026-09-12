// ENTITLEMENT RESOLUTION on PostgreSQL (T-1303, docs/16 §2).
//
// The ONE place that decides which plan a user is entitled to, from PostgreSQL
// rows only: admin comp (`users.manual_plan`, optional expiry) → an entitled
// subscription → free. Capability checks compare `plan.features.X`, never plan
// names. The plan catalog is injected (server/plans.js is the single catalog).
//
// The documented fix over the legacy `subscriptions.isEntitled`: a `canceled`
// subscription keeps access until its `current_period_end` has passed.
'use strict';

const ENTITLED_STATUSES = new Set(['active', 'trialing', 'past_due']);

const ms = (v) => (v == null ? null : (v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : Date.parse(v))));

/** Does this subscription row grant paid access right now? */
function isEntitled(sub, now = Date.now()) {
  if (!sub) return false;
  if (ENTITLED_STATUSES.has(sub.status)) return true;
  if (sub.status === 'canceled') {
    const end = ms(sub.currentPeriodEnd);
    return end != null && end > now;
  }
  return false;
}

/** The comped plan, if the grant is valid now and names a real plan. */
function compedSlug(user, plans, now = Date.now()) {
  if (!user || !user.manualPlan) return null;
  const plan = plans.getPlan(user.manualPlan);
  // The catalog answers the default plan for an unknown slug: only an exact, known plan counts as a grant.
  if (!plan || plan.slug !== String(user.manualPlan).toLowerCase()) return null;
  const exp = ms(user.manualPlanExpires);
  if (exp != null && exp <= now) return null;
  return plan.slug;
}

/**
 * @param {{ user: object|null, subscription: object|null, plans: object, now?: number }} p
 * @returns {{ planSlug, plan, isPaid, source: 'comped'|'subscription'|'free', comped, subscription }}
 */
function resolveEntitlement({ user, subscription, plans, now = Date.now() }) {
  const comp = compedSlug(user, plans, now);
  const entitled = isEntitled(subscription, now);
  let planSlug = plans.DEFAULT_PLAN_SLUG;
  let source = 'free';
  if (comp && comp !== plans.DEFAULT_PLAN_SLUG) { planSlug = comp; source = 'comped'; }
  else if (entitled) { planSlug = (subscription.planSlug && plans.getPlan(subscription.planSlug)) ? plans.getPlan(subscription.planSlug).slug : 'pro'; source = 'subscription'; }
  else if (comp) { planSlug = comp; source = 'comped'; }
  const plan = plans.getPlan(planSlug) || plans.getPlan(plans.DEFAULT_PLAN_SLUG);
  return {
    planSlug: plan.slug,
    plan,
    isPaid: plan.slug !== plans.DEFAULT_PLAN_SLUG,
    source,
    comped: source === 'comped',
    subscription: subscription ? {
      status: subscription.status,
      planSlug: subscription.planSlug,
      billingCycle: subscription.billingCycle || null,
      currentPeriodEnd: ms(subscription.currentPeriodEnd),
      cancelAtPeriodEnd: !!subscription.cancelAtPeriodEnd,
      entitled,
    } : null,
  };
}

/** The client-safe summary (the legacy `entitlements.summary` shape, docs/16 §2). */
function summaryBody(resolved, plans) {
  return {
    plan: plans.publicPlan(resolved.plan),
    planSlug: resolved.planSlug,
    isPaid: resolved.isPaid,
    source: resolved.source,
    comped: resolved.comped,
    subscription: resolved.subscription ? {
      status: resolved.subscription.status,
      billingCycle: resolved.subscription.billingCycle,
      currentPeriodEnd: resolved.subscription.currentPeriodEnd,
      cancelAtPeriodEnd: resolved.subscription.cancelAtPeriodEnd,
    } : null,
  };
}

module.exports = { ENTITLED_STATUSES, isEntitled, compedSlug, resolveEntitlement, summaryBody };
