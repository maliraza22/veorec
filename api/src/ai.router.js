// /api/v1 transcription & AI (T-603, docs/08 §12, docs/15 §7)
//
// Every trigger is ASYNC: the API writes the transcript/job rows and answers
// 202 {jobId}; the worker does the work; clients poll GET /recordings/:id/
// transcript or /status. No transcription ever runs in this process.
//
// Gates are paywalls (403 feature_locked + upgradeRequired), never silent
// no-ops; 501 transcription_unconfigured when no provider exists; a
// recording the caller does not own is 404, indistinguishable from missing.
'use strict';

const express = require('express');
const { errorHandler, badRequest, forbidden, notFound, conflict, ApiError } = require('./errors');
const { createIdentityBridge, scopeOf } = require('./identity');

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const REASON = 'T-603 API: transcription/AI triggers (rows only; the worker runs the jobs)';
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,8})?$/;
const TRANSCRIBABLE = new Set(['uploaded', 'processing', 'ready']);
const SETTLED = ['completed', 'failed', 'cancelled'];

function transcriptBody(t, segments, configured) {
  const status = t ? t.status : 'none';
  return {
    status,
    configured: !!configured,
    language: t && status === 'done' ? t.language : null,
    text: t && status === 'done' ? (t.text || '') : '',
    segments: (segments || []).map((s) => ({ idx: s.idx, start: Number(s.startS), end: Number(s.endS), text: s.text, language: s.language })),
    source: t && status === 'done' ? t.source : null,
    spokenLang: t ? (t.spokenLangOverride || '') : '',
    error: t && status === 'failed' ? t.error : null,
    note: t && status === 'done' && !(segments && segments.length) ? 'no_speech' : null,
    createdAt: t ? t.createdAt : null,
    updatedAt: t ? t.updatedAt : null,
  };
}

/**
 * @param {object} deps
 * @param {() => object} deps.repositories
 * @param {Function} deps.withTransaction
 * @param {Function} deps.requireAuth
 * @param {object} deps.entitlements     { isFeatureEnabled(feature, { repos, scope, recording, req }) }
 * @param {() => boolean} [deps.configured]  is an STT provider configured (docs/15 §1)
 * @param {object} [deps.logger]
 */
