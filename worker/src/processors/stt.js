// STT / AI processors (T-603, docs/15, docs/10 §3): stt.transcribe, the
// stt.translate cache, and the ai.title / ai.summary / ai.chapters chain.
//
// Invariant #14: nothing here touches recordings.status. A transcript failure
// lands in transcripts.status + recordings.ai_status and the video stays
// playable. Every processor is idempotent: the transcript row is one-per-
// recording (upsert), segments are replaced atomically, AI fields are plain
// overwrites guarded by the DEFAULT_TITLES rule.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { TransientError, TerminalError } = require('../errors');
const { generateTitle: heuristicTitle } = require('../stt/transcription');

const REASON = 'T-603 stt/ai worker: transcript + AI fields';
const DEFAULT_TITLES = new Set(['screen recording', 'untitled recording', '']);   // never overwrite a user-set title
const AI_TYPES = ['ai_title', 'ai_summary', 'ai_chapters'];

const isDefaultTitle = (t) => DEFAULT_TITLES.has(String(t || '').trim().toLowerCase());

/**
 * ai_status aggregate: done once no ai/transcribe job for the recording is
 * still queued/active. The CALLING job is still `active` while its handler
 * runs (the runner marks it completed afterwards), so it excludes itself.
 */
async function settleAiStatus(repos, recordingId, { failed = false, excludeJobId = null } = {}) {
  if (failed) { await repos.recordings.updateSystem(recordingId, { aiStatus: 'failed' }, REASON); return 'failed'; }
  const jobs = await repos.jobs.listByRecordingSystem(recordingId, REASON);
  const pending = jobs.some((j) => j.id !== excludeJobId && ['transcribe', ...AI_TYPES].includes(j.queue) && (j.status === 'queued' || j.status === 'active'));
  const status = pending ? 'running' : 'done';
  await repos.recordings.updateSystem(recordingId, { aiStatus: status }, REASON);
  return status;
}

// Runs AFTER the job row is marked (registry onSettled), so the finishing job
// never sees itself as still active — the last job of a chain always lands on
// 'done'; a terminal failure lands on 'failed' (docs/15 §7).
const AI_SETTLE = {
  async onSettled({ status, job, repositories }) {
    const recordingId = (job.payload && job.payload.recordingId) || job.recordingId;
    if (!recordingId) return;
    await settleAiStatus(repositories(), recordingId, { failed: status === 'failed' });
  },
};

async function loadDoneTranscript(repos, recordingId) {
  const t = await repos.transcripts.getForPublicWatch(recordingId);
  if (!t || t.status !== 'done') throw new TerminalError('transcript_required', 'This recording has no completed transcript yet.');
  const segs = await repos.transcripts.listSegments(t.id);
  return { transcript: t, segments: segs.map((s) => ({ idx: s.idx, start: Number(s.startS), end: Number(s.endS), text: s.text, language: s.language })) };
}

/**
 * @param {object} registry
 * @param {object} deps
 * @param {object} [deps.transcriber]  from stt/transcription createTranscriber()
 * @param {object} [deps.ai]           from stt/ai createAi()
 */
