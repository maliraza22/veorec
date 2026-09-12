// Probe & verification (docs/09 §2, invariants #11/#12): ffprobe establishes
// the facts — client metadata is never trusted.
//
//   probeFile(path)   → { container, formatNames, durationSec, durationSource,
//                        sizeBytes, video:{codec,width,height,fps}, audio:{codec}|null, streams }
//   validate(facts, { expectedSize }) → { ok, code, message }
//
// Duration: the container value when present; MediaRecorder WebM often has
// none (or Infinity) → the slow path decodes to the end (`ffmpeg -i in -f
// null -`) and reads the last reported time — only when the format lacks it.
'use strict';

const fs = require('fs');
const { run } = require('./exec');
const { silentLogger } = require('../logger');

const CONTAINERS = new Set(['webm', 'matroska', 'mp4', 'mov']);
const VIDEO_CODECS = new Set(['vp8', 'vp9', 'av1', 'h264', 'hevc']);
const AUDIO_CODECS = new Set(['opus', 'vorbis', 'aac', 'mp3']);
const MIN_DURATION_SEC = 0.5;
const MIN_DIM = 16, MAX_DIM = 7680;

/** ffprobe `format_name` is a comma list ("matroska,webm", "mov,mp4,m4a,3gp,3g2,mj2"). */
function containerOf(formatName) {
  const names = String(formatName || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (names.includes('webm')) return 'webm';
  if (names.includes('matroska')) return 'matroska';
  if (names.includes('mp4')) return 'mp4';
  if (names.includes('mov')) return 'mov';
  return names[0] || null;
}

function fpsOf(stream) {
  const r = String(stream.avg_frame_rate || stream.r_frame_rate || '0/1');
  const [n, d] = r.split('/').map(Number);
  return d ? Math.round((n / d) * 1000) / 1000 : 0;
}

/** Last `time=HH:MM:SS.xx` (or out_time_ms) from ffmpeg's null-decode stderr. */
function parseDecodedDuration(stderr) {
  let last = null;
  const re = /time=(\d+):(\d\d):(\d\d(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(String(stderr || '')))) last = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return last;
}

function createProber({ ffprobeBin = 'ffprobe', ffmpegBin = 'ffmpeg', logger = silentLogger(), probeTimeoutMs = 60000, decodeTimeoutMs = 5 * 60 * 1000 } = {}) {
  async function probeFile(filePath, { signal = null } = {}) {
    let sizeBytes = null;
    try { sizeBytes = fs.statSync(filePath).size; } catch { /* missing → ffprobe fails below */ }
    let json;
    try {
      const { out } = await run(ffprobeBin, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath], { timeout: probeTimeoutMs, signal });
      json = JSON.parse(out || '{}');
    } catch (e) {
      if (e && (e.code === 'aborted' || e.code === 'timeout' || e.code === 'ENOENT')) throw e;
      return { unreadable: true, error: e.message, sizeBytes, streams: [], video: null, audio: null, container: null, formatNames: [], durationSec: null, durationSource: 'none' };
    }
    const streams = Array.isArray(json.streams) ? json.streams : [];
    const format = json.format || {};
    const v = streams.find((s) => s.codec_type === 'video');
    const a = streams.find((s) => s.codec_type === 'audio');
    let durationSec = Number(format.duration);
    let durationSource = 'format';
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      const sd = Number((v && v.duration) || (a && a.duration));
      if (Number.isFinite(sd) && sd > 0) { durationSec = sd; durationSource = 'stream'; }
    }
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      // Slow path: decode to the end and take the last timestamp.
      durationSource = 'decoded';
      try {
        const { err } = await run(ffmpegBin, ['-hide_banner', '-nostdin', '-i', filePath, '-f', 'null', '-'], { timeout: decodeTimeoutMs, signal });
        durationSec = parseDecodedDuration(err);
      } catch (e) {
        if (e && (e.code === 'aborted' || e.code === 'timeout' || e.code === 'ENOENT')) throw e;
        durationSec = parseDecodedDuration(e.stderrTail) || null;
      }
      logger.info({ duration_sec: durationSec }, 'probe: format duration missing — decoded to the end');
    }
    return {
      unreadable: false,
      container: containerOf(format.format_name),
      formatNames: String(format.format_name || '').split(',').filter(Boolean),
      durationSec: Number.isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec * 1000) / 1000 : null,
      durationSource,
      sizeBytes: Number.isFinite(Number(format.size)) ? Number(format.size) : sizeBytes,
      bitRate: Number.isFinite(Number(format.bit_rate)) ? Number(format.bit_rate) : null,
      video: v ? { codec: String(v.codec_name || '').toLowerCase(), width: Number(v.width) || 0, height: Number(v.height) || 0, fps: fpsOf(v), pixFmt: v.pix_fmt || null } : null,
      audio: a ? { codec: String(a.codec_name || '').toLowerCase(), channels: Number(a.channels) || null, sampleRate: Number(a.sample_rate) || null } : null,
      streams: streams.map((s) => ({ type: s.codec_type, codec: s.codec_name })),
    };
  }

  /** docs/09 §2.3 — every rule; the first violated one is reported. */
  function validate(facts, { expectedSize = null } = {}) {
    if (!facts || facts.unreadable) return { ok: false, code: 'unreadable', message: `ffprobe could not read the file${facts && facts.error ? `: ${facts.error}` : ''}` };
    if (!facts.container || !CONTAINERS.has(facts.container)) return { ok: false, code: 'container_unsupported', message: `container "${facts.formatNames.join(',') || 'unknown'}" is not one of webm/matroska/mp4/mov` };
    if (!facts.video) return { ok: false, code: 'no_video_stream', message: 'the file has no video stream' };
    if (!VIDEO_CODECS.has(facts.video.codec)) return { ok: false, code: 'video_codec_unsupported', message: `video codec "${facts.video.codec}" is not one of vp8/vp9/av1/h264/hevc` };
    if (facts.audio && !(AUDIO_CODECS.has(facts.audio.codec) || /^pcm_/.test(facts.audio.codec))) return { ok: false, code: 'audio_codec_unsupported', message: `audio codec "${facts.audio.codec}" is not one of opus/vorbis/aac/mp3/pcm_*` };
    if (!Number.isFinite(facts.durationSec) || facts.durationSec <= MIN_DURATION_SEC) return { ok: false, code: 'duration_invalid', message: `duration ${facts.durationSec == null ? 'unknown' : facts.durationSec + ' s'} is not > ${MIN_DURATION_SEC} s` };
    const { width, height } = facts.video;
    if (!(width >= MIN_DIM && width <= MAX_DIM && height >= MIN_DIM && height <= MAX_DIM)) return { ok: false, code: 'dimensions_invalid', message: `dimensions ${width}x${height} are outside ${MIN_DIM}..${MAX_DIM}` };
    if (expectedSize != null && Number.isFinite(Number(expectedSize)) && Number(expectedSize) > 0 && facts.sizeBytes != null && Number(facts.sizeBytes) !== Number(expectedSize)) {
      return { ok: false, code: 'size_mismatch', message: `stored object is ${facts.sizeBytes} bytes but the upload recorded ${expectedSize}` };
    }
    return { ok: true, code: null, message: null };
  }

  return { probeFile, validate, ffprobeBin, ffmpegBin };
}

module.exports = { createProber, containerOf, parseDecodedDuration, CONTAINERS, VIDEO_CODECS, AUDIO_CODECS, MIN_DURATION_SEC, MIN_DIM, MAX_DIM };
