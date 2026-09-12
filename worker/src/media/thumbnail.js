// Thumbnails, posters, previews (docs/09 §4, T-703).
//
//   poster   frame at min(2 s, 10 % of duration) — NOT frame 0 (black/blank
//            first frames are common in screen recordings) — and the frame is
//            checked for darkness (signalstats YAVG) and stepped forward when
//            it is black; 1280 w, jpeg q=2
//   poster/play  the same frame with a play-button overlay (email embeds)
//   thumb    the same frame at 640 w
//   preview  3 × 1 s clips at 10/50/90 % → animated WebP (320 w, 10 fps,
//            ~400 KB budget), only for recordings ≥ 10 s
'use strict';

const fs = require('fs');
const path = require('path');
const { run } = require('./exec');
const { renderPlayIconPng } = require('./play-icon');
const { silentLogger } = require('../logger');

const DARK_YAVG = 24;               // 8-bit luma below this = "black frame"
const POSTER_WIDTH = 1280, THUMB_WIDTH = 640, PREVIEW_WIDTH = 320, PREVIEW_FPS = 10;
const PREVIEW_MIN_DURATION_SEC = 10, PREVIEW_BUDGET_BYTES = 400 * 1024;

/** docs/09 §4: min(2 s, 10 % of duration). */
function basePosterTime(durationSec) {
  const d = Number(durationSec) || 0;
  return Math.round(Math.max(0, Math.min(2, d * 0.1)) * 1000) / 1000;
}

/** Candidate times: the base, then +1 s steps, never past the end. */
function posterCandidates(durationSec, steps = 4) {
  const d = Number(durationSec) || 0;
  const t0 = basePosterTime(d);
  const out = [];
  for (let i = 0; i <= steps; i += 1) { const t = t0 + i; if (t <= Math.max(0, d - 0.1)) out.push(Math.round(t * 1000) / 1000); }
  return out.length ? out : [0];
}

/** Preview clip starts at 10/50/90 %, each clamped so a 1 s clip fits. */
function previewClipStarts(durationSec) {
  const d = Number(durationSec) || 0;
  return [0.1, 0.5, 0.9].map((f) => Math.max(0, Math.min(d - 1, d * f))).map((t) => Math.round(t * 1000) / 1000);
}

