// /api/v1/me — the caller's own quota meters (T-306, docs/16 §4.5, docs/08 §13)
//
// Two SEPARATE meters — storage and videos — never one blended percentage,
// because either limit alone can block the next recording. Read from the same
// live aggregates the quota guard evaluates, so what the user sees and what the
// gate decides can never disagree.
'use strict';

const express = require('express');
const { errorHandler } = require('./errors');
const { createIdentityBridge, scopeOf } = require('./identity');

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * @param {object} deps
 * @param {() => object} deps.repositories
 * @param {Function} deps.requireAuth
 * @param {object} deps.quota             from api/src/quota createQuota()
 * @param {object} [deps.logger]
 */
function createMeRouter({ repositories, requireAuth, quota, logger = console }) {
  const router = express.Router();
  router.use(requireAuth);
  router.use(createIdentityBridge({ repositories, logger }));

  router.get('/me/usage', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const limits = await quota.resolveLimits(req);
    res.set('Cache-Control', 'no-store');
    return res.json(await quota.meters({ repos, scope, limits }));
  }));

  router.use(errorHandler(logger));
  return router;
}

module.exports = { createMeRouter };
