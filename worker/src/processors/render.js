// Editing processors (T-1202 / T-1203 / T-1204, docs/14 §5, §7, docs/10 §3):
//
//   render          {editSessionId, renderJobId, mode, timeline, outputRecordingId}
//                   → bakes the timeline (stream copy when possible, else a
//                     re-encode on the base's canvas), verifies, publishes:
//                     copy      → the output becomes the NEW recording's immutable
//                                 source (quota reconciled against the render's
//                                 reservation) and the normal pipeline is fanned
//                                 out from a probe job → MP4/poster/HLS → ready
//                     overwrite → the recording's active MP4 is re-pointed at the
//                                 output, facts updated, virtual edits cleared,
//                                 stale derived assets dropped (their objects are
//                                 orphans for the weekly cleanup); the source is
//                                 never touched
//   silence_detect  {recordingId, pad, minGap} → ffmpeg silencedetect on the
//                   audio asset (else the source), keep-ranges applied as a
//                   VIRTUAL edit (recordings.segments); transcript-gap fallback.
//
// Failures leave the draft session intact (docs/14 §8): render_jobs.failed +
// the session back to draft; sources untouched.
'use strict';

const fs = require('fs');
const path = require('path');
const { TransientError, TerminalError } = require('../errors');
const { scratchDir, scratchHasRoom, download } = require('./media');
const { keepRangesFromSilences, keepRangesFromTranscript } = require('../media/render');
const { run } = require('../media/exec');

const REASON = 'T-1202 render processor: bake an edit timeline and publish the output';
const S_REASON = 'T-1204 silence_detect processor: keep-ranges applied as a virtual edit';
const NOT_PROCESSABLE = new Set(['failed', 'rejected_limit', 'recording', 'uploading']);

/** ffmpeg silencedetect stderr → [{start, end}] (the transcription module's parser shape). */
function parseSilenceDetect(stderr) {
  const out = [];
  let start = null;
  for (const line of String(stderr || '').split(/\r?\n/)) {
    const s = /silence_start:\s*([0-9.]+)/.exec(line);
    const e = /silence_end:\s*([0-9.]+)/.exec(line);
    if (s) start = Number(s[1]);
    if (e && start !== null) { out.push({ start, end: Number(e[1]) }); start = null; }
  }
  return out;
}

