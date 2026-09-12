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
const { maybeMarkReady } = require('../media/ready');
const { buildVtt, validateVtt } = require('../media/captions');
const { newId } = require(path.join(__dirname, '..', '..', '..', 'db', 'src', 'ids.js'));

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

  // ── media.transcode (T-702, docs/09 §3) ──────────────────────────────────
  const T_REASON = 'T-702 media worker: transcode MP4 + maybe_mark_ready';
  const NOT_PROCESSABLE = new Set(['failed', 'rejected_limit', 'recording', 'uploading']);
  registry.register('transcode', async ({ payload, job, signal, logger, deps, repositories }) => {
    const repos = repositories();
    const { storage, withTransaction, transcoder, prober, keys } = deps;
    if (!transcoder || !prober) throw new TransientError('transcoder_unavailable', 'No transcoder (ffmpeg) configured on this worker.');
    if (!storage || !keys) throw new TransientError('storage_unavailable', 'No storage provider / key builder configured on this worker.');
    const recordingId = job.recordingId || (payload && payload.recordingId);
    if (!recordingId) throw new TerminalError('invalid_payload', 'transcode needs a recordingId');
    const recording = await repos.recordings.getSystem(recordingId, T_REASON);
    if (!recording || recording.deletedAt) throw new TerminalError('recording_gone', 'The recording no longer exists.');
    if (NOT_PROCESSABLE.has(recording.status)) throw new TerminalError('recording_not_processable', `The recording is ${recording.status}.`);
    const assets = await repos.assets.listByRecordingSystem(recordingId, T_REASON);
    const source = assets.find((a) => a.kind === 'source' && a.status === 'ready');
    if (!source) throw new TerminalError('no_source', 'The recording has no ready source asset.');
    if (recording.duration == null || !source.codecVideo) throw new TerminalError('probe_required', 'The source has not been probed yet (facts missing).');

    // Check-before-do (docs/10 §1): a ready MP4 whose object exists is done.
    let mp4 = assets.find((a) => a.kind === 'mp4' && a.variant === 'main');
    if (mp4 && mp4.status === 'ready' && !(payload && payload.force)) {
      const exists = await storage.objectExists(mp4.storageKey).catch(() => false);
      if (exists) {
        const ready = await withTransaction((tx) => maybeMarkReady({ tx, recordingId, logger }));
        logger.info({ recording_id: recordingId, asset_id: mp4.id, promoted: ready.promoted }, 'transcode: MP4 already ready — skipped');
        return { skipped: 'already_ready', assetId: mp4.id, ready };
      }
    }
    // The asset row owns the output key (asset-id-scoped: a re-run overwrites its own output).
    if (!mp4) {
      const id = newId('asset');
      mp4 = await repos.assets.createSystem({
        id, recordingId, kind: 'mp4', variant: 'main', storageKey: keys.derivedVideo(recordingId, id),
        status: 'pending', immutable: false, countsTowardQuota: false, createdByJobId: job.id, container: 'mp4',
      }, T_REASON);
    } else if (mp4.status !== 'pending') {
      await repos.assets.updateSystem(mp4.id, { status: 'pending', createdByJobId: job.id }, T_REASON);
    }

    const dir = scratchDir(job.id);
    const inPath = path.join(dir, `source${path.extname(source.storageKey) || ''}`);
    const outPath = path.join(dir, 'video.mp4');
    let verified, uploaded;
    try {
      let head;
      try { head = await storage.headObject(source.storageKey); }
      catch (e) { if (e && e.code === 'object_not_found') throw new TerminalError('source_missing', 'The source object is missing from storage.'); throw new TransientError('storage_unavailable', `head failed: ${e.message}`); }
      if (!scratchHasRoom(dir, Number(head.contentLength || 0))) throw new TransientError('scratch_full', 'not enough scratch space (need 2× source size)');
      await download(storage, source.storageKey, inPath);
      const sourceFacts = { durationSec: Number(recording.duration), audio: source.codecAudio ? { codec: source.codecAudio } : null, video: { codec: source.codecVideo, width: source.width, height: source.height } };
      const timeoutMs = Math.max(10 * 60 * 1000, 3 * Number(recording.duration) * 1000);
      let lastPersisted = -1;
      verified = await transcoder.transcodeToMp4(inPath, outPath, {
        sourceFacts, signal, timeoutMs,
        onProgress: (pct) => { if (pct - lastPersisted >= 5 || pct === 100) { lastPersisted = pct; repos.jobs.setProgressSystem(job.id, pct, T_REASON).catch(() => {}); } },
      });
      const size = fs.statSync(outPath).size;
      try {
        uploaded = await storage.putObject(mp4.storageKey, fs.createReadStream(outPath), { contentType: 'video/mp4', contentLength: size });
      } catch (e) { throw new TransientError('storage_unavailable', `upload failed: ${e.message}`); }
      uploaded.size = size;
    } catch (e) {
      if (e && e.code === 'aborted') throw new TransientError('aborted', 'transcode aborted');
      if (e && e.code === 'timeout') throw new TransientError('transcode_timeout', e.message);
      if (e && e.code === 'ENOENT') throw new TransientError('ffmpeg_missing', `ffmpeg not found (${e.message})`);
      if (e && e.code === 'tool_failed') throw new TransientError('ffmpeg_failed', e.message, { stderrTail: e.stderrTail });
      if (e && e.code === 'output_invalid') throw new TransientError('output_invalid', e.message);
      throw e;
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ }
    }

    // Publish + promote in ONE transaction (docs/10 §6): the row flips ready
    // only after verification and upload; maybe_mark_ready runs under the lock.
    const f = verified.facts;
    const ready = await withTransaction(async (tx) => {
      await tx.assets.updateSystem(mp4.id, {
        status: 'ready', sizeBytes: uploaded.size, width: f.video.width, height: f.video.height, duration: String(f.durationSec),
        codecVideo: 'h264', codecAudio: f.audio ? f.audio.codec : null, container: 'mp4', checksum: uploaded.etag || null, createdByJobId: job.id,
      }, T_REASON);
      return maybeMarkReady({ tx, recordingId, logger });
    });
    logger.info({ recording_id: recordingId, asset_id: mp4.id, size_bytes: uploaded.size, width: f.video.width, height: f.video.height, duration_sec: f.durationSec, promoted: ready.promoted, ready_reason: ready.reason }, 'transcode: MP4 published');
    return { assetId: mp4.id, storageKey: mp4.storageKey, sizeBytes: uploaded.size, width: f.video.width, height: f.video.height, duration: f.durationSec, audio: !!f.audio, progress: 100, ready };
  }, {
    // Attempts exhausted → the recording is failed(transcode_failed); the
    // source remains, so an admin/user retry (reprocess) can try again.
    async onSettled({ status, job, repositories, logger }) {
      if (status !== 'failed') return;
      const repos = repositories();
      const recordingId = job.recordingId || (job.payload && job.payload.recordingId);
      if (!recordingId) return;
      const r = await repos.recordings.getSystem(recordingId, T_REASON);
      if (!r || r.deletedAt || r.status === 'ready' || r.status === 'rejected_limit') return;
      await repos.recordings.updateSystem(recordingId, { status: 'failed', failureCode: 'transcode_failed' }, T_REASON);
      if (logger) logger.error({ recording_id: recordingId, job_id: job.id }, 'transcode: attempts exhausted — recording failed(transcode_failed), source kept');
    },
  });

  // ── media.thumbnail (T-703, docs/09 §4) ──────────────────────────────────
  const TH_REASON = 'T-703 media worker: poster / thumbnail / preview + maybe_mark_ready';
  const IMAGE_ROWS = [
    { key: 'poster', kind: 'poster', variant: null, imageKind: 'poster', contentType: 'image/jpeg', container: 'jpg' },
    { key: 'posterPlay', kind: 'poster', variant: 'play', imageKind: 'poster', contentType: 'image/jpeg', container: 'jpg' },
    { key: 'thumb', kind: 'thumbnail', variant: null, imageKind: 'thumb', contentType: 'image/jpeg', container: 'jpg' },
    { key: 'preview', kind: 'preview_gif', variant: null, imageKind: 'preview_webp', contentType: 'image/webp', container: 'webp' },
  ];
  registry.register('thumbnail', async ({ payload, job, signal, logger, deps, repositories }) => {
    const repos = repositories();
    const { storage, withTransaction, thumbnailer, keys } = deps;
    if (!thumbnailer) throw new TransientError('thumbnailer_unavailable', 'No thumbnailer (ffmpeg) configured on this worker.');
    if (!storage || !keys) throw new TransientError('storage_unavailable', 'No storage provider / key builder configured on this worker.');
    const recordingId = job.recordingId || (payload && payload.recordingId);
    if (!recordingId) throw new TerminalError('invalid_payload', 'thumbnail needs a recordingId');
    const recording = await repos.recordings.getSystem(recordingId, TH_REASON);
    if (!recording || recording.deletedAt) throw new TerminalError('recording_gone', 'The recording no longer exists.');
    if (NOT_PROCESSABLE.has(recording.status)) throw new TerminalError('recording_not_processable', `The recording is ${recording.status}.`);
    const assets = await repos.assets.listByRecordingSystem(recordingId, TH_REASON);
    const source = assets.find((a) => a.kind === 'source' && a.status === 'ready');
    if (!source) throw new TerminalError('no_source', 'The recording has no ready source asset.');
    if (recording.duration == null || !source.codecVideo) throw new TerminalError('probe_required', 'The source has not been probed yet (facts missing).');

    // One row per PRODUCED image (find-or-create, asset-id-scoped key); a
    // custom uploaded thumbnail (variant='custom') is a separate row and is
    // never touched here. A clip under 10 s simply gets no preview row.
    const rows = {};
    const rowFor = async (spec) => {
      let row = assets.find((a) => a.kind === spec.kind && (a.variant || null) === spec.variant);
      if (!row) {
        const id = newId('asset');
        row = await repos.assets.createSystem({ id, recordingId, kind: spec.kind, variant: spec.variant, storageKey: keys.image(recordingId, id, spec.imageKind), status: 'pending', immutable: false, countsTowardQuota: false, container: spec.container, createdByJobId: job.id }, TH_REASON);
      }
      rows[spec.key] = row;
      return row;
    };

    const dir = scratchDir(job.id);
    const inPath = path.join(dir, `source${path.extname(source.storageKey) || ''}`);
    let out;
    const uploaded = {};
    try {
      let head;
      try { head = await storage.headObject(source.storageKey); }
      catch (e) { if (e && e.code === 'object_not_found') throw new TerminalError('source_missing', 'The source object is missing from storage.'); throw new TransientError('storage_unavailable', `head failed: ${e.message}`); }
      if (!scratchHasRoom(dir, Number(head.contentLength || 0))) throw new TransientError('scratch_full', 'not enough scratch space (need 2× source size)');
      await download(storage, source.storageKey, inPath);
      out = await thumbnailer.generateAll(inPath, dir, { durationSec: Number(recording.duration), signal });
      for (const spec of IMAGE_ROWS) {
        const img = out[spec.key];
        if (!img) continue;                                     // no preview under 10 s
        await rowFor(spec);
        try {
          const size = fs.statSync(img.path).size;
          const r = await storage.putObject(rows[spec.key].storageKey, fs.createReadStream(img.path), { contentType: spec.contentType, contentLength: size });
          uploaded[spec.key] = { size, etag: r.etag, width: img.width, height: img.height };
        } catch (e) { throw new TransientError('storage_unavailable', `upload failed: ${e.message}`); }
      }
    } catch (e) {
      if (e && e.code === 'aborted') throw new TransientError('aborted', 'thumbnail aborted');
      if (e && e.code === 'timeout') throw new TransientError('thumbnail_timeout', e.message);
      if (e && e.code === 'ENOENT') throw new TransientError('ffmpeg_missing', `ffmpeg not found (${e.message})`);
      if (e && e.code === 'tool_failed') throw new TransientError('ffmpeg_failed', e.message, { stderrTail: e.stderrTail });
      if (e && e.code === 'output_invalid') throw new TransientError('output_invalid', e.message);
      throw e;
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ }
    }

    const ready = await withTransaction(async (tx) => {
      for (const spec of IMAGE_ROWS) {
        const up = uploaded[spec.key];
        if (up) await tx.assets.updateSystem(rows[spec.key].id, { status: 'ready', sizeBytes: up.size, width: up.width || null, height: up.height || null, container: spec.container, checksum: up.etag || null, createdByJobId: job.id }, TH_REASON);
      }
      return maybeMarkReady({ tx, recordingId, logger });
    });
    const produced = IMAGE_ROWS.filter((s) => uploaded[s.key]).map((s) => ({ kind: s.kind, variant: s.variant, id: rows[s.key].id }));
    logger.info({ recording_id: recordingId, poster_t: out.time.t, poster_luma: out.time.luma, dark: out.time.dark, preview: !!out.preview, promoted: ready.promoted, ready_reason: ready.reason }, 'thumbnail: images published');
    return { time: out.time, assets: produced, preview: !!out.preview, ready };
  }, {
    // Attempts exhausted: the poster is a placeholder (docs/09 §4) — promote
    // if the MP4 is already there, otherwise transcode will promote later.
    async onSettled({ status, job, repositories, deps, logger }) {
      if (status !== 'failed' || !deps || !deps.withTransaction) return;
      const recordingId = job.recordingId || (job.payload && job.payload.recordingId);
      if (!recordingId) return;
      const ready = await deps.withTransaction((tx) => maybeMarkReady({ tx, recordingId, logger }));
      if (logger) logger.warn({ recording_id: recordingId, job_id: job.id, promoted: ready.promoted, reason: ready.reason }, 'thumbnail: attempts exhausted — placeholder poster path');
    },
  });

  // ── media.audio_extract (T-704, docs/09 §6) ──────────────────────────────
  const AX_REASON = 'T-704 media worker: audio extract (STT input)';
  registry.register('audio_extract', async ({ payload, job, signal, logger, deps, repositories }) => {
    const repos = repositories();
    const { storage, withTransaction, audioExtractor, keys } = deps;
    if (!audioExtractor) throw new TransientError('extractor_unavailable', 'No audio extractor (ffmpeg) configured on this worker.');
    if (!storage || !keys) throw new TransientError('storage_unavailable', 'No storage provider / key builder configured on this worker.');
    const recordingId = job.recordingId || (payload && payload.recordingId);
    if (!recordingId) throw new TerminalError('invalid_payload', 'audio_extract needs a recordingId');
    const recording = await repos.recordings.getSystem(recordingId, AX_REASON);
    if (!recording || recording.deletedAt) throw new TerminalError('recording_gone', 'The recording no longer exists.');
    if (NOT_PROCESSABLE.has(recording.status)) throw new TerminalError('recording_not_processable', `The recording is ${recording.status}.`);
    const assets = await repos.assets.listByRecordingSystem(recordingId, AX_REASON);
    const source = assets.find((a) => a.kind === 'source' && a.status === 'ready');
    if (!source) throw new TerminalError('no_source', 'The recording has no ready source asset.');
    if (recording.duration == null || !source.codecVideo) throw new TerminalError('probe_required', 'The source has not been probed yet (facts missing).');
    if (!source.codecAudio) {
      logger.info({ recording_id: recordingId }, 'audio_extract: video-only source — nothing to extract');
      return { skipped: 'no_audio' };
    }
    let audio = assets.find((a) => a.kind === 'audio');
    if (!audio) audio = await repos.assets.createSystem({ recordingId, kind: 'audio', storageKey: keys.audio(recordingId), status: 'pending', immutable: false, countsTowardQuota: false, container: 'm4a', createdByJobId: job.id }, AX_REASON);

    const dir = scratchDir(job.id);
    const inPath = path.join(dir, `source${path.extname(source.storageKey) || ''}`);
    const outPath = path.join(dir, 'audio.m4a');
    let verified, uploaded;
    try {
      let head;
      try { head = await storage.headObject(source.storageKey); }
      catch (e) { if (e && e.code === 'object_not_found') throw new TerminalError('source_missing', 'The source object is missing from storage.'); throw new TransientError('storage_unavailable', `head failed: ${e.message}`); }
      if (!scratchHasRoom(dir, Number(head.contentLength || 0))) throw new TransientError('scratch_full', 'not enough scratch space (need 2× source size)');
      await download(storage, source.storageKey, inPath);
      verified = await audioExtractor.extract(inPath, outPath, { sourceFacts: { durationSec: Number(recording.duration) }, signal, timeoutMs: Math.max(10 * 60 * 1000, 3 * Number(recording.duration) * 1000) });
      try { uploaded = await storage.putObject(audio.storageKey, fs.createReadStream(outPath), { contentType: 'audio/mp4', contentLength: verified.bytes }); }
      catch (e) { throw new TransientError('storage_unavailable', `upload failed: ${e.message}`); }
    } catch (e) {
      if (e && e.code === 'aborted') throw new TransientError('aborted', 'audio_extract aborted');
      if (e && e.code === 'timeout') throw new TransientError('audio_timeout', e.message);
      if (e && e.code === 'ENOENT') throw new TransientError('ffmpeg_missing', `ffmpeg not found (${e.message})`);
      if (e && e.code === 'tool_failed') throw new TransientError('ffmpeg_failed', e.message, { stderrTail: e.stderrTail });
      if (e && e.code === 'output_invalid') throw new TransientError('output_invalid', e.message);
      throw e;
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ }
    }
    await withTransaction((tx) => tx.assets.updateSystem(audio.id, { status: 'ready', sizeBytes: verified.bytes, duration: String(verified.facts.durationSec), codecAudio: 'aac', container: 'm4a', checksum: uploaded.etag || null, createdByJobId: job.id }, AX_REASON));
    logger.info({ recording_id: recordingId, asset_id: audio.id, bytes: verified.bytes, duration_sec: verified.facts.durationSec }, 'audio_extract: audio published');
    return { assetId: audio.id, storageKey: audio.storageKey, sizeBytes: verified.bytes, duration: verified.facts.durationSec };
  });

  // ── media.captions (T-704, docs/09 §7) ───────────────────────────────────
  const CAP_REASON = 'T-704 media worker: captions VTT from transcript segments';
  registry.register('captions', async ({ payload, job, logger, deps, repositories }) => {
    const repos = repositories();
    const { storage, withTransaction, keys } = deps;
    if (!storage || !keys) throw new TransientError('storage_unavailable', 'No storage provider / key builder configured on this worker.');
    const recordingId = job.recordingId || (payload && payload.recordingId);
    if (!recordingId) throw new TerminalError('invalid_payload', 'captions needs a recordingId');
    const recording = await repos.recordings.getSystem(recordingId, CAP_REASON);
    if (!recording || recording.deletedAt) throw new TerminalError('recording_gone', 'The recording no longer exists.');
    const transcript = await repos.transcripts.getForPublicWatch(recordingId);
    if (!transcript || transcript.status !== 'done') throw new TerminalError('transcript_required', 'The recording has no completed transcript.');
    const segments = await repos.transcripts.listSegments(transcript.id);
    if (!segments.length) return { skipped: 'no_segments', transcriptId: transcript.id };
    const vtt = buildVtt(segments.map((s) => ({ idx: s.idx, start: Number(s.startS), end: Number(s.endS), text: s.text })), { language: transcript.language || undefined, title: recording.title });
    const check = validateVtt(vtt);
    if (!check.ok) throw new TerminalError('captions_invalid', check.reason);
    const assets = await repos.assets.listByRecordingSystem(recordingId, CAP_REASON);
    let cap = assets.find((a) => a.kind === 'captions_vtt');
    if (!cap) {
      const id = newId('asset');
      cap = await repos.assets.createSystem({ id, recordingId, kind: 'captions_vtt', storageKey: keys.captions(recordingId, id), status: 'pending', immutable: false, countsTowardQuota: false, container: 'vtt', createdByJobId: job.id }, CAP_REASON);
    }
    const body = Buffer.from(vtt, 'utf8');
    let uploaded;
    try { uploaded = await storage.putObject(cap.storageKey, body, { contentType: 'text/vtt', contentLength: body.length }); }
    catch (e) { throw new TransientError('storage_unavailable', `upload failed: ${e.message}`); }
    await withTransaction((tx) => tx.assets.updateSystem(cap.id, { status: 'ready', sizeBytes: body.length, container: 'vtt', checksum: uploaded.etag || null, createdByJobId: job.id }, CAP_REASON));
    logger.info({ recording_id: recordingId, asset_id: cap.id, transcript_id: transcript.id, cues: check.cues, language: transcript.language }, 'captions: VTT published');
    return { assetId: cap.id, storageKey: cap.storageKey, transcriptId: transcript.id, cues: check.cues, language: transcript.language, sizeBytes: body.length };
  });

  // ── media.hls (T-705, docs/09 §5) — never gates `ready` ──────────────────
  const HLS_REASON = 'T-705 media worker: HLS renditions (optional enhancement, never gates ready)';
  registry.register('hls', async ({ payload, job, signal, logger, deps, repositories }) => {
    const repos = repositories();
    const { storage, withTransaction, hlsPackager, keys } = deps;
    if (!hlsPackager) throw new TransientError('packager_unavailable', 'No HLS packager (ffmpeg) configured on this worker.');
    if (!storage || !keys) throw new TransientError('storage_unavailable', 'No storage provider / key builder configured on this worker.');
    const recordingId = job.recordingId || (payload && payload.recordingId);
    if (!recordingId) throw new TerminalError('invalid_payload', 'hls needs a recordingId');
    const recording = await repos.recordings.getSystem(recordingId, HLS_REASON);
    if (!recording || recording.deletedAt) throw new TerminalError('recording_gone', 'The recording no longer exists.');
    if (NOT_PROCESSABLE.has(recording.status)) throw new TerminalError('recording_not_processable', `The recording is ${recording.status}.`);
    const assets = await repos.assets.listByRecordingSystem(recordingId, HLS_REASON);
    const source = assets.find((a) => a.kind === 'source' && a.status === 'ready');
    if (!source) throw new TerminalError('no_source', 'The recording has no ready source asset.');
    if (recording.duration == null || !source.codecVideo) throw new TerminalError('probe_required', 'The source has not been probed yet (facts missing).');

    let hls = assets.find((a) => a.kind === 'hls');
    if (hls && hls.status === 'ready' && !(payload && payload.force)) {
      const exists = await storage.objectExists(hls.storageKey).catch(() => false);
      if (exists) { logger.info({ recording_id: recordingId, asset_id: hls.id }, 'hls: already ready — skipped'); return { skipped: 'already_ready', assetId: hls.id }; }
    }
    if (!hls) {
      const id = newId('asset');
      hls = await repos.assets.createSystem({ id, recordingId, kind: 'hls', storageKey: keys.hlsMaster(recordingId, id), status: 'pending', immutable: false, countsTowardQuota: false, container: 'hls', createdByJobId: job.id }, HLS_REASON);
    } else if (hls.status !== 'pending') {
      await repos.assets.updateSystem(hls.id, { status: 'pending', createdByJobId: job.id }, HLS_REASON);
    }

    const dir = scratchDir(job.id);
    const inPath = path.join(dir, `source${path.extname(source.storageKey) || ''}`);
    const outDir = path.join(dir, 'hls');
    let packaged;
    const uploadedFiles = [];
    try {
      let head;
      try { head = await storage.headObject(source.storageKey); }
      catch (e) { if (e && e.code === 'object_not_found') throw new TerminalError('source_missing', 'The source object is missing from storage.'); throw new TransientError('storage_unavailable', `head failed: ${e.message}`); }
      if (!scratchHasRoom(dir, 3 * Number(head.contentLength || 0))) throw new TransientError('scratch_full', 'not enough scratch space (need 3× source size for renditions)');
      await download(storage, source.storageKey, inPath);
      const sourceFacts = { durationSec: Number(recording.duration), audio: source.codecAudio ? { codec: source.codecAudio } : null, video: { codec: source.codecVideo, width: source.width, height: source.height } };
      const timeoutMs = Math.max(10 * 60 * 1000, 3 * Number(recording.duration) * 1000);
      let lastPersisted = -1;
      packaged = await hlsPackager.packageHls(inPath, outDir, {
        sourceFacts, signal, timeoutMs,
        onProgress: (pct) => { if (pct - lastPersisted >= 5 || pct === 100) { lastPersisted = pct; repos.jobs.setProgressSystem(job.id, pct, HLS_REASON).catch(() => {}); } },
      });
      for (const f of packaged.files) {
        const key = f.name === 'master.m3u8' ? hls.storageKey : keys.hlsSegment(recordingId, hls.id, f.name);
        try { await storage.putObject(key, fs.createReadStream(f.path), { contentType: f.contentType, contentLength: f.bytes }); }
        catch (e) { throw new TransientError('storage_unavailable', `upload failed (${f.name}): ${e.message}`); }
        uploadedFiles.push({ name: f.name, key, bytes: f.bytes });
      }
    } catch (e) {
      if (e && e.code === 'aborted') throw new TransientError('aborted', 'hls aborted');
      if (e && e.code === 'timeout') throw new TransientError('hls_timeout', e.message);
      if (e && e.code === 'ENOENT') throw new TransientError('ffmpeg_missing', `ffmpeg not found (${e.message})`);
      if (e && e.code === 'tool_failed') throw new TransientError('ffmpeg_failed', e.message, { stderrTail: e.stderrTail });
      if (e && e.code === 'output_invalid') throw new TransientError('output_invalid', e.message);
      throw e;
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ }
    }
    const top = packaged.variants.reduce((a, b) => (b.height > a.height ? b : a), packaged.variants[0]);
    await withTransaction((tx) => tx.assets.updateSystem(hls.id, {
      status: 'ready', sizeBytes: packaged.bytes, width: top.width, height: top.height, duration: String(recording.duration),
      codecVideo: 'h264', codecAudio: packaged.hasAudio ? 'aac' : null, container: 'hls', createdByJobId: job.id,
    }, HLS_REASON));
    logger.info({ recording_id: recordingId, asset_id: hls.id, renditions: packaged.renditions.map((r) => r.name), files: uploadedFiles.length, bytes: packaged.bytes }, 'hls: renditions published (never gates ready)');
    return { assetId: hls.id, master: hls.storageKey, renditions: packaged.variants.map((v) => ({ name: v.name, width: v.width, height: v.height, videoKbps: v.videoKbps })), files: uploadedFiles.length, sizeBytes: packaged.bytes, progress: 100 };
  });

  return registry;
}

module.exports = { registerMediaProcessors, scratchDir, scratchHasRoom, DURATION_GRACE_SEC, HLS_MIN_DURATION_SEC, HLS_MIN_HEIGHT, REASON };
