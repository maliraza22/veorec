// /api/v1/admin/jobs — processing-job triage (T-601, docs/08 §15, docs/10 §5).
//
// The `failed` rows of processing_jobs ARE the dead-letter queue. This router
// lists them (or any status) and retries one: the row goes back to `queued`
// with attempts reset and `enqueued_at` cleared, and the worker's outbox relay
// hands it to the transport on its next pass. The API never touches Redis —
// PostgreSQL is the record, the queue is transport (docs/10 §1) — so a retry
// works even while Redis is down; it simply runs when the relay can reach it.
//
// Admin identity stays the legacy allowlist (ADMIN_EMAILS via server/index.js
// isAdmin) supplied as a predicate, so this router knows nothing about how
// admins are decided (T-1302 replaces the resolver, not this contract).
'use strict';

const express = require('express');
const { errorHandler, badRequest, forbidden, notFound, conflict } = require('./errors');

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const STATUSES = ['queued', 'active', 'completed', 'failed', 'cancelled'];
const REASON = 'T-601 admin job triage: list processing_jobs / retry a failed job';
const MAX_LIMIT = 500;

/** Wire projection: never the payload (it carries storage keys) — docs/17 §5. */
function project(row) {
  return {
    id: row.id, queue: row.queue, recordingId: row.recordingId || null, dedupeKey: row.dedupeKey,
    status: row.status, attempts: row.attempts, maxAttempts: row.maxAttempts,
    lastError: row.lastError || null, result: row.result === undefined ? null : row.result,
    enqueuedAt: row.enqueuedAt || null, startedAt: row.startedAt || null, finishedAt: row.finishedAt || null,
    createdAt: row.createdAt || null, updatedAt: row.updatedAt || null,
  };
}

/**
 * @param {object} deps
 * @param {() => object} deps.repositories
 * @param {Function} deps.requireAuth        legacy auth middleware (sets req.userId)
 * @param {(req) => boolean} deps.isAdmin    admin predicate for the authenticated caller
 * @param {object} [deps.logger]
 */
function createAdminJobsRouter({ repositories, requireAuth, isAdmin, logger = console }) {
  if (typeof isAdmin !== 'function') throw new Error('createAdminJobsRouter: isAdmin(req) is required');
  const router = express.Router();
  // Scoped to /admin: routers share the /api/v1 mount, so an unscoped `use`
  // would gate every sibling route (recordings, uploads) behind the allowlist.
  router.use('/admin', requireAuth);
  router.use('/admin', (req, res, next) => {
    if (!isAdmin(req)) return next(forbidden('admin_only', 'Admin only'));
    return next();
  });

  router.get('/admin/jobs', asyncRoute(async (req, res) => {
    const status = req.query.status === undefined ? 'failed' : String(req.query.status);
    if (!STATUSES.includes(status)) throw badRequest('invalid_request', `status must be one of ${STATUSES.join(', ')}`);
    let limit = 100;
    if (req.query.limit !== undefined) {
      if (!/^[0-9]{1,4}$/.test(String(req.query.limit))) throw badRequest('invalid_request', 'limit must be a positive integer');
      limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit)));
    }
    const queue = req.query.queue === undefined ? null : String(req.query.queue);
    const rows = await repositories().jobs.listSystem({ status, queue, limit }, REASON);
    res.set('Cache-Control', 'no-store');
    return res.json({ jobs: rows.map(project), status, count: rows.length });
  }));

  router.post('/admin/jobs/:id/retry', asyncRoute(async (req, res) => {
    const repos = repositories();
    const row = await repos.jobs.getSystem(String(req.params.id), REASON);
    if (!row) throw notFound('job_not_found', 'Job not found');
    if (row.status !== 'failed') throw conflict('invalid_state', `Only failed jobs can be retried (job is ${row.status})`);
    const job = await repos.jobs.requeueSystem(row.id, REASON, { resetAttempts: true, fromStatuses: ['failed'] });
    if (!job) throw conflict('invalid_state', 'Job changed state before it could be retried');
    logger.info({ job_id: job.id, queue: job.queue, recording_id: job.recordingId || undefined, admin_user_id: req.userId }, 'T-601: admin retried a failed job');
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, job: project(job) });
  }));

  router.use(errorHandler(logger));
  return router;
}

module.exports = { createAdminJobsRouter, project, STATUSES };
