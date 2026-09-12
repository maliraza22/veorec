// RENDER — bake an edit timeline into one MP4 (T-1202 / T-1203, docs/14 §5).
//
//   plan:  single-source, cuts only → stream-copy segments + concat demuxer
//          (fast, lossless); verified — if the copy does not land within the
//          tolerance (cut points not keyframe-aligned) the whole timeline is
//          re-encoded instead. Multi-source (or anything else) → one filter
//          graph on a COMMON canvas (base recording's dimensions, capped at a
//          1920 long edge, even-snapped, every input letterbox-padded), audio
//          resampled to 48 kHz stereo AAC with silent audio for clips without
//          any, concat, libx264 veryfast crf 23 yuv420p, +faststart.
//   verify: ffprobe the output — h264, even dimensions, duration ≈ Σ clip
//          lengths (±2 % or ±250 ms × clips, whichever is larger), faststart.
//
// Sources are never modified. Progress is reported through `-progress`.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { run } = require('./exec');
const { parseProgress, hasFaststart } = require('./transcode');

const MAX_LONG_EDGE = 1920;
const FPS = 30;
const silentLogger = () => ({ info() {}, warn() {}, error() {}, debug() {} });
const r3 = (n) => Math.round(n * 1000) / 1000;

/** The common canvas: the base's dimensions, capped and even (docs/14 §5). */
function planCanvas(baseFacts) {
  let w = Number(baseFacts && baseFacts.video && baseFacts.video.width) || 1280;
  let h = Number(baseFacts && baseFacts.video && baseFacts.video.height) || 720;
  const longEdge = Math.max(w, h);
  if (longEdge > MAX_LONG_EDGE) { const s = MAX_LONG_EDGE / longEdge; w = Math.round(w * s); h = Math.round(h * s); }
  return { width: Math.max(2, w - (w % 2)), height: Math.max(2, h - (h % 2)) };
}

/** Which strategy a timeline gets. Pure. */
function planStrategy(clips) {
  const paths = new Set(clips.map((c) => c.path));
  return paths.size === 1 ? 'copy' : 'encode';
}

