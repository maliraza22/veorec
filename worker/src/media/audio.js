// Audio extraction (docs/09 §6, T-704): the STT input —
//   ffmpeg -i source -vn -c:a aac -b:a 96k audio/{recordingId}/audio.m4a
// verified by ffprobe (aac stream, duration within 2 % of the source) before
// anything publishes. A video-only source has nothing to extract.
'use strict';

const fs = require('fs');
const { run } = require('./exec');
const { silentLogger } = require('../logger');

function buildArgs(inPath, outPath) {
  return ['-hide_banner', '-nostdin', '-y', '-i', inPath, '-vn', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', outPath];
}

function createAudioExtractor({ ffmpegBin = 'ffmpeg', prober, logger = silentLogger() } = {}) {
  if (!prober) throw new Error('createAudioExtractor: a prober is required for output verification');

  /**
   * @returns {Promise<{facts, bytes}>} rejects with code 'aborted'|'timeout'|'ENOENT'|'tool_failed'|'output_invalid'
   */
  async function extract(inPath, outPath, { sourceFacts, signal = null, timeoutMs = 10 * 60 * 1000 } = {}) {
    await run(ffmpegBin, buildArgs(inPath, outPath), { timeout: timeoutMs, signal });
    const facts = await prober.probeFile(outPath, { signal });
    const problems = [];
    if (facts.unreadable || !facts.audio) problems.push('no audio stream in output');
    else if (facts.audio.codec !== 'aac') problems.push(`audio codec ${facts.audio.codec}`);
    if (facts.video) problems.push('unexpected video stream in output');
    const src = sourceFacts && Number(sourceFacts.durationSec);
    if (Number.isFinite(src) && src > 0) {
      const d = Number(facts.durationSec);
      if (!Number.isFinite(d) || Math.abs(d - src) / src > 0.02) problems.push(`duration ${d} s not within 2 % of source ${src} s`);
    }
    if (problems.length) { const e = new Error(`audio output failed verification: ${problems.join('; ')}`); e.code = 'output_invalid'; e.problems = problems; throw e; }
    const bytes = fs.statSync(outPath).size;
    logger.info({ duration_sec: facts.durationSec, bytes }, 'audio_extract: output verified');
    return { facts, bytes };
  }

  return { extract, buildArgs, ffmpegBin };
}

module.exports = { createAudioExtractor, buildArgs };
