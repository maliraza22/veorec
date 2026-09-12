// Normalisation & transcoding (docs/09 §3): one MP4 rendition at source
// resolution capped at 1080p, h264 high@4.1 + aac, `+faststart`, verified by
// a second ffprobe before anything flips `ready` — a worker never publishes
// an unverified asset.
'use strict';

const fs = require('fs');
const { run } = require('./exec');
const { silentLogger } = require('../logger');

/** ffmpeg `-progress pipe:1` key=value lines → out_time seconds (last seen). */
function parseProgress(chunk, state = { outTimeSec: null, ended: false }) {
  for (const line of String(chunk).split(/\r?\n/)) {
    const m = /^(out_time_us|out_time_ms|out_time)=(.+)$/.exec(line.trim());
    if (m) {
      if (m[1] === 'out_time') { const t = /(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(m[2]); if (t) state.outTimeSec = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]); }
      else { const n = Number(m[2]); if (Number.isFinite(n) && n >= 0) state.outTimeSec = m[1] === 'out_time_us' ? n / 1e6 : n / 1e6; }   // ffmpeg's out_time_ms is microseconds too
    }
    if (/^progress=end$/.test(line.trim())) state.ended = true;
  }
  return state;
}

/**
 * `+faststart`: the `moov` box must precede `mdat`. Scans the top-level box
 * headers of the file (a few KB usually — moov comes first when it works).
 */
function hasFaststart(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let pos = 0, guard = 0;
    while (pos + 8 <= size && guard++ < 64) {
      const head = Buffer.alloc(16);
      fs.readSync(fd, head, 0, 16, pos);
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (boxSize === 1) boxSize = Number(head.readBigUInt64BE(8));
      else if (boxSize === 0) boxSize = size - pos;
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      if (boxSize < 8) return false;
      pos += boxSize;
    }
    return false;
  } finally { fs.closeSync(fd); }
}

/** docs/09 §3 command. Video-only sources get a video-only MP4 (no silence synthesised). */
function buildArgs(inPath, outPath, { hasAudio = true } = {}) {
  return [
    '-hide_banner', '-nostdin', '-y', '-i', inPath,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-level', '4.1',
    '-vf', "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-r', '30', '-pix_fmt', 'yuv420p',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'] : ['-an']),
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    outPath,
  ];
}

function createTranscoder({ ffmpegBin = 'ffmpeg', prober, logger = silentLogger() } = {}) {
  if (!prober) throw new Error('createTranscoder: a prober is required for output verification');

  /**
   * @returns {Promise<{facts, verified:true}>}  rejects with code:
   *   'aborted' | 'timeout' | 'ENOENT' | 'tool_failed' | 'output_invalid'
   */
  async function transcodeToMp4(inPath, outPath, { sourceFacts, signal = null, onProgress = null, timeoutMs = 0 } = {}) {
    const hasAudio = !!(sourceFacts && sourceFacts.audio);
    const srcDuration = sourceFacts && Number(sourceFacts.durationSec);
    const state = { outTimeSec: null, ended: false };
    let lastPct = -1;
    const args = buildArgs(inPath, outPath, { hasAudio });
    // `run` buffers stdout; progress needs it live → spawn directly here.
    const { spawn } = require('child_process');
    await new Promise((resolve, reject) => {
      let p;
      try { p = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { return reject(e); }
      let err = '', done = false;
      const finish = (fn, v) => { if (done) return; done = true; if (timer) clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); fn(v); };
      const kill = () => { try { p.kill('SIGKILL'); } catch { /* gone */ } };
      const onAbort = () => { kill(); finish(reject, Object.assign(new Error('ffmpeg aborted'), { code: 'aborted' })); };
      const timer = timeoutMs ? setTimeout(() => { kill(); finish(reject, Object.assign(new Error(`ffmpeg timed out after ${timeoutMs} ms`), { code: 'timeout', stderrTail: err.slice(-2048) })); }, timeoutMs) : null;
      if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
      p.stdout.on('data', (d) => {
        parseProgress(d, state);
        if (onProgress && Number.isFinite(srcDuration) && srcDuration > 0 && state.outTimeSec != null) {
          const pct = Math.max(0, Math.min(99, Math.floor((state.outTimeSec / srcDuration) * 100)));
          if (pct !== lastPct) { lastPct = pct; try { onProgress(pct); } catch { /* observer */ } }
        }
      });
      p.stderr.on('data', (d) => { err += d; if (err.length > 1 << 20) err = err.slice(-(1 << 20)); });
      p.on('error', (e) => finish(reject, Object.assign(e, { stderrTail: err.slice(-2048) })));
      p.on('close', (code) => {
        if (code === 0) finish(resolve);
        else finish(reject, Object.assign(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`), { code: 'tool_failed', exitCode: code, stderrTail: err.slice(-2048) }));
      });
    });

    // Verification (docs/09 §3): second ffprobe, streams present, duration
    // within 2 % of the source, faststart in place.
    const facts = await prober.probeFile(outPath, { signal });
    const problems = [];
    if (facts.unreadable || !facts.video) problems.push('no video stream in output');
    else {
      if (facts.video.codec !== 'h264') problems.push(`video codec ${facts.video.codec}`);
      if (hasAudio && !facts.audio) problems.push('audio stream missing in output');
      if (!hasAudio && facts.audio) problems.push('unexpected audio stream in output');
      if (facts.video.width % 2 || facts.video.height % 2) problems.push('odd dimensions');
      if (facts.video.width > 1920 || facts.video.height > 1080) problems.push(`not capped at 1080p (${facts.video.width}x${facts.video.height})`);
    }
    if (Number.isFinite(srcDuration) && srcDuration > 0) {
      const d = Number(facts.durationSec);
      if (!Number.isFinite(d) || Math.abs(d - srcDuration) / srcDuration > 0.02) problems.push(`duration ${d} s not within 2 % of source ${srcDuration} s`);
    }
    if (!hasFaststart(outPath)) problems.push('moov atom is not before mdat (+faststart missing)');
    if (problems.length) {
      const e = new Error(`transcode output failed verification: ${problems.join('; ')}`);
      e.code = 'output_invalid'; e.problems = problems;
      throw e;
    }
    if (onProgress) { try { onProgress(100); } catch { /* observer */ } }
    logger.info({ duration_sec: facts.durationSec, width: facts.video.width, height: facts.video.height, audio: !!facts.audio, size_bytes: facts.sizeBytes }, 'transcode: output verified');
    return { facts, verified: true, hasAudio };
  }

  return { transcodeToMp4, buildArgs, ffmpegBin };
}

module.exports = { createTranscoder, buildArgs, parseProgress, hasFaststart };