/** The filter graph for a full re-encode of `clips` onto `canvas`. Pure. */
function buildEncodeArgs(clips, outPath, canvas, { fps = FPS } = {}) {
  const inputs = [];
  const files = [...new Set(clips.map((c) => c.path))];
  for (const f of files) inputs.push('-i', f);
  const idx = (p) => files.indexOf(p);
  const parts = [];
  const labels = [];
  clips.forEach((c, i) => {
    const n = idx(c.path);
    parts.push(`[${n}:v]trim=start=${r3(c.in)}:end=${r3(c.out)},setpts=PTS-STARTPTS,scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease,pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p[v${i}]`);
    if (c.hasAudio) parts.push(`[${n}:a]atrim=start=${r3(c.in)}:end=${r3(c.out)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    else parts.push(`anullsrc=r=48000:cl=stereo,atrim=0:${r3(c.out - c.in)},asetpts=PTS-STARTPTS[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(`${labels.join('')}concat=n=${clips.length}:v=1:a=1[vout][aout]`);
  return [
    '-hide_banner', '-nostdin', '-y', ...inputs,
    '-filter_complex', parts.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats',
    outPath,
  ];
}

/** ffmpeg with live `-progress` (the transcoder's spawn discipline). */
function spawnFfmpeg(ffmpegBin, args, { signal = null, timeoutMs = 0, onOutTime = null } = {}) {
  const state = { outTimeSec: null, ended: false };
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { return reject(e); }
    let err = '', done = false;
    const finish = (fn, v) => { if (done) return; done = true; if (timer) clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); fn(v); };
    const kill = () => { try { p.kill('SIGKILL'); } catch { /* gone */ } };
    const onAbort = () => { kill(); finish(reject, Object.assign(new Error('ffmpeg aborted'), { code: 'aborted' })); };
    const timer = timeoutMs ? setTimeout(() => { kill(); finish(reject, Object.assign(new Error(`ffmpeg timed out after ${timeoutMs} ms`), { code: 'timeout', stderrTail: err.slice(-2048) })); }, timeoutMs) : null;
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    p.stdout.on('data', (d) => { parseProgress(d, state); if (onOutTime && state.outTimeSec != null) { try { onOutTime(state.outTimeSec); } catch { /* observer */ } } });
    p.stderr.on('data', (d) => { err += d; if (err.length > 1 << 20) err = err.slice(-(1 << 20)); });
    p.on('error', (e) => finish(reject, Object.assign(e, { stderrTail: err.slice(-2048) })));
    p.on('close', (code) => {
      if (code === 0) finish(resolve);
      else finish(reject, Object.assign(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`), { code: 'tool_failed', exitCode: code, stderrTail: err.slice(-2048) }));
    });
  });
}

function createRenderer({ ffmpegBin = 'ffmpeg', prober, logger = silentLogger() } = {}) {
  if (!prober) throw new Error('createRenderer: a prober is required for verification');

  async function verify(outPath, expectedSec, clipsCount, { signal } = {}) {
    const facts = await prober.probeFile(outPath, { signal });
    const problems = [];
    if (facts.unreadable || !facts.video) problems.push('no video stream in output');
    else {
      if (facts.video.codec !== 'h264') problems.push(`video codec ${facts.video.codec}`);
      if (facts.video.width % 2 || facts.video.height % 2) problems.push('odd dimensions');
    }
    const d = Number(facts.durationSec);
    const tol = Math.max(expectedSec * 0.02, 0.25 * clipsCount);
    if (!Number.isFinite(d) || Math.abs(d - expectedSec) > tol) problems.push(`duration ${d} s not within ${r3(tol)} s of the timeline's ${expectedSec} s`);
    if (!hasFaststart(outPath)) problems.push('moov atom is not before mdat (+faststart missing)');
    return { facts, problems };
  }

  /** Stream-copy each cut, concat with the demuxer. Throws code 'copy_inexact' when verification fails. */
  async function renderCopy(clips, outPath, dir, expectedSec, { signal, timeoutMs, onProgress }) {
    const segs = [];
    for (let i = 0; i < clips.length; i += 1) {
      const c = clips[i];
      const seg = path.join(dir, `seg_${String(i).padStart(3, '0')}.mp4`);
      await run(ffmpegBin, ['-hide_banner', '-nostdin', '-y', '-ss', String(r3(c.in)), '-to', String(r3(c.out)), '-i', c.path, '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', seg], { signal, timeout: timeoutMs });
      segs.push(seg);
      if (onProgress) onProgress(Math.floor(((i + 1) / (clips.length + 1)) * 90));
    }
    const list = path.join(dir, 'concat.txt');
    fs.writeFileSync(list, segs.map((s) => `file '${s.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    await run(ffmpegBin, ['-hide_banner', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', outPath], { signal, timeout: timeoutMs });
    const { facts, problems } = await verify(outPath, expectedSec, clips.length, { signal });
    if (problems.length) { const e = new Error(`stream copy not exact: ${problems.join('; ')}`); e.code = 'copy_inexact'; e.problems = problems; throw e; }
    if (onProgress) onProgress(100);
    return { facts, strategy: 'copy' };
  }

  async function renderEncode(clips, outPath, canvas, expectedSec, { signal, timeoutMs, onProgress }) {
    const args = buildEncodeArgs(clips, outPath, canvas);
    let last = -1;
    await spawnFfmpeg(ffmpegBin, args, { signal, timeoutMs, onOutTime: (t) => { const pct = Math.max(0, Math.min(99, Math.floor((t / expectedSec) * 100))); if (pct !== last && onProgress) { last = pct; onProgress(pct); } } });
    const { facts, problems } = await verify(outPath, expectedSec, clips.length, { signal });
    if (problems.length) { const e = new Error(`render output failed verification: ${problems.join('; ')}`); e.code = 'output_invalid'; e.problems = problems; throw e; }
    if (onProgress) onProgress(100);
    return { facts, strategy: 'encode' };
  }

  /**
   * @param {object} p
   * @param {Array<{path: string, in: number, out: number, hasAudio: boolean}>} p.clips
   * @param {string} p.outPath
   * @param {{width, height}} p.canvas
   * @param {string} p.dir  scratch directory for segments
   * @returns {Promise<{facts, strategy: 'copy'|'encode', durationSec}>}
   */
  async function render({ clips, outPath, canvas, dir, signal = null, timeoutMs = 0, onProgress = null, forceEncode = false }) {
    if (!Array.isArray(clips) || clips.length === 0) throw Object.assign(new Error('render: no clips'), { code: 'invalid_timeline' });
    const expectedSec = r3(clips.reduce((s, c) => s + (c.out - c.in), 0));
    const strategy = forceEncode ? 'encode' : planStrategy(clips);
    if (strategy === 'copy') {
      try {
        const out = await renderCopy(clips, outPath, dir, expectedSec, { signal, timeoutMs, onProgress });
        logger.info({ clips: clips.length, duration_sec: out.facts.durationSec }, 'render: stream copy');
        return { ...out, durationSec: expectedSec };
      } catch (e) {
        if (e.code !== 'copy_inexact' && e.code !== 'tool_failed') throw e;
        logger.info({ reason: e.code, problems: e.problems || null }, 'render: stream copy not exact — re-encoding');
        try { fs.unlinkSync(outPath); } catch { /* absent */ }
      }
    }
    const out = await renderEncode(clips, outPath, canvas, expectedSec, { signal, timeoutMs, onProgress });
    logger.info({ clips: clips.length, canvas, duration_sec: out.facts.durationSec }, 'render: encoded');
    return { ...out, durationSec: expectedSec };
  }

  return { render, planCanvas, planStrategy, buildEncodeArgs, verify, ffmpegBin };
}

/** docs/14 §7: silence gaps → keep-ranges (pad both sides, merge gaps under minGap). Pure. */
function keepRangesFromSilences(silences, durationSec, { pad = 0.2, minGap = 0.8 } = {}) {
  const dur = Number(durationSec) || 0;
  if (!(dur > 0)) return null;
  const gaps = (silences || []).filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start).sort((a, b) => a.start - b.start);
  // A silence shorter than minGap is speech pacing, not a gap to cut.
  // A silence touching the start or the end of the video is cut flush (there is no speech to pad on that side).
  const cuts = gaps.filter((g) => g.end - g.start >= minGap).map((g) => ({ start: g.start <= 0 ? 0 : Math.min(dur, g.start + pad), end: g.end >= dur ? dur : Math.max(0, g.end - pad) })).filter((g) => g.end > g.start);
  const keep = [];
  let cursor = 0;
  for (const c of cuts) { if (c.start > cursor) keep.push({ start: cursor, end: c.start }); cursor = Math.max(cursor, c.end); }
  if (cursor < dur) keep.push({ start: cursor, end: dur });
  return keep.map((r) => ({ start: Math.round(r.start * 100) / 100, end: Math.round(r.end * 100) / 100 })).filter((r) => r.end > r.start);
}

/** The legacy transcript-gap rule (server keepRangesFromTranscript), kept as the fallback. Pure. */
function keepRangesFromTranscript(segments, duration, { pad = 0.2, minGap = 0.8 } = {}) {
  const segs = (segments || []).filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start).sort((a, b) => a.start - b.start);
  if (!segs.length) return null;
  const ranges = segs.map((s) => ({ start: Math.max(0, s.start - pad), end: s.end + pad }));
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i += 1) {
    const last = merged[merged.length - 1];
    if (ranges[i].start - last.end < minGap) last.end = Math.max(last.end, ranges[i].end);
    else merged.push(ranges[i]);
  }
  const dur = duration || merged[merged.length - 1].end;
  return merged.map((r) => ({ start: Math.round(Math.max(0, r.start) * 100) / 100, end: Math.round(Math.min(dur, r.end) * 100) / 100 })).filter((r) => r.end > r.start);
}

module.exports = { createRenderer, planCanvas, planStrategy, buildEncodeArgs, spawnFfmpeg, keepRangesFromSilences, keepRangesFromTranscript, MAX_LONG_EDGE };