function registerEditingProcessors(registry) {
  // ── render ──────────────────────────────────────────────────────────────
  registry.register('render', async ({ payload, job, signal, logger, deps, repositories }) => {
    const { storage, keys, renderer, prober, withTransaction } = deps;
    if (!storage || !keys || !renderer || !prober || !withTransaction) throw new TerminalError('misconfigured', 'render needs storage, keys, renderer, prober and withTransaction');
    const repos = repositories();
    const { editSessionId, renderJobId, mode } = payload || {};
    if (!editSessionId || !renderJobId || !['overwrite', 'copy'].includes(mode)) throw new TerminalError('invalid_payload', 'render needs editSessionId, renderJobId and a mode');
    const session = await repos.editSessions.getSystem(editSessionId, REASON);
    const renderJob = await repos.renderJobs.getSystem(renderJobId, REASON);
    if (!session || !renderJob) throw new TerminalError('render_source_missing', 'The edit session or render job no longer exists.');
    if (renderJob.status === 'done') return { skipped: 'already_done', renderJobId };
    const scope = { userId: session.userId };
    const base = await repos.recordings.getSystem(session.recordingId, REASON);
    const timeline = Array.isArray(payload.timeline) && payload.timeline.length ? payload.timeline : session.timeline;

    const fail = async (code, message) => {
      await repos.renderJobs.updateSystem(renderJobId, { status: 'failed', error: `${code}: ${message}`.slice(0, 1000) }, REASON);
      await repos.editSessions.setStatusSystem(editSessionId, 'draft', REASON);
      if (mode === 'copy' && renderJob.outputRecordingId) {
        // The pre-created output recording fails honestly; its reservation is released.
        await withTransaction(async (tx) => {
          await tx.recordings.updateSystem(renderJob.outputRecordingId, { status: 'failed', failureCode: code }, REASON).catch(() => {});
          await releaseRenderReservation(tx, scope, renderJobId, 'released');
        }).catch((e) => logger.warn({ err: e.message }, 'render: reservation release failed'));
      }
    };

    const refuse = async (code, message) => { await fail(code, message); throw new TerminalError(code, message); };
    if (session.status === 'discarded') await refuse('render_forbidden_clip', 'The edit session was discarded.');
    if (!base || base.deletedAt) await refuse('render_source_missing', 'The base recording is gone.');
    if (!Array.isArray(timeline) || !timeline.length) await refuse('render_forbidden_clip', 'Empty timeline.');

    await repos.renderJobs.updateSystem(renderJobId, { status: 'running', error: null }, REASON);
    const dir = scratchDir(job.id);
    try {
      // Resolve each distinct source to its best playable asset (normalised MP4, else the immutable source).
      const inputs = new Map();
      for (const id of new Set(timeline.map((c) => c.recordingId))) {
        const rec = id === base.id ? base : await repos.recordings.getSystem(id, REASON);
        if (!rec || rec.deletedAt || rec.userId !== session.userId) throw new TerminalError('render_forbidden_clip', `Clip ${id} is not the owner's or no longer exists.`);
        if (NOT_PROCESSABLE.has(rec.status)) throw new TerminalError('render_forbidden_clip', `Clip ${id} is not playable (${rec.status}).`);
        const assets = await repos.assets.listByRecordingSystem(id, REASON);
        const asset = assets.find((a) => a.kind === 'mp4' && a.variant === 'main' && a.status === 'ready') || assets.find((a) => a.kind === 'source' && a.status === 'ready');
        if (!asset) throw new TerminalError('render_source_missing', `Clip ${id} has no playable asset.`);
        let head;
        try { head = await storage.headObject(asset.storageKey); }
        catch (e) { if (e && e.code === 'object_not_found') throw new TerminalError('render_source_missing', `Clip ${id}: object missing from storage.`); throw new TransientError('storage_unavailable', e.message); }
        if (!scratchHasRoom(dir, Number(head.contentLength || 0) * 2)) throw new TransientError('render_disk_full', 'not enough scratch space for the render inputs and output');
        const local = path.join(dir, `in_${inputs.size}${path.extname(asset.storageKey) || '.mp4'}`);
        await download(storage, asset.storageKey, local);
        const facts = await prober.probeFile(local, { signal });
        if (facts.unreadable || !facts.video) throw new TerminalError('render_source_missing', `Clip ${id}: the media cannot be read.`);
        inputs.set(id, { rec, asset, path: local, facts });
      }
      const clips = timeline.map((c) => { const inp = inputs.get(c.recordingId); return { path: inp.path, in: Number(c.start), out: Math.min(Number(c.end), Number(inp.facts.durationSec) || Number(c.end)), hasAudio: !!inp.facts.audio }; });
      const canvas = renderer.planCanvas(inputs.get(base.id).facts);
      const durationSec = clips.reduce((s, c) => s + (c.out - c.in), 0);
      const outPath = path.join(dir, 'render.mp4');
      const timeoutMs = Math.max(15 * 60 * 1000, 4 * durationSec * 1000);
      let lastPersisted = -1;
      const result = await renderer.render({
        clips, outPath, canvas, dir, signal, timeoutMs,
        onProgress: (pct) => { if (pct - lastPersisted >= 5 || pct === 100) { lastPersisted = pct; repos.jobs.setProgressSystem(job.id, pct, REASON).catch(() => {}); } },
      });
      const size = fs.statSync(outPath).size;
      const facts = result.facts;

      if (mode === 'copy') {
        const outId = renderJob.outputRecordingId;
        if (!outId) throw new TerminalError('invalid_payload', 'copy render without an output recording');
        const key = keys.source(outId, 'mp4');
        try { await storage.putObject(key, fs.createReadStream(outPath), { contentType: 'video/mp4', contentLength: size }); }
        catch (e) { throw new TransientError('storage_unavailable', `upload failed: ${e.message}`); }
        const published = await withTransaction(async (tx) => {
          const source = await tx.assets.upsertSourceSystem({ recordingId: outId, kind: 'source', storageKey: key, status: 'ready', sizeBytes: size, width: facts.video.width, height: facts.video.height, duration: facts.durationSec, container: 'mp4', immutable: true, countsTowardQuota: true }, REASON);
          await tx.recordings.updateSystem(outId, { status: 'uploaded', duration: facts.durationSec, sizeBytes: size, width: facts.video.width, height: facts.video.height }, REASON);
          await reconcileRenderReservation(tx, scope, renderJobId, size);
          // The normal pipeline takes it from here (probe → transcode/thumbnail/hls → ready).
          await tx.jobs.enqueue({ queue: 'probe', dedupeKey: `probe:${outId}`, recordingId: outId, payload: { recordingId: outId, storageKey: key, trigger: 'render' }, maxAttempts: 5 });
          await tx.renderJobs.updateSystem(renderJobId, { status: 'done', outputAssetId: source.id, outputRecordingId: outId }, REASON);
          await tx.editSessions.setStatusSystem(editSessionId, 'applied', REASON);
          return { sourceAssetId: source.id };
        });
        logger.info({ render_job_id: renderJobId, output_recording_id: outId, strategy: result.strategy, size_bytes: size }, 'render: copy published');
        return { mode, strategy: result.strategy, outputRecordingId: outId, sourceAssetId: published.sourceAssetId, durationSec: facts.durationSec, sizeBytes: size, progress: 100 };
      }

      // overwrite: re-point the active MP4 at the rendered output.
      const key = keys.render(editSessionId, renderJobId);
      try { await storage.putObject(key, fs.createReadStream(outPath), { contentType: 'video/mp4', contentLength: size }); }
      catch (e) { throw new TransientError('storage_unavailable', `upload failed: ${e.message}`); }
      const published = await withTransaction(async (tx) => {
        const assets = await tx.assets.listByRecordingSystem(base.id, REASON);
        let mp4 = assets.find((a) => a.kind === 'mp4' && a.variant === 'main');
        const factsPatch = { sizeBytes: size, width: facts.video.width, height: facts.video.height, duration: facts.durationSec, codecVideo: facts.video.codec, codecAudio: facts.audio ? facts.audio.codec : null, container: 'mp4' };
        if (mp4) mp4 = await tx.assets.repointSystem(mp4.id, { storageKey: key, status: 'ready', createdByJobId: job.id, ...factsPatch }, REASON);
        else mp4 = await tx.assets.createSystem({ recordingId: base.id, kind: 'mp4', variant: 'main', storageKey: key, status: 'ready', immutable: false, countsTowardQuota: false, createdByJobId: job.id, ...factsPatch }, REASON);
        // Derived assets that no longer match the media: dropped (objects → orphan cleanup); HLS/captions/audio are re-made on demand.
        for (const a of assets) if (['hls', 'captions_vtt', 'audio'].includes(a.kind)) await tx.assets.deleteSystem(a.id, REASON);
        await tx.recordings.updateSystem(base.id, { duration: facts.durationSec, sizeBytes: size, width: facts.video.width, height: facts.video.height }, REASON);
        await tx.recordings.update(scope, base.id, { trimStart: null, trimEnd: null, segments: null });
        await tx.renderJobs.updateSystem(renderJobId, { status: 'done', outputAssetId: mp4.id, outputRecordingId: base.id }, REASON);
        await tx.editSessions.setStatusSystem(editSessionId, 'applied', REASON);
        return { mp4Id: mp4.id };
      });
      logger.info({ render_job_id: renderJobId, recording_id: base.id, strategy: result.strategy, size_bytes: size }, 'render: overwrite published');
      return { mode, strategy: result.strategy, outputRecordingId: base.id, mp4AssetId: published.mp4Id, durationSec: facts.durationSec, sizeBytes: size, progress: 100 };
    } catch (e) {
      if (e && e.code === 'aborted') throw new TransientError('aborted', 'render aborted');
      if (e && e.code === 'timeout') { await fail('render_timeout', e.message); throw new TerminalError('render_timeout', e.message); }
      if (e && (e.code === 'tool_failed' || e.code === 'ENOENT')) { await fail('render_ffmpeg_failed', e.message); throw new TerminalError('render_ffmpeg_failed', e.message, { stderrTail: e.stderrTail }); }
      if (e && e.code === 'output_invalid') { await fail('render_verify_failed', e.message); throw new TerminalError('render_verify_failed', e.message); }
      if (e instanceof TerminalError) { await fail(e.code, e.message); throw e; }
      if (e instanceof TransientError && job.attempts >= (job.maxAttempts || 2)) { await fail(e.code, e.message); }
      throw e;
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ }
    }
  }, { timeoutMs: 60 * 60 * 1000, concurrency: 1 });

  // ── silence_detect ──────────────────────────────────────────────────────
  registry.register('silence_detect', async ({ payload, job, signal, logger, deps, repositories }) => {
    const { storage, ffmpegBin } = deps;
    if (!storage || !ffmpegBin) throw new TerminalError('misconfigured', 'silence_detect needs storage and ffmpegBin');
    const repos = repositories();
    const recordingId = payload && payload.recordingId;
    const pad = Number(payload && payload.pad) || 0.2, minGap = Number(payload && payload.minGap) || 0.8;
    const recording = await repos.recordings.getSystem(recordingId, S_REASON);
    if (!recording || recording.deletedAt) throw new TerminalError('recording_gone', 'The recording no longer exists.');
    if (recording.status !== 'ready' || recording.duration == null) throw new TerminalError('recording_not_ready', 'The recording is not ready.');
    const assets = await repos.assets.listByRecordingSystem(recordingId, S_REASON);
    const input = assets.find((a) => a.kind === 'audio' && a.status === 'ready') || assets.find((a) => a.kind === 'mp4' && a.variant === 'main' && a.status === 'ready') || assets.find((a) => a.kind === 'source' && a.status === 'ready');
    if (!input) throw new TerminalError('source_missing', 'No media to analyse.');
    const dir = scratchDir(job.id);
    let ranges = null, method = 'audio';
    try {
      const local = path.join(dir, `in${path.extname(input.storageKey) || '.mp4'}`);
      await download(storage, input.storageKey, local);
      let stderr = '';
      try {
        const r = await run(ffmpegBin, ['-hide_banner', '-nostdin', '-i', local, '-vn', '-af', `silencedetect=noise=-30dB:d=${minGap}`, '-f', 'null', '-'], { signal, timeout: 10 * 60 * 1000 });
        stderr = (r && r.err) || '';
      } catch (e) {
        stderr = (e && e.stderrTail) || (e && e.stderr) || '';
        // A video-only file has nothing to analyse ("Output file does not contain any stream") → the transcript fallback.
        if (/does not contain any stream|matches no streams/i.test(stderr)) stderr = '';
        else if (!/silence_(start|end)/.test(stderr)) throw e;
      }
      const noAudio = stderr === '';
      const silences = noAudio ? [] : parseSilenceDetect(stderr);
      ranges = silences.length ? keepRangesFromSilences(silences, Number(recording.duration), { pad, minGap }) : null;
      if (!ranges || !ranges.length) {
        // No usable audio signal (or no silence in it) → the transcript's gaps (the legacy rule).
        const t = await repos.transcripts.getForPublicWatch(recordingId);
        const segs = t && t.status === 'done' ? await repos.transcripts.listSegments(t.id) : [];
        ranges = keepRangesFromTranscript(segs.map((s) => ({ start: Number(s.startS), end: Number(s.endS) })), Number(recording.duration), { pad, minGap });
        method = 'transcript';
        if ((!ranges || !ranges.length) && !noAudio) throw new TerminalError('no_silence', 'No significant silences found — nothing to trim.');
      }
    } catch (e) {
      if (e && e.code === 'aborted') throw new TransientError('aborted', 'silence detection aborted');
      if (e && (e.code === 'tool_failed' || e.code === 'ENOENT')) throw new TerminalError('silence_ffmpeg_failed', e.message);
      throw e;
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ }
    }
    if (!ranges || !ranges.length) throw new TerminalError('no_speech', 'No speech detected to trim silence around.');
    const duration = Number(recording.duration);
    const kept = ranges.reduce((a, r) => a + (r.end - r.start), 0);
    const removed = Math.max(0, duration - kept);
    if (removed < 1) throw new TerminalError('no_silence', 'No significant silences found — nothing to trim.');
    // Applied as a VIRTUAL edit (docs/14 §7): instant, reversible, no render.
    await repos.recordings.update({ userId: recording.userId }, recordingId, { segments: ranges, trimStart: null, trimEnd: null });
    logger.info({ recording_id: recordingId, method, ranges: ranges.length, removed_sec: Math.round(removed) }, 'silence_detect: virtual edit applied');
    return { segments: ranges, keptSeconds: Math.round(kept), removedSeconds: Math.round(removed), duration: Math.round(duration), method };
  }, { timeoutMs: 20 * 60 * 1000 });
}

