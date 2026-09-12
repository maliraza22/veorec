// Media processors (docs/09). T-701: `probe` — the first worker to touch every
// source. Establishes the facts (client metadata is never trusted), applies
// the post-probe entitlement check (the authoritative duration check) and
// fans out the derived jobs by dedupe key. Later tasks add transcode (T-702),
// thumbnail (T-703), audio_extract/captions (T-704), hls (T-705).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { TransientError, TerminalError } = require('../errors');

const REASON = 'T-701 media worker: probe facts, post-probe entitlement, fan-out';
const DURATION_GRACE_SEC = 30;                 // docs/16 §3 "+30 s server grace"
const HLS_MIN_DURATION_SEC = 300;              // docs/09 §5: > 5 min
const HLS_MIN_HEIGHT = 1081;                   // or > 1080p

/** Scratch dir per job (docs/09 §9), always removed by the caller's finally. */
function scratchDir(jobId) {
  const dir = path.join(os.tmpdir(), 'veorec-scratch', String(jobId).replace(/[^A-Za-z0-9_-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Disk guard (docs/09 §9): refuse when free scratch < 2× source size. */
function scratchHasRoom(dir, needBytes) {
  try {
    if (typeof fs.statfsSync !== 'function') return true;
    const st = fs.statfsSync(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    return !(Number.isFinite(free) && free < 2 * needBytes);
  } catch { return true; }
}

async function download(storage, key, dest) {
  try {
    const obj = await storage.getObject(key);
    await pipeline(obj.body, fs.createWriteStream(dest));
  } catch (e) {
    if (e && e.code === 'object_not_found') throw new TerminalError('source_missing', 'The source object is missing from storage.');
    throw new TransientError('storage_unavailable', `download failed: ${e.message}`);
  }
}

function registerMediaProcessors(registry) {
  // ── media.probe ─────────────────────────────────────────────────────────
  registry.register('probe', async ({ payload, job, signal, logger, deps, repositories }) => {
    const repos = repositories();
    const { storage, withTransaction, prober, resolveLimits } = deps;
    if (!prober) throw new TransientError('prober_unavailable', 'No prober (ffprobe) configured on this worker.');
    if (!storage) throw new TransientError('storage_unavailable', 'No storage provider configured on this worker.');
    const recordingId = job.recordingId || (payload && payload.recordingId);
    if (!recordingId) throw new TerminalError('invalid_payload', 'probe needs a recordingId');
    const recording = await repos.recordings.getSystem(recordingId, REASON);
    if (!recording || recording.deletedAt) throw new TerminalError('recording_gone', 'The recording no longer exists.');

    const failRecording = async (code, message) => {
      await repos.recordings.updateSystem(recordingId, { status: 'failed', failureCode: 'probe_invalid' }, REASON);
      logger.error({ recording_id: recordingId, code, reason: message }, 'probe: source invalid — recording failed(probe_invalid)');
      throw new TerminalError('probe_invalid', `${code}: ${message}`);
    };

    const assets = await repos.assets.listByRecordingSystem(recordingId, REASON);
    const source = assets.find((a) => a.kind === 'source');
    if (!source) return failRecording('no_source', 'the recording has no source asset');

    // Facts about the object itself, before any bytes move.
    let head;
    try { head = await storage.headObject(source.storageKey); }
    catch (e) {
      if (e && e.code === 'object_not_found') return failRecording('source_missing', 'the source object is missing from storage');
      throw new TransientError('storage_unavailable', `head failed: ${e.message}`);
    }
    const dir = scratchDir(job.id);
    const inPath = path.join(dir, `source${path.extname(source.storageKey) || ''}`);
    let facts, verdict;
    try {
      if (!scratchHasRoom(dir, Number(head.contentLength || 0))) throw new TransientError('scratch_full', 'not enough scratch space (need 2× source size)');
      await download(storage, source.storageKey, inPath);
      facts = await prober.probeFile(inPath, { signal });
      // The size the completion recorded (recordings.size_bytes = real stored size) must match what we downloaded.
      verdict = prober.validate(facts, { expectedSize: recording.sizeBytes != null ? Number(recording.sizeBytes) : null });
    } catch (e) {
      if (e && e.code === 'aborted') throw new TransientError('aborted', 'probe aborted');
      if (e && e.code === 'timeout') throw new TransientError('probe_timeout', e.message);
      if (e && e.code === 'ENOENT') throw new TransientError('ffprobe_missing', `ffprobe/ffmpeg not found (${e.message})`);
      throw e;
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ }
    }
    if (!verdict.ok) return failRecording(verdict.code, verdict.message);

    // Facts in one transaction: recording + source asset (docs/09 §2.4).
    const width = facts.video.width, height = facts.video.height, duration = facts.durationSec;
    await withTransaction(async (tx) => {
      const patch = { duration: String(duration), width, height, sizeBytes: facts.sizeBytes };
      // uploaded → processing; a re-probe of a ready recording keeps it ready.
      if (recording.status === 'uploaded' || recording.status === 'failed' || recording.status === 'rejected_limit') patch.status = 'processing';
      if (recording.status === 'failed' || recording.status === 'rejected_limit') patch.failureCode = null;
      await tx.recordings.updateSystem(recordingId, patch, REASON);
      await tx.assets.updateSystem(source.id, {
        status: 'ready', sizeBytes: facts.sizeBytes, width, height, duration: String(duration),
        codecVideo: facts.video.codec, codecAudio: facts.audio ? facts.audio.codec : null, container: facts.container,
      }, REASON);
    });

    // Post-probe entitlement (docs/09 §2.5, docs/16 §3): the authoritative
    // duration check, +30 s grace. Over the limit → rejected_limit with the
    // 7-day grace before purge (upgrade rescues via reprocess).
    let limits = null;
    if (resolveLimits) {
      const user = await repos.users.findById(recording.userId);
      const subscription = await repos.subscriptions.getForUser({ userId: recording.userId });
      limits = await resolveLimits({ user, subscription });
    }
    const maxSec = limits && Number.isFinite(Number(limits.maxRecordingDurationSeconds)) ? Number(limits.maxRecordingDurationSeconds) : null;
    if (maxSec != null && duration > maxSec + DURATION_GRACE_SEC) {
      await repos.recordings.updateSystem(recordingId, { status: 'rejected_limit', failureCode: 'recording_limit' }, REASON);
      logger.warn({ recording_id: recordingId, duration_sec: duration, limit_sec: maxSec, plan: limits.planSlug }, 'probe: over the plan duration limit — rejected_limit (7-day grace)');
      return { valid: true, rejected: 'recording_limit', duration, width, height, container: facts.container, limitSec: maxSec, fanout: [] };
    }

    // Fan-out (docs/09 §2.6): idempotent by dedupe key; HLS only when it earns its keep.
    const wantHls = duration > HLS_MIN_DURATION_SEC || height >= HLS_MIN_HEIGHT || width > 1920;
    const fanout = [
      { queue: 'transcode', dedupeKey: `transcode:${recordingId}:mp4`, payload: { recordingId, sourceAssetId: source.id, variant: 'mp4' }, maxAttempts: 3 },
      { queue: 'thumbnail', dedupeKey: `thumb:${recordingId}`, payload: { recordingId, sourceAssetId: source.id }, maxAttempts: 3 },
      { queue: 'audio_extract', dedupeKey: `audio:${recordingId}`, payload: { recordingId, sourceAssetId: source.id }, maxAttempts: 3 },
      ...(wantHls ? [{ queue: 'hls', dedupeKey: `hls:${recordingId}`, payload: { recordingId, sourceAssetId: source.id }, maxAttempts: 3 }] : []),
    ];
    const enqueued = [];
    await withTransaction(async (tx) => {
      for (const f of fanout) {
        const { job: row, created } = await tx.jobs.enqueue({ ...f, recordingId });
        // A re-probe re-runs settled derived jobs against the (same) facts.
        if (!created && ['completed', 'failed', 'cancelled'].includes(row.status)) await tx.jobs.requeueSystem(row.id, REASON, { resetAttempts: true, fromStatuses: ['completed', 'failed', 'cancelled'] });
        enqueued.push({ queue: f.queue, jobId: row.id, created });
      }
    });
    logger.info({ recording_id: recordingId, duration_sec: duration, width, height, container: facts.container, video_codec: facts.video.codec, audio_codec: facts.audio && facts.audio.codec, duration_source: facts.durationSource, hls: wantHls }, 'probe: facts recorded, derived jobs fanned out');
    return {
      valid: true, rejected: null, duration, width, height, fps: facts.video.fps, container: facts.container,
      videoCodec: facts.video.codec, audioCodec: facts.audio ? facts.audio.codec : null, sizeBytes: facts.sizeBytes,
      durationSource: facts.durationSource, hls: wantHls, fanout: enqueued,
    };
  });

  return registry;
}

module.exports = { registerMediaProcessors, scratchDir, scratchHasRoom, DURATION_GRACE_SEC, HLS_MIN_DURATION_SEC, HLS_MIN_HEIGHT, REASON };