function registerSttProcessors(registry) {
  // ── stt.transcribe ──────────────────────────────────────────────────────
  registry.register('transcribe', async ({ payload, job, signal, logger, deps, repositories }) => {
    const repos = repositories();
    const { transcriber, storage, withTransaction } = deps;
    const recordingId = payload.recordingId || job.recordingId;
    if (!recordingId) throw new TerminalError('invalid_payload', 'transcribe needs a recordingId');
    const recording = await repos.recordings.getSystem(recordingId, REASON);
    if (!recording || recording.deletedAt) throw new TerminalError('recording_gone', 'The recording no longer exists.');
    if (!transcriber || !transcriber.isConfigured()) {
      await repos.transcripts.upsertSystem(recordingId, { status: 'failed', error: 'transcription_unconfigured', spokenLangOverride: payload.language || null }, REASON);
      await settleAiStatus(repos, recordingId, { failed: true });
      throw new TerminalError('transcription_unconfigured', 'No transcription provider is configured on this worker.');
    }
    if (!storage) throw new TransientError('storage_unavailable', 'No storage provider configured on this worker.');

    // The STT input: the extracted audio asset when the media pipeline made
    // one (docs/09 §6), otherwise the immutable source — ffmpeg reads both.
    const assets = await repos.assets.listByRecordingSystem(recordingId, REASON);
    const input = assets.find((a) => a.kind === 'audio' && a.status === 'ready') || assets.find((a) => a.kind === 'source' && a.status === 'ready');
    if (!input) {
      await repos.transcripts.upsertSystem(recordingId, { status: 'failed', error: 'no_source', spokenLangOverride: payload.language || null }, REASON);
      await settleAiStatus(repos, recordingId, { failed: true });
      throw new TerminalError('no_source', 'The recording has no media to transcribe yet.');
    }

    const language = payload.language || recording.spokenLangOverride || '';
    await repos.transcripts.upsertSystem(recordingId, { status: 'running', spokenLangOverride: language || null }, REASON);
    await repos.recordings.updateSystem(recordingId, { aiStatus: 'running' }, REASON);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'veorec-stt-in-'));
    const inPath = path.join(tmp, 'input');
    let result;
    try {
      try {
        const obj = await storage.getObject(input.storageKey);
        await pipeline(obj.body, fs.createWriteStream(inPath));
      } catch (e) {
        if (e && e.code === 'object_not_found') throw new TerminalError('no_source', 'The source object is missing from storage.');
        throw new TransientError('storage_unavailable', `download failed: ${e.message}`);
      }
      result = await transcriber.transcribeFile(inPath, { language, signal });
    } catch (e) {
      if (e && e.code === 'aborted') { await repos.transcripts.upsertSystem(recordingId, { status: 'queued', spokenLangOverride: language || null }, REASON); throw new TransientError('aborted', 'transcription aborted'); }
      const terminal = e && e.retryable === false;
      // Between job attempts the transcript is visibly 'queued' again; a terminal
      // failure is 'failed' with its code (docs/15 §7).
      await repos.transcripts.upsertSystem(recordingId, { status: terminal ? 'failed' : 'queued', error: terminal ? (e.code || e.message) : null, spokenLangOverride: language || null }, REASON);
      if (terminal) await settleAiStatus(repos, recordingId, { failed: true });
      throw e;
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* scratch */ }
    }

    const noSpeech = !result.segments.length;
    await withTransaction(async (tx) => {
      const t = await tx.transcripts.upsertSystem(recordingId, {
        status: 'done', language: result.language || null, text: result.text || '', source: result.source,
        spokenLangOverride: language || null, error: null,
      }, REASON);
      await tx.transcripts.replaceSegmentsSystem(t.id, result.segments.map((s, i) => ({ idx: i, start: s.start, end: s.end, text: s.text, language: s.language || result.language || null })), REASON);
      // Chain (docs/15 §6): title always; summary + chapters when the user has
      // AI docs (decided by the API at enqueue time — the worker has no plan store).
      if (payload.chain !== false && !noSpeech) {
        await tx.jobs.enqueue({ queue: 'ai_title', dedupeKey: `ai_title:${recordingId}`, recordingId, payload: { recordingId, trigger: payload.trigger || 'auto' }, maxAttempts: 2 });
        if (payload.aiDocs) {
          await tx.jobs.enqueue({ queue: 'ai_summary', dedupeKey: `ai_summary:${recordingId}`, recordingId, payload: { recordingId, trigger: payload.trigger || 'auto' }, maxAttempts: 2 });
          await tx.jobs.enqueue({ queue: 'ai_chapters', dedupeKey: `ai_chapters:${recordingId}`, recordingId, payload: { recordingId, trigger: payload.trigger || 'auto' }, maxAttempts: 2 });
        }
      }
    });
    // A chained job that already ran once (completed row) must run again for
    // the NEW transcript: requeue settled chain rows.
    if (payload.chain !== false && !noSpeech) {
      for (const type of AI_TYPES) {
        const row = await repos.jobs.findByDedupeKey(`${type}:${recordingId}`);
        if (row && ['completed', 'failed', 'cancelled'].includes(row.status)) await repos.jobs.requeueSystem(row.id, REASON, { resetAttempts: true, fromStatuses: ['completed', 'failed', 'cancelled'] });
      }
    }
    logger.info({ recording_id: recordingId, segments: result.segments.length, language: result.language, source: result.source, no_speech: noSpeech, ...result.stats }, 'transcript stored');
    return { segments: result.segments.length, language: result.language, source: result.source, note: noSpeech ? 'no_speech' : null, stats: result.stats };
  }, AI_SETTLE);

  // ── stt.translate (cached) ──────────────────────────────────────────────
  registry.register('translate', async ({ payload, job, signal, logger, deps, repositories }) => {
    const repos = repositories();
    const recordingId = payload.recordingId || job.recordingId;
    const lang = String(payload.lang || '').trim();
    if (!recordingId || !lang) throw new TerminalError('invalid_payload', 'translate needs recordingId and lang');
    const { transcript, segments } = await loadDoneTranscript(repos, recordingId);
    const cached = await repos.transcripts.getTranslation(transcript.id, lang);
    if (cached) return { lang, segments: cached.segments.length, cached: true };
    if (!deps.ai || !deps.ai.isLLMConfigured()) throw new TerminalError('no_llm', 'Translation needs the AI key (set GROQ_API_KEY).');
    let translated;
    try { translated = await deps.ai.translateSegments(segments, lang, { signal }); }
    catch (e) { if (e && e.retryable === false) throw new TerminalError(e.code || 'no_llm', e.message); throw new TransientError(e.code || 'llm_error', e.message); }
    await repos.transcripts.putTranslationSystem(transcript.id, lang, translated, REASON);
    logger.info({ recording_id: recordingId, lang, segments: translated.length }, 'translation cached');
    return { lang, segments: translated.length, cached: false };
  });

  // ── ai.title ────────────────────────────────────────────────────────────
  registry.register('ai_title', async ({ payload, job, signal, logger, deps, repositories }) => {
    const repos = repositories();
    const recordingId = payload.recordingId || job.recordingId;
    const recording = await repos.recordings.getSystem(recordingId, REASON);
    if (!recording || recording.deletedAt) throw new TerminalError('recording_gone', 'The recording no longer exists.');
    let out = { title: null, skipped: null };
    try {
      const { transcript } = await loadDoneTranscript(repos, recordingId);
      const manual = payload.trigger === 'manual';
      if (!manual && !isDefaultTitle(recording.title)) {
        out.skipped = 'user_set_title';                       // DEFAULT_TITLES guard (docs/15 §6)
      } else {
        let title = null;
        if (deps.ai) { try { title = await deps.ai.generateTitle(transcript.text, recording.description, { signal }); } catch (e) { if (e && e.code === 'aborted') throw e; } }
        if (!title) title = heuristicTitle(transcript.text);
        if (title) { await repos.recordings.updateSystem(recordingId, { title }, REASON); out.title = title; }
        else out.skipped = 'no_title_derivable';
      }
    } catch (e) {
      if (e && e.retryable === false) { await settleAiStatus(repos, recordingId, { failed: payload.trigger === 'manual' }); throw e; }
      throw e;
    }
    logger.info({ recording_id: recordingId, ...out }, 'ai_title finished');
    return out;
  }, AI_SETTLE);

  // ── ai.summary ──────────────────────────────────────────────────────────
  registry.register('ai_summary', async ({ payload, job, signal, logger, deps, repositories }) => {
    const repos = repositories();
    const recordingId = payload.recordingId || job.recordingId;
    const recording = await repos.recordings.getSystem(recordingId, REASON);
    if (!recording || recording.deletedAt) throw new TerminalError('recording_gone', 'The recording no longer exists.');
    let summary = null;
    try {
      const { transcript } = await loadDoneTranscript(repos, recordingId);
      if (deps.ai) summary = await deps.ai.summarize(transcript.text, { signal });
      if (summary) await repos.recordings.updateSystem(recordingId, { description: summary }, REASON);
    } catch (e) {
      if (e && e.retryable === false) { await settleAiStatus(repos, recordingId, { failed: payload.trigger === 'manual' }); }
      throw e;
    }
    logger.info({ recording_id: recordingId, summary: !!summary }, 'ai_summary finished');
    return { summary: !!summary };
  }, AI_SETTLE);

  // ── ai.chapters ─────────────────────────────────────────────────────────
  registry.register('ai_chapters', async ({ payload, job, signal, logger, deps, repositories }) => {
    const repos = repositories();
    const recordingId = payload.recordingId || job.recordingId;
    const recording = await repos.recordings.getSystem(recordingId, REASON);
    if (!recording || recording.deletedAt) throw new TerminalError('recording_gone', 'The recording no longer exists.');
    let chapters = [];
    try {
      const { segments } = await loadDoneTranscript(repos, recordingId);
      if (deps.ai) chapters = await deps.ai.generateChapters(segments, { signal });
      if (chapters && chapters.length) await repos.recordings.updateSystem(recordingId, { chapters }, REASON);
    } catch (e) {
      if (e && e.retryable === false) { await settleAiStatus(repos, recordingId, { failed: payload.trigger === 'manual' }); }
      throw e;
    }
    logger.info({ recording_id: recordingId, chapters: chapters.length }, 'ai_chapters finished');
    return { chapters: chapters.length };
  }, AI_SETTLE);

  return registry;
}

module.exports = { registerSttProcessors, settleAiStatus, isDefaultTitle, DEFAULT_TITLES, AI_TYPES, REASON };
