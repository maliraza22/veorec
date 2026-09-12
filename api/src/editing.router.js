// /api/v1 editing (T-1201, docs/08 §11, docs/14 §1–§4)
//
//   POST  /recordings/:id/edit-sessions       {timeline?} → 201 {editSessionId, …} (draft)
//   GET   /edit-sessions/:id                  the session + its op log
//   PATCH /edit-sessions/:id                  {timeline, op?} → updated (op appended to the log)
//   POST  /edit-sessions/:id/discard          → {ok}
//   POST  /edit-sessions/:id/render           {mode:'overwrite'|'copy'} → 202 {renderJobId, outputRecordingId?}
//   GET   /render-jobs/:id                    {status, progress, outputRecordingId?, error?}
//   POST  /recordings/:id/remove-silences     → 202 {jobId}  (silence_detect job → virtual edit)
//   GET   /recordings/:id/remove-silences     → {jobId, status, result?, error?} (the editor polls)
//   POST  /recordings/stitch                  {ids[2..10], title?} → 202 {editSessionId, renderJobId, outputRecordingId}
//
// An edit session is an EDIT DECISION LIST over immutable sources: timeline
// changes are instant (client-side preview); the expensive render happens
// only on explicit render/export. A render never touches a source object.
// Every referenced recording must be OWNED and `ready`; clip bounds are
// validated against the PROBED duration. Multi-clip renders are Pro
// (`clipStitchEnabled`); a copy render takes the same atomic quota reservation
// as an upload at enqueue time (docs/16 §4.3), reconciled by the worker.
'use strict';

const express = require('express');
const { errorHandler, badRequest, forbidden, notFound, conflict } = require('./errors');
const { createIdentityBridge, scopeOf } = require('./identity');
const { paywall, recordPaywall } = require('./paywall');

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const REASON = 'T-1201 editing API: sessions, ops and render enqueue (the worker renders)';
const MAX_CLIPS = 40;
const MIN_CLIP_SEC = 0.1;
const BOUND_TOLERANCE_SEC = 0.05;
const RENDER_RESERVATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SETTLED = ['completed', 'failed', 'cancelled'];
const MODES = new Set(['overwrite', 'copy']);
const ms = (d) => (d ? new Date(d).getTime() : null);

const wireSession = (s, ops = null) => ({
  editSessionId: s.id, id: s.id, recordingId: s.recordingId, status: s.status, mode: s.mode ?? null,
  timeline: Array.isArray(s.timeline) ? s.timeline : [], created_at: ms(s.createdAt), updated_at: ms(s.updatedAt),
  ...(ops ? { ops: ops.map((o) => ({ idx: o.idx, op: o.op, at: ms(o.createdAt) })) } : {}),
});
const wireRenderJob = (j) => ({
  renderJobId: j.id, id: j.id, editSessionId: j.editSessionId, status: j.status,
  progress: j.status === 'done' ? 100 : (j.progress ?? 0), error: j.error ?? null,
  outputRecordingId: j.outputRecordingId ?? null, mode: j.session ? j.session.mode : null,
  created_at: ms(j.createdAt), updated_at: ms(j.updatedAt),
});

/**
 * Validate a timeline against the owner's recordings.
 * @returns {Promise<{timeline: Array<{recordingId,start,end}>, recordings: Map, durationSec: number, multiSource: boolean}>}
 */
async function validateTimeline(repos, scope, baseRecordingId, raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw badRequest('invalid_request', 'timeline must be a non-empty array of clips.');
  if (raw.length > MAX_CLIPS) throw badRequest('invalid_request', `timeline may hold at most ${MAX_CLIPS} clips.`);
  const clips = raw.map((c, i) => {
    if (!c || typeof c !== 'object') throw badRequest('invalid_request', `clip ${i} must be an object.`);
    const recordingId = typeof c.recordingId === 'string' ? c.recordingId : (typeof c.id === 'string' ? c.id : null);
    const start = Number(c.start), end = Number(c.end);
    if (!recordingId) throw badRequest('invalid_request', `clip ${i} needs a recordingId.`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < MIN_CLIP_SEC) throw badRequest('invalid_request', `clip ${i} needs 0 ≤ start < end (at least ${MIN_CLIP_SEC} s).`);
    return { recordingId, start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 };
  });
  const recordings = new Map();
  for (const id of new Set(clips.map((c) => c.recordingId))) {
    const r = await repos.recordings.get(scope, id);
    if (!r) throw notFound('recording_not_found', id === baseRecordingId ? 'Recording not found' : 'One of the clips was not found.');
    if (r.status !== 'ready') throw conflict('recording_not_ready', `"${r.title}" is still processing and cannot be edited yet.`);
    if (r.duration == null) throw conflict('recording_not_ready', `"${r.title}" has no probed duration yet.`);
    recordings.set(id, r);
  }
  for (const c of clips) {
    const dur = Number(recordings.get(c.recordingId).duration);
    if (c.end > dur + BOUND_TOLERANCE_SEC) throw badRequest('invalid_request', `clip on ${c.recordingId} ends at ${c.end} s but the video is ${dur} s long.`);
    if (c.end > dur) c.end = dur;
  }
  const durationSec = Math.round(clips.reduce((s, c) => s + (c.end - c.start), 0) * 1000) / 1000;
  return { timeline: clips, recordings, durationSec, multiSource: clips.some((c) => c.recordingId !== baseRecordingId) };
}

