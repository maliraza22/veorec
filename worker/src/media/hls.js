// HLS packaging (docs/09 §5, T-705): renditions 1080p@5M (source ≥ 1080),
// 720p@2.8M, 480p@1.2M — h264 + aac 128k, 4 s fMP4 segments, VOD playlists,
// one master playlist. One ffmpeg pass PER rendition with flat, explicit
// filenames (`{name}_index.m3u8`, `{name}_init.mp4`, `{name}_seg_00001.m4s`)
// — ffmpeg's `%v` expansion does not reach the init-segment name — so every
// segment key satisfies the key contract (`keys.hlsSegment` allows no slashes)
// and playlists reference siblings relatively; the API rewrites/signs them
// per docs/12 §5.2. The master playlist is written by us from the probed
// variant facts (bandwidth, resolution, codecs).
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { silentLogger } = require('../logger');
const { parseProgress } = require('./transcode');

const RENDITIONS = Object.freeze([
  { name: '1080p', height: 1080, videoKbps: 5000, maxrateKbps: 5350, bufsizeKbps: 7500 },
  { name: '720p', height: 720, videoKbps: 2800, maxrateKbps: 2996, bufsizeKbps: 4200 },
  { name: '480p', height: 480, videoKbps: 1200, maxrateKbps: 1284, bufsizeKbps: 1800 },
]);
const AUDIO_KBPS = 128;
const SEGMENT_SECONDS = 4;
const CONTENT_TYPES = { m3u8: 'application/vnd.apple.mpegurl', mp4: 'video/mp4', m4s: 'video/iso.segment' };

/** Renditions no taller than the source; a small source gets one at its own height. */
function renditionsFor(sourceHeight) {
  const h = Number(sourceHeight) || 0;
  const fit = RENDITIONS.filter((r) => r.height <= h);
  if (fit.length) return fit;
  const low = RENDITIONS[RENDITIONS.length - 1];
  const hh = Math.max(16, h - (h % 2));
  return [{ ...low, name: `${hh}p`, height: hh }];
}

function buildArgs(inPath, outDir, rendition, { hasAudio, fps = 30 } = {}) {
  const gop = Math.max(1, Math.round(SEGMENT_SECONDS * (fps || 30)));
  const r = rendition;
  return [
    '-hide_banner', '-nostdin', '-y', '-i', inPath,
    '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0'] : ['-an']),
    '-vf', `scale=-2:${r.height}:flags=bicubic`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
    '-b:v', `${r.videoKbps}k`, '-maxrate', `${r.maxrateKbps}k`, '-bufsize', `${r.bufsizeKbps}k`,
    '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0', '-r', String(fps || 30),
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`, '-ar', '48000', '-ac', '2'] : []),
    '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
    '-hls_flags', 'independent_segments', '-hls_list_size', '0',
    // Relative names, run with cwd = outDir: ffmpeg resolves the init-segment
    // name against the process cwd (not the playlist), so an absolute segment
    // path would scatter files. Everything lands in outDir this way.
    '-hls_fmp4_init_filename', `${r.name}_init.mp4`,
    '-hls_segment_filename', `${r.name}_seg_%05d.m4s`,
    '-progress', 'pipe:1', '-nostats',
    `${r.name}_index.m3u8`,
  ];
}

/** avc1.PPCCLL from ffprobe profile/level (High = 0x64, no constraints, level 41 → 0x29). */
function avc1Codec(profile, level) {
  const p = { baseline: 0x42, main: 0x4d, high: 0x64, 'high 10': 0x6e, 'high 4:2:2': 0x7a, 'high 4:4:4 predictive': 0xf4 }[String(profile || 'high').toLowerCase().replace('constrained ', '')] || 0x64;
  const l = Number(level) > 0 ? Number(level) : 41;
  return `avc1.${p.toString(16).padStart(2, '0')}00${l.toString(16).padStart(2, '0')}`;
}

function writeMaster(outDir, variants) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const v of variants) {
    const bw = Math.round((v.videoKbps + (v.hasAudio ? AUDIO_KBPS : 0)) * 1000 * 1.1);
    const codecs = [v.codecVideo, v.hasAudio ? 'mp4a.40.2' : null].filter(Boolean).join(',');
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bw},AVERAGE-BANDWIDTH=${Math.round((v.videoKbps + (v.hasAudio ? AUDIO_KBPS : 0)) * 1000)},RESOLUTION=${v.width}x${v.height},CODECS="${codecs}",FRAME-RATE=${v.fps || 30}`, `${v.name}_index.m3u8`);
  }
  const text = `${lines.join('\n')}\n`;
  fs.writeFileSync(path.join(outDir, 'master.m3u8'), text);
  return text;
}