function createThumbnailer({ ffmpegBin = 'ffmpeg', prober, logger = silentLogger() } = {}) {
  if (!prober) throw new Error('createThumbnailer: a prober is required to verify outputs');

  /** Mean luma (0–255) of the frame at `t`, or null when unreadable. */
  async function frameLuma(inPath, t, { signal = null } = {}) {
    try {
      const r = await run(ffmpegBin, ['-hide_banner', '-nostdin', '-ss', String(t), '-i', inPath, '-frames:v', '1', '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'], { timeout: 60000, signal });
      const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(r.out + r.err);
      return m ? Number(m[1]) : null;
    } catch (e) { if (e && (e.code === 'aborted' || e.code === 'ENOENT')) throw e; return null; }
  }

  /** The first candidate frame that is not black; falls back to the base time. */
  async function pickPosterTime(inPath, durationSec, { signal = null, luma = frameLuma } = {}) {
    const candidates = posterCandidates(durationSec);
    let first = null;
    for (const t of candidates) {
      const y = await luma(inPath, t, { signal });
      if (first === null) first = { t, luma: y };
      if (y != null && y >= DARK_YAVG) return { t, luma: y, dark: false, tried: candidates.indexOf(t) + 1 };
    }
    return { t: first ? first.t : candidates[0], luma: first ? first.luma : null, dark: true, tried: candidates.length };
  }

  async function frameJpeg(inPath, outPath, t, width, { signal = null } = {}) {
    // Never upscale a small source: min(target, source width), even height.
    await run(ffmpegBin, ['-hide_banner', '-nostdin', '-y', '-ss', String(t), '-i', inPath, '-frames:v', '1', '-vf', `scale='min(${width},iw)':-2`, '-q:v', '2', outPath], { timeout: 60000, signal });
    const facts = await prober.probeFile(outPath, { signal });
    if (facts.unreadable || !facts.video || !facts.video.width) { const e = new Error(`frame at ${t}s produced no image`); e.code = 'output_invalid'; throw e; }
    return { path: outPath, t, width: facts.video.width, height: facts.video.height, bytes: fs.statSync(outPath).size };
  }

  async function playOverlay(posterPath, outPath, { width, signal = null } = {}) {
    const iconPath = path.join(path.dirname(outPath), 'play-icon.png');
    fs.writeFileSync(iconPath, renderPlayIconPng(Math.round((width || POSTER_WIDTH) * 0.14)));
    await run(ffmpegBin, ['-hide_banner', '-nostdin', '-y', '-i', posterPath, '-i', iconPath, '-filter_complex', '[0:v][1:v]overlay=(W-w)/2:(H-h)/2', '-q:v', '2', outPath], { timeout: 60000, signal });
    const facts = await prober.probeFile(outPath, { signal });
    if (facts.unreadable || !facts.video) { const e = new Error('play overlay produced no image'); e.code = 'output_invalid'; throw e; }
    return { path: outPath, width: facts.video.width, height: facts.video.height, bytes: fs.statSync(outPath).size };
  }

  async function preview(inPath, outPath, durationSec, { signal = null, quality = 60 } = {}) {
    const starts = previewClipStarts(durationSec);
    const parts = starts.map((t, i) => `[0:v]trim=start=${t}:duration=1,setpts=PTS-STARTPTS,scale=${PREVIEW_WIDTH}:-2,fps=${PREVIEW_FPS}[p${i}]`).join(';');
    const graph = `${parts};${starts.map((_, i) => `[p${i}]`).join('')}concat=n=${starts.length}:v=1:a=0[out]`;
    await run(ffmpegBin, ['-hide_banner', '-nostdin', '-y', '-i', inPath, '-filter_complex', graph, '-map', '[out]', '-c:v', 'libwebp_anim', '-loop', '0', '-q:v', String(quality), '-an', outPath], { timeout: 180000, signal });
    let bytes = fs.statSync(outPath).size;
    if (bytes > PREVIEW_BUDGET_BYTES && quality > 35) {
      logger.info({ bytes, quality }, 'preview over budget — re-encoding at lower quality');
      return preview(inPath, outPath, durationSec, { signal, quality: 35 });
    }
    const head = fs.readFileSync(outPath).subarray(0, 12).toString('latin1');
    if (!(head.startsWith('RIFF') && head.endsWith('WEBP'))) { const e = new Error('preview is not a WebP'); e.code = 'output_invalid'; throw e; }
    return { path: outPath, starts, bytes, quality, width: PREVIEW_WIDTH };
  }

  /**
   * Everything docs/09 §4 asks for, into `dir`.
   * @returns {{ time, poster, posterPlay, thumb, preview|null }}
   */
  async function generateAll(inPath, dir, { durationSec, signal = null } = {}) {
    const time = await pickPosterTime(inPath, durationSec, { signal });
    if (time.dark) logger.warn({ t: time.t, luma: time.luma }, 'poster: every candidate frame is dark — using the base frame');
    const poster = await frameJpeg(inPath, path.join(dir, 'poster.jpg'), time.t, POSTER_WIDTH, { signal });
    const posterPlay = await playOverlay(poster.path, path.join(dir, 'poster-play.jpg'), { width: poster.width, signal });
    const thumb = await frameJpeg(inPath, path.join(dir, 'thumb.jpg'), time.t, THUMB_WIDTH, { signal });
    const prev = Number(durationSec) >= PREVIEW_MIN_DURATION_SEC ? await preview(inPath, path.join(dir, 'preview.webp'), durationSec, { signal }) : null;
    return { time, poster, posterPlay, thumb, preview: prev };
  }

  return { frameLuma, pickPosterTime, frameJpeg, playOverlay, preview, generateAll, ffmpegBin };
}

module.exports = { createThumbnailer, basePosterTime, posterCandidates, previewClipStarts, DARK_YAVG, POSTER_WIDTH, THUMB_WIDTH, PREVIEW_WIDTH, PREVIEW_FPS, PREVIEW_MIN_DURATION_SEC, PREVIEW_BUDGET_BYTES };