/**
 * @param {object} deps
 * @param {() => object} deps.repositories
 * @param {Function} deps.withTransaction
 * @param {Function} deps.requireAuth
 * @param {object} [deps.quota]           createQuota() — the copy-render reservation (optional in the T-301 seam)
 * @param {object} [deps.entitlements]    { isFeatureEnabled(feature, ctx), canRecordDuration?(sec, ctx) → {allowed, code?, message?, meta?} }
 * @param {object} [deps.logger]
 */
function createEditingRouter({ repositories, withTransaction, requireAuth, quota = null, entitlements = { isFeatureEnabled: async () => false }, logger = console }) {
  const router = express.Router();
  for (const p of ['/recordings', '/edit-sessions', '/render-jobs']) {
    router.use(p, requireAuth);
    router.use(p, createIdentityBridge({ repositories, logger }));
  }

  async function mustGetSession(repos, scope, id) {
    const s = await repos.editSessions.get(scope, id);
    if (!s) throw notFound('edit_session_not_found', 'Edit session not found');
    return s;
  }
  async function enqueueOrRequeue(tx, { queue, dedupeKey, recordingId, payload, maxAttempts }) {
    const { job, created } = await tx.jobs.enqueue({ queue, dedupeKey, recordingId, payload, maxAttempts });
    if (created || !SETTLED.includes(job.status)) return { job, reused: !created };
    const again = await tx.jobs.requeueSystem(job.id, REASON, { resetAttempts: true, fromStatuses: SETTLED });
    return { job: again || job, reused: false };
  }

  // ── POST /recordings/:id/edit-sessions ─────────────────────────────────
  router.post('/recordings/:id/edit-sessions', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const base = await repos.recordings.get(scope, req.params.id);
    if (!base) throw notFound('recording_not_found', 'Recording not found');
    const raw = req.body && req.body.timeline !== undefined ? req.body.timeline : [{ recordingId: base.id, start: 0, end: Number(base.duration) || 0 }];
    const { timeline } = await validateTimeline(repos, scope, base.id, raw);
    const session = await repos.editSessions.create(scope, { recordingId: base.id, timeline });
    return res.status(201).json(wireSession(session, []));
  }));

  // ── GET /edit-sessions/:id ─────────────────────────────────────────────
  router.get('/edit-sessions/:id', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const session = await mustGetSession(repos, scope, req.params.id);
    const ops = await repos.editSessions.listOps(scope, session.id);
    res.set('Cache-Control', 'no-store');
    return res.json(wireSession(session, ops));
  }));

  // ── PATCH /edit-sessions/:id {timeline, op?} ───────────────────────────
  router.patch('/edit-sessions/:id', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const session = await mustGetSession(repos, scope, req.params.id);
    if (session.status !== 'draft') throw conflict('invalid_state', `An edit session in status '${session.status}' cannot be changed.`);
    const body = req.body || {};
    if (body.timeline === undefined) throw badRequest('invalid_request', 'timeline is required (the materialised state after the op).');
    const { timeline } = await validateTimeline(repos, scope, session.recordingId, body.timeline);
    const updated = await withTransaction(async (tx) => {
      const row = await tx.editSessions.updateTimeline(scope, session.id, timeline);
      if (body.op !== undefined && body.op !== null) {
        if (typeof body.op !== 'object' || typeof body.op.type !== 'string') throw badRequest('invalid_request', 'op must be an object with a type.');
        await tx.editSessions.appendOp(scope, session.id, body.op);
      }
      return row;
    });
    return res.json(wireSession(updated));
  }));

  // ── POST /edit-sessions/:id/discard ────────────────────────────────────
  router.post('/edit-sessions/:id/discard', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const session = await mustGetSession(repos, scope, req.params.id);
    if (session.status === 'rendering') throw conflict('invalid_state', 'A rendering session cannot be discarded until the render finishes.');
    if (session.status !== 'discarded') await repos.editSessions.setStatus(scope, session.id, 'discarded');
    return res.json({ ok: true });
  }));

  /** Enqueue a render for a draft session (shared by /render and /stitch). */
  async function enqueueRender(req, repos, scope, session, mode, { title = null } = {}) {
    if (!MODES.has(mode)) throw badRequest('invalid_request', "mode must be 'overwrite' or 'copy'.");
    if (session.status !== 'draft') throw conflict('invalid_state', `An edit session in status '${session.status}' cannot be rendered.`);
    const base = await repos.recordings.get(scope, session.recordingId);
    if (!base) throw notFound('recording_not_found', 'Recording not found');
    const { timeline, recordings, durationSec, multiSource } = await validateTimeline(repos, scope, base.id, session.timeline);
    if (await repos.editSessions.findRenderingForRecording(scope, base.id)) throw conflict('render_in_progress', 'Another render of this recording is already in progress.');
    if (multiSource) {
      const on = await entitlements.isFeatureEnabled('clipStitchEnabled', { repos, scope, req, recording: base });
      if (!on) throw await paywall(repos, { userId: req.pgUserId, recordingId: base.id, feature: 'clipStitch', message: 'Combining clips is a Pro feature. Upgrade to unlock it.' }, logger);
    }
    if (typeof entitlements.canRecordDuration === 'function') {
      const v = await entitlements.canRecordDuration(durationSec, { repos, scope, req, recording: base });
      if (v && v.allowed === false) {
        await recordPaywall(repos, { userId: req.pgUserId, recordingId: base.id, feature: 'recordingLimit', meta: { durationSec, ...(v.meta || {}) } }, logger);
        throw forbidden(v.code || 'recording_limit', v.message || 'This edit is longer than your plan allows.', { upgradeRequired: true, meta: v.meta });
      }
    }
    // Estimated output bytes for the copy reservation: the base's bytes/second over the timeline, +20 %, ≥ 1 MiB.
    const baseBytes = Number(base.sizeBytes) || 0, baseDur = Number(base.duration) || 1;
    const estimateBytes = Math.max(1024 * 1024, Math.ceil((baseBytes / baseDur) * durationSec * 1.2));
    const limits = quota && mode === 'copy' ? await quota.resolveLimits(req) : null;
    const expiresAt = new Date(Date.now() + RENDER_RESERVATION_TTL_MS);
    try {
      return await withTransaction(async (tx) => {
        let outputRecordingId = null;
        if (mode === 'copy') {
          const out = await tx.recordings.create(scope, {
            title: title || `${base.title} (edited)`, sourceKind: 'render', status: 'processing',
            folderId: base.folderId ?? null, privacy: base.privacy,
          });
          outputRecordingId = out.id;
        }
        await tx.editSessions.setStatus(scope, session.id, 'rendering', { mode });
        const renderJob = await tx.renderJobs.create(scope, { editSessionId: session.id, outputRecordingId });
        if (mode === 'copy' && quota) {
          // The estimate is both the ceiling and the declared size: a render's
          // output is bounded, so the plan's minimum-start floor does not apply.
          const { reserveBytes } = await quota.reserve({ tx, scope, limits, expiresAt, maxBytes: estimateBytes, declaredBytes: estimateBytes });
          await tx.uploads.createReservation(scope, { renderJobId: renderJob.id, reservedBytes: reserveBytes, reservedSlots: 1, expiresAt });
        }
        const { job } = await enqueueOrRequeue(tx, {
          queue: 'render', dedupeKey: `render:${session.id}:${renderJob.id}`, recordingId: base.id,
          payload: { editSessionId: session.id, renderJobId: renderJob.id, mode, outputRecordingId, timeline, durationSec, canvasFrom: base.id, sources: [...recordings.keys()] },
          maxAttempts: 2,
        });
        await tx.renderJobs.updateSystem(renderJob.id, { processingJobId: job.id }, REASON);
        return { renderJob, job, outputRecordingId, durationSec, multiSource };
      });
    } catch (err) {
      // Every plan-limit refusal is a conversion fact (T-1003), recorded after the rolled-back transaction.
      const feature = err && (err.code === 'video_limit' ? 'videoLimit' : err.code === 'storage_limit' ? 'storageLimit' : null);
      if (feature) await recordPaywall(repos, { userId: req.pgUserId, recordingId: base.id, feature, meta: err.meta || {} }, logger);
      if (err && err.code === 'conflict') throw conflict('render_in_progress', 'Another render of this recording is already in progress.');
      throw err;
    }
  }

  // ── POST /edit-sessions/:id/render ─────────────────────────────────────
  router.post('/edit-sessions/:id/render', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const session = await mustGetSession(repos, scope, req.params.id);
    const mode = req.body && req.body.mode;
    const out = await enqueueRender(req, repos, scope, session, mode);
    logger.info({ edit_session_id: session.id, render_job_id: out.renderJob.id, mode, multi_source: out.multiSource, request_id: req.id || null }, 'T-1201: render enqueued');
    res.set('Cache-Control', 'no-store');
    return res.status(202).json({ renderJobId: out.renderJob.id, jobId: out.job.id, editSessionId: session.id, mode, outputRecordingId: out.outputRecordingId, durationSec: out.durationSec });
  }));

  // ── GET /render-jobs/:id ───────────────────────────────────────────────
  router.get('/render-jobs/:id', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const job = await repos.renderJobs.get(scope, req.params.id);
    if (!job) throw notFound('render_job_not_found', 'Render job not found');
    res.set('Cache-Control', 'no-store');
    return res.json(wireRenderJob(job));
  }));

  // ── POST /recordings/:id/remove-silences → 202 ─────────────────────────
  router.post('/recordings/:id/remove-silences', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const recording = await repos.recordings.get(scope, req.params.id);
    if (!recording) throw notFound('recording_not_found', 'Recording not found');
    if (recording.status !== 'ready') throw conflict('recording_not_ready', 'Silences can be detected once the video is ready.');
    const out = await withTransaction((tx) => enqueueOrRequeue(tx, {
      queue: 'silence_detect', dedupeKey: `silence:${recording.id}`, recordingId: recording.id,
      payload: { recordingId: recording.id, pad: 0.2, minGap: 0.8 }, maxAttempts: 2,
    }));
    res.set('Cache-Control', 'no-store');
    return res.status(202).json({ jobId: out.job.id, status: out.reused ? out.job.status : 'queued', reused: out.reused });
  }));

  // ── GET /recordings/:id/remove-silences — the latest detection's status ───
  // The editor / watch page poll this after the 202: a queued/active job, or
  // the completed job's result ({segments, keptSeconds, removedSeconds,
  // method}), or the failure reason. 404 until a detection was requested.
  router.get('/recordings/:id/remove-silences', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const recording = await repos.recordings.get(scope, req.params.id);
    if (!recording) throw notFound('recording_not_found', 'Recording not found');
    const job = await repos.jobs.findByDedupeKey(`silence:${recording.id}`);
    if (!job) throw notFound('job_not_found', 'No silence detection has been requested for this recording.');
    res.set('Cache-Control', 'no-store');
    const result = job.status === 'completed' && job.result && Array.isArray(job.result.segments) ? job.result : null;
    return res.json({
      jobId: job.id, status: job.status, attempts: job.attempts,
      result: result ? { segments: result.segments, keptSeconds: result.keptSeconds, removedSeconds: result.removedSeconds, method: result.method } : null,
      error: job.status === 'failed' ? (job.lastError || 'Silence detection failed.') : null,
    });
  }));

  // ── POST /recordings/stitch → 202 (sugar over edit-sessions) ────────────
  router.post('/recordings/stitch', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.filter((v) => typeof v === 'string') : [];
    if (ids.length < 2 || ids.length > 10) throw badRequest('invalid_request', 'Pick between two and ten videos to combine.');
    const title = req.body && typeof req.body.title === 'string' ? req.body.title.trim().slice(0, 200) : '';
    const recs = new Map();
    for (const id of new Set(ids)) {
      const r = await repos.recordings.get(scope, id);
      if (!r) throw notFound('recording_not_found', 'One of the selected videos was not found.');
      recs.set(id, r);
    }
    const timeline = ids.map((id) => ({ recordingId: id, start: 0, end: Number(recs.get(id).duration) || 0 }));
    await validateTimeline(repos, scope, ids[0], timeline);
    const session = await repos.editSessions.create(scope, { recordingId: ids[0], timeline });
    const out = await enqueueRender(req, repos, scope, session, 'copy', { title: title || 'Combined recording' });
    res.set('Cache-Control', 'no-store');
    return res.status(202).json({ editSessionId: session.id, renderJobId: out.renderJob.id, jobId: out.job.id, outputRecordingId: out.outputRecordingId, durationSec: out.durationSec });
  }));

  router.use(errorHandler(logger));
  return router;
}

module.exports = { createEditingRouter, validateTimeline, MAX_CLIPS };
