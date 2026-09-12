// /api/v1/me — the caller's own quota meters (T-306, docs/16 §4.5, docs/08 §13)
// and, since T-1303, the caller's ENTITLEMENT resolved from PostgreSQL only.
//
// Two SEPARATE meters — storage and videos — never one blended percentage,
// because either limit alone can block the next recording. Read from the same
// live aggregates the quota guard evaluates, so what the user sees and what the
// gate decides can never disagree.
//
//   GET /me/entitlements  → the client-safe summary (the legacy `entitlements.summary` shape):
//                           admin comp → entitled subscription (canceled keeps access until
//                           the period end) → free, from `users` + `subscriptions` rows
//   GET /me/subscription  → the subscription row's client view (no Paddle identifiers)
'use strict';

const express = require('express');
const { errorHandler } = require('./errors');
const { createIdentityBridge, scopeOf } = require('./identity');
const { resolveEntitlement, summaryBody } = require('./entitlements');

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * @param {object} deps
 * @param {() => object} deps.repositories
 * @param {Function} deps.requireAuth
 * @param {object} deps.quota             from api/src/quota createQuota()
 * @param {object} [deps.plans]           the plan catalog (getPlan, publicPlan, DEFAULT_PLAN_SLUG) — enables the entitlement routes
 * @param {object} [deps.logger]
 */
function createMeRouter({ repositories, requireAuth, quota, plans = null, logger = console }) {
  const router = express.Router();
  router.use('/me', requireAuth);
  router.use('/me', createIdentityBridge({ repositories, logger }));

  router.get('/me/usage', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const limits = await quota.resolveLimits(req);
    res.set('Cache-Control', 'no-store');
    return res.json(await quota.meters({ repos, scope, limits }));
  }));

  if (plans) {
    async function resolved(req) {
      const scope = scopeOf(req);
      const repos = repositories();
      const [user, subscription] = await Promise.all([repos.users.findById(scope.userId), repos.subscriptions.getForUser(scope)]);
      return { user, subscription, entitlement: resolveEntitlement({ user, subscription, plans }) };
    }
    router.get('/me/entitlements', asyncRoute(async (req, res) => {
      const { entitlement } = await resolved(req);
      res.set('Cache-Control', 'no-store');
      return res.json(summaryBody(entitlement, plans));
    }));
    router.get('/me/subscription', asyncRoute(async (req, res) => {
      const { subscription, entitlement } = await resolved(req);
      res.set('Cache-Control', 'no-store');
      return res.json({
        subscription: subscription ? {
          id: subscription.id, status: subscription.status, planSlug: subscription.planSlug, billingCycle: subscription.billingCycle || null,
          currentPeriodStart: subscription.currentPeriodStart ? new Date(subscription.currentPeriodStart).getTime() : null,
          currentPeriodEnd: subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd).getTime() : null,
          cancelAtPeriodEnd: !!subscription.cancelAtPeriodEnd, entitled: entitlement.subscription ? entitlement.subscription.entitled : false,
          updatedAt: subscription.updatedAt ? new Date(subscription.updatedAt).getTime() : null,
        } : null,
        planSlug: entitlement.planSlug, source: entitlement.source,
      });
    }));
  }

  router.use(errorHandler(logger));
  return router;
}

module.exports = { createMeRouter };