/** The copy render's reservation → reconciled to the real output size (mirrors quota.reconcile for uploads). */
async function reconcileRenderReservation(tx, scope, renderJobId, sizeBytes) {
  const row = await tx.usage.getForUpdate(scope) || await tx.usage.ensure(scope);
  const reservation = await tx.uploads.findReservationByRenderJob(scope, renderJobId);
  const delta = { storageRetainedBytes: sizeBytes, activeVideoCount: 1 };
  if (reservation && reservation.status === 'held') {
    delta.storageReservedBytes = -Math.min(Number(reservation.reservedBytes), Number(row.storageReservedBytes || 0));
    delta.reservedVideoSlots = -Math.min(Number(reservation.reservedSlots || 1), Number(row.reservedVideoSlots || 0));
    await tx.uploads.settleReservation(scope, reservation.id, 'reconciled', { reconciledBytes: sizeBytes });
  }
  await tx.usage.applyDelta(scope, delta);
}

async function releaseRenderReservation(tx, scope, renderJobId, status) {
  const row = await tx.usage.getForUpdate(scope);
  if (!row) return;
  const reservation = await tx.uploads.findReservationByRenderJob(scope, renderJobId);
  if (!reservation || reservation.status !== 'held') return;
  await tx.uploads.settleReservation(scope, reservation.id, status);
  await tx.usage.applyDelta(scope, {
    storageReservedBytes: -Math.min(Number(reservation.reservedBytes), Number(row.storageReservedBytes || 0)),
    reservedVideoSlots: -Math.min(Number(reservation.reservedSlots || 1), Number(row.reservedVideoSlots || 0)),
  });
}

module.exports = { registerEditingProcessors, parseSilenceDetect, reconcileRenderReservation, releaseRenderReservation, REASON, S_REASON };