/** Master + variant playlist structure (no player needed). */
function inspectPlaylists(outDir, renditions) {
  const master = fs.readFileSync(path.join(outDir, 'master.m3u8'), 'utf8');
  const streams = master.split('\n').filter((l) => l.startsWith('#EXT-X-STREAM-INF'));
  const variants = renditions.map((r) => {
    const pl = fs.readFileSync(path.join(outDir, `${r.name}_index.m3u8`), 'utf8');
    const segs = pl.split('\n').filter((l) => /\.m4s\s*$/.test(l.trim()));
    const map = /#EXT-X-MAP:URI="([^"]+)"/.exec(pl);
    const durations = pl.split('\n').filter((l) => l.startsWith('#EXTINF:')).map((l) => Number(l.slice(8).split(',')[0]));
    return { name: r.name, playlist: `${r.name}_index.m3u8`, init: map ? map[1] : null, segments: segs.map((s) => s.trim()), endlist: /#EXT-X-ENDLIST/.test(pl), durationSec: Math.round(durations.reduce((a, b) => a + b, 0) * 1000) / 1000 };
  });
  return { masterStreams: streams.length, referenced: master.split('\n').filter((l) => /_index\.m3u8\s*$/.test(l.trim())).map((l) => l.trim()), variants };
}

function runFfmpeg(ffmpegBin, args, { signal, timeoutMs, onOutTime, cwd }) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd }); } catch (e) { return reject(e); }
    let err = '', done = false;
    const state = { outTimeSec: null, ended: false };
    const finish = (fn, v) => { if (done) return; done = true; if (timer) clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); fn(v); };
    const kill = () => { try { p.kill('SIGKILL'); } catch { /* gone */ } };
    const onAbort = () => { kill(); finish(reject, Object.assign(new Error('ffmpeg aborted'), { code: 'aborted' })); };
    const timer = timeoutMs ? setTimeout(() => { kill(); finish(reject, Object.assign(new Error(`ffmpeg timed out after ${timeoutMs} ms`), { code: 'timeout', stderrTail: err.slice(-2048) })); }, timeoutMs) : null;
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    p.stdout.on('data', (d) => { parseProgress(d, state); if (onOutTime && state.outTimeSec != null) onOutTime(state.outTimeSec); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 1 << 20) err = err.slice(-(1 << 20)); });
    p.on('error', (e) => finish(reject, Object.assign(e, { stderrTail: err.slice(-2048) })));
    p.on('close', (code) => {
      if (code === 0) finish(resolve);
      else finish(reject, Object.assign(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`), { code: 'tool_failed', exitCode: code, stderrTail: err.slice(-2048) }));
    });
  });
}

function createHlsPackager({ ffmpegBin = 'ffmpeg', prober, logger = silentLogger() } = {}) {
  if (!prober) throw new Error('createHlsPackager: a prober is required for output verification');

  /**
   * @returns {Promise<{renditions, variants, files:[{name,path,bytes,contentType}], bytes, inspect, master}>}
   * rejects with code 'aborted'|'timeout'|'ENOENT'|'tool_failed'|'output_invalid'
   */
  async function packageHls(inPath, outDir, { sourceFacts, signal = null, onProgress = null, timeoutMs = 0 } = {}) {
    const hasAudio = !!(sourceFacts && sourceFacts.audio);
    const srcDuration = sourceFacts && Number(sourceFacts.durationSec);
    const renditions = renditionsFor(sourceFacts && sourceFacts.video && sourceFacts.video.height);
    fs.mkdirSync(outDir, { recursive: true });
    const started = Date.now();
    let lastPct = -1;
    const report = (i, outTime) => {
      if (!onProgress || !Number.isFinite(srcDuration) || srcDuration <= 0) return;
      const pct = Math.max(0, Math.min(99, Math.floor(((i + Math.min(1, outTime / srcDuration)) / renditions.length) * 100)));
      if (pct !== lastPct) { lastPct = pct; try { onProgress(pct); } catch { /* observer */ } }
    };
    const absIn = path.resolve(inPath);
    for (let i = 0; i < renditions.length; i += 1) {
      const perPass = timeoutMs ? Math.max(1000, timeoutMs - (Date.now() - started)) : 0;
      await runFfmpeg(ffmpegBin, buildArgs(absIn, outDir, renditions[i], { hasAudio, fps: 30 }), { signal, timeoutMs: perPass, onOutTime: (t) => report(i, t), cwd: outDir });
    }

    // Verification: every variant is a finished VOD playlist with an init
    // segment and ≥ 1 media segment, ffprobe reads it (streams present) and
    // its playlist duration is within 2 % of the source; then the master is
    // written from the probed facts and re-read.
    // Stream facts come from the INIT segment (a plain fMP4 header every
    // ffprobe reads); decodability + duration from an ffmpeg null decode of the
    // playlist run inside outDir (relative segment URIs resolve there).
    const problems = [];
    const variants = [];
    for (const r of renditions) {
      const probed = await prober.probeFile(path.join(outDir, `${r.name}_init.mp4`), { signal }).catch(() => ({ unreadable: true }));
      if (probed.unreadable || !probed.video) { problems.push(`${r.name}: cannot read the init segment`); continue; }
      if (hasAudio && !probed.audio) problems.push(`${r.name}: audio missing`);
      if (probed.video.height !== r.height) problems.push(`${r.name}: height ${probed.video.height}`);
      let decoded = null;
      try {
        await runFfmpeg(ffmpegBin, ['-hide_banner', '-nostdin', '-i', `${r.name}_index.m3u8`, '-f', 'null', '-', '-progress', 'pipe:1', '-nostats'], { signal, timeoutMs: timeoutMs || 0, cwd: outDir, onOutTime: (t) => { decoded = t; } });
      } catch (e) { if (e && (e.code === 'aborted' || e.code === 'timeout')) throw e; problems.push(`${r.name}: playlist does not decode (${(e.message || '').slice(0, 120)})`); }
      variants.push({ ...r, hasAudio, width: probed.video.width, height: probed.video.height, fps: probed.video.fps || 30, codecVideo: avc1Codec(probed.video.profile, probed.video.level), decodedSec: decoded });
    }
    if (!problems.length) writeMaster(outDir, variants);
    const inspect = problems.length ? null : inspectPlaylists(outDir, renditions);
    if (inspect) {
      if (inspect.masterStreams !== renditions.length) problems.push(`master lists ${inspect.masterStreams} streams, expected ${renditions.length}`);
      for (const v of inspect.variants) {
        if (!v.endlist) problems.push(`${v.name}: playlist not finished (no ENDLIST)`);
        if (!v.init || !fs.existsSync(path.join(outDir, v.init))) problems.push(`${v.name}: init segment missing`);
        if (!v.segments.length) problems.push(`${v.name}: no media segments`);
        if (Number.isFinite(srcDuration) && srcDuration > 0 && Math.abs(v.durationSec - srcDuration) / srcDuration > 0.02) problems.push(`${v.name}: playlist duration ${v.durationSec} s not within 2 % of ${srcDuration} s`);
        const dec = variants.find((x) => x.name === v.name);
        if (dec && dec.decodedSec != null && Number.isFinite(srcDuration) && srcDuration > 0 && Math.abs(dec.decodedSec - srcDuration) / srcDuration > 0.05) problems.push(`${v.name}: decoded duration ${dec.decodedSec} s not within 5 % of ${srcDuration} s`);
      }
    }
    if (problems.length) { const e = new Error(`HLS output failed verification: ${problems.join('; ')}`); e.code = 'output_invalid'; e.problems = problems; throw e; }

    const files = fs.readdirSync(outDir).filter((n) => /\.(m3u8|mp4|m4s)$/.test(n)).sort().map((n) => ({ name: n, path: path.join(outDir, n), bytes: fs.statSync(path.join(outDir, n)).size, contentType: CONTENT_TYPES[n.split('.').pop()] }));
    const bytes = files.reduce((s, f) => s + f.bytes, 0);
    if (onProgress) { try { onProgress(100); } catch { /* observer */ } }
    logger.info({ renditions: renditions.map((r) => r.name), files: files.length, bytes }, 'hls: output verified');
    return { renditions, variants, files, bytes, inspect, hasAudio, master: fs.readFileSync(path.join(outDir, 'master.m3u8'), 'utf8') };
  }

  return { packageHls, buildArgs, renditionsFor, ffmpegBin };
}

module.exports = { createHlsPackager, renditionsFor, buildArgs, writeMaster, inspectPlaylists, avc1Codec, RENDITIONS, SEGMENT_SECONDS, AUDIO_KBPS, CONTENT_TYPES };