function createAiRouter({ repositories, withTransaction, requireAuth, entitlements, configured = () => false, logger = console }) {
  if (!entitlements || typeof entitlements.isFeatureEnabled !== 'function') throw new Error('createAiRouter: entitlements.isFeatureEnabled is required');
  const router = express.Router();
  router.use(requireAuth);
  router.use(createIdentityBridge({ repositories, logger }));

  async function mustGet(repos, scope, id) {
    const r = await repos.recordings.get(scope, id);
    if (!r) throw notFound('recording_not_found', 'Recording not found');
    return r;
  }
  async function gate(feature, ctx) {
    const on = await entitlements.isFeatureEnabled(feature, ctx);
    if (!on) throw forbidden('feature_locked', `${feature === 'aiDocsEnabled' ? 'AI summaries, chapters & translation are' : 'AI transcription is'} a Pro feature. Upgrade to unlock it.`, { upgradeRequired: true, details: { feature } });
  }

  /** Create-or-requeue the logical job for a dedupe key. Returns the row. */
  async function enqueueOrRequeue(tx, { queue, dedupeKey, recordingId, payload, maxAttempts = 3 }) {
    const { job, created } = await tx.jobs.enqueue({ queue, dedupeKey, recordingId, payload, maxAttempts });
    if (created || !SETTLED.includes(job.status)) return { job, created, reused: !created };
    // A settled row for the same logical job: run it again (attempts reset).
    const again = await tx.jobs.requeueSystem(job.id, REASON, { resetAttempts: true, fromStatuses: SETTLED });
    return { job: again || job, created: false, reused: false };
  }

  // ── POST /recordings/:id/transcribe → 202 ──────────────────────────────
  router.post('/recordings/:id/transcribe', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const recording = await mustGet(repos, scope, req.params.id);
    await gate('transcriptionEnabled', { repos, scope, recording, req });
    if (!configured()) throw new ApiError(501, 'transcription_unconfigured', 'Transcription is not available on this server yet.');
    const language = req.body && req.body.language !== undefined && req.body.language !== null && req.body.language !== '' ? String(req.body.language).trim() : '';
    if (language && !LANG_RE.test(language)) throw badRequest('invalid_request', 'language must be an ISO-639-1 code (e.g. "ur")');
    if (!TRANSCRIBABLE.has(recording.status)) throw conflict('not_transcribable', `A recording can be transcribed once its media has landed (status is ${recording.status}).`);
    const assets = await repos.assets.listForRecording(scope, recording.id);
    if (!assets.some((a) => (a.kind === 'source' || a.kind === 'audio') && a.status === 'ready')) throw conflict('not_transcribable', 'The recording has no media to transcribe yet.');
    const aiDocs = await entitlements.isFeatureEnabled('aiDocsEnabled', { repos, scope, recording, req });

    const out = await withTransaction(async (tx) => {
      const r = await enqueueOrRequeue(tx, {
        queue: 'transcribe', dedupeKey: `stt:${recording.id}`, recordingId: recording.id,
        payload: { recordingId: recording.id, language, trigger: 'manual', aiDocs: !!aiDocs },
      });
      if (!r.reused) {
        await tx.transcripts.upsertSystem(recording.id, { status: 'queued', spokenLangOverride: language || null, error: null }, REASON);
        await tx.recordings.updateSystem(recording.id, { aiStatus: 'queued' }, REASON);
      }
      return r;
    });
    logger.info({ recording_id: recording.id, job_id: out.job.id, reused: out.reused, language: language || undefined }, 'T-603: transcription requested');
    res.set('Cache-Control', 'no-store');
    return res.status(202).json({ jobId: out.job.id, status: out.reused ? out.job.status : 'queued', transcript: { status: out.reused ? undefined : 'queued' }, reused: out.reused });
  }));

  // ── DELETE /recordings/:id/transcribe (idempotent) ─────────────────────
  router.delete('/recordings/:id/transcribe', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const recording = await mustGet(repos, scope, req.params.id);
    const removed = await repos.transcripts.deleteForRecordingSystem(recording.id, REASON);
    return res.json({ ok: true, removed });
  }));

  // ── GET /recordings/:id/transcript ─────────────────────────────────────
  router.get('/recordings/:id/transcript', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const recording = await mustGet(repos, scope, req.params.id);
    const t = await repos.transcripts.getForRecording(scope, recording.id);
    const segments = t && t.status === 'done' ? await repos.transcripts.listSegments(t.id) : [];
    res.set('Cache-Control', 'no-store');
    return res.json(transcriptBody(t, segments, configured()));
  }));

  // ── POST /recordings/:id/transcript/translate → cached | 202 ───────────
  router.post('/recordings/:id/transcript/translate', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const recording = await mustGet(repos, scope, req.params.id);
    await gate('aiDocsEnabled', { repos, scope, recording, req });
    const lang = req.body && typeof req.body.lang === 'string' ? req.body.lang.trim() : '';
    if (!LANG_RE.test(lang)) throw badRequest('invalid_request', 'lang must be a language code (e.g. "es")');
    const t = await repos.transcripts.getForRecording(scope, recording.id);
    if (!t || t.status !== 'done') throw conflict('transcript_required', 'Generate a transcript first.');
    const cached = await repos.transcripts.getTranslation(t.id, lang);
    res.set('Cache-Control', 'no-store');
    if (cached) return res.json({ status: 'done', lang, segments: cached.segments, cached: true });
    const out = await withTransaction((tx) => enqueueOrRequeue(tx, {
      queue: 'translate', dedupeKey: `translate:${recording.id}:${lang}`, recordingId: recording.id,
      payload: { recordingId: recording.id, lang, trigger: 'manual' }, maxAttempts: 2,
    }));
    return res.status(202).json({ jobId: out.job.id, status: 'queued', lang });
  }));

  // ── AI triggers → 202 ──────────────────────────────────────────────────
  const aiTrigger = (route, type, feature) => router.post(route, asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const recording = await mustGet(repos, scope, req.params.id);
    await gate(feature, { repos, scope, recording, req });
    const t = await repos.transcripts.getForRecording(scope, recording.id);
    if (!t || t.status !== 'done') throw conflict('transcript_required', 'Generate a transcript first.');
    const out = await withTransaction(async (tx) => {
      const r = await enqueueOrRequeue(tx, { queue: type, dedupeKey: `${type}:${recording.id}`, recordingId: recording.id, payload: { recordingId: recording.id, trigger: 'manual' }, maxAttempts: 2 });
      if (!r.reused) await tx.recordings.updateSystem(recording.id, { aiStatus: 'queued' }, REASON);
      return r;
    });
    res.set('Cache-Control', 'no-store');
    return res.status(202).json({ jobId: out.job.id, status: out.reused ? out.job.status : 'queued', reused: out.reused });
  }));
  aiTrigger('/recordings/:id/title/auto', 'ai_title', 'transcriptionEnabled');
  aiTrigger('/recordings/:id/summary', 'ai_summary', 'aiDocsEnabled');
  aiTrigger('/recordings/:id/chapters', 'ai_chapters', 'aiDocsEnabled');

  // ── POST /recordings/:id/reprocess (docs/08 §5, T-703) ─────────────────
  // Re-runs the media pipeline from the probe: the probe re-establishes the
  // facts, re-applies the entitlement (an upgrade rescues a rejected_limit
  // recording) and requeues the derived jobs — dedupe keys prevent doubles.
  const REPROCESSABLE = new Set(['uploaded', 'processing', 'ready', 'failed', 'rejected_limit']);
  router.post('/recordings/:id/reprocess', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const recording = await mustGet(repos, scope, req.params.id);
    if (!REPROCESSABLE.has(recording.status)) throw conflict('not_reprocessable', `A recording can be reprocessed once its media has landed (status is ${recording.status}).`);
    const assets = await repos.assets.listForRecording(scope, recording.id);
    if (!assets.some((a) => a.kind === 'source')) throw conflict('not_reprocessable', 'The recording has no source media.');
    const out = await withTransaction((tx) => enqueueOrRequeue(tx, {
      queue: 'probe', dedupeKey: `probe:${recording.id}`, recordingId: recording.id,
      payload: { recordingId: recording.id, trigger: 'reprocess' }, maxAttempts: 5,
    }));
    logger.info({ recording_id: recording.id, job_id: out.job.id, reused: out.reused, status: recording.status }, 'T-703: reprocess requested');
    res.set('Cache-Control', 'no-store');
    return res.status(202).json({ ok: true, jobId: out.job.id, status: out.reused ? out.job.status : 'queued', reused: out.reused });
  }));

  // ── GET /recordings/:id/status (docs/08 §5) ────────────────────────────
  router.get('/recordings/:id/status', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const recording = await mustGet(repos, scope, req.params.id);
    const [jobs, assets, t] = await Promise.all([
      repos.jobs.listForRecording(scope, recording.id),
      repos.assets.listForRecording(scope, recording.id),
      repos.transcripts.getForRecording(scope, recording.id),
    ]);
    res.set('Cache-Control', 'no-store');
    return res.json({
      status: recording.status,
      failureCode: recording.failureCode ?? null,
      aiStatus: recording.aiStatus,
      jobs: jobs.map((j) => ({ id: j.id, queue: j.queue, status: j.status, attempts: j.attempts, progress: j.result && typeof j.result.progress === 'number' ? j.result.progress : null, error: j.status === 'failed' ? (j.lastError || null) : null })),
      assets: assets.map((a) => ({ kind: a.kind, variant: a.variant ?? null, status: a.status })),
      transcript: { status: t ? t.status : 'none' },
    });
  }));

  router.use(errorHandler(logger));
  return router;
}

module.exports = { createAiRouter, transcriptBody, LANG_RE };
