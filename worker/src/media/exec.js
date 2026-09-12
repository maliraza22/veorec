// Child-process runner + binary resolution for the media pipeline (docs/09 §9).
//
// Every ffmpeg/ffprobe invocation goes through `run`: bounded by a timeout,
// killed on the job's AbortSignal (SIGKILL — no zombie ffmpeg), stderr tail
// kept for `last_error`. Binaries come from FFMPEG_BIN/FFPROBE_BIN, else the
// static npm binaries when installed (local dev/test), else PATH names (the
// worker image ships system ffmpeg, docs/02 §2.2).
'use strict';

const path = require('path');
const { spawn } = require('child_process');

function resolveBinaries(env = process.env) {
  let ffmpegBin = env.FFMPEG_BIN || null;
  let ffprobeBin = env.FFPROBE_BIN || null;
  if (!ffmpegBin) { try { ffmpegBin = require('ffmpeg-static'); } catch { /* PATH */ } }
  if (!ffprobeBin) { try { ffprobeBin = require('ffprobe-static').path; } catch { /* PATH */ } }
  return { ffmpegBin: ffmpegBin || 'ffmpeg', ffprobeBin: ffprobeBin || 'ffprobe' };
}

/**
 * @returns {Promise<{out:string, err:string}>}
 * rejects with { code:'tool_failed'|'aborted'|'timeout'|'ENOENT', stderrTail }
 */
function run(cmd, args, { timeout = 0, signal = null, cwd = undefined, maxBuffer = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd, windowsHide: true }); }
    catch (e) { return reject(e); }
    let out = '', err = '', done = false;
    const finish = (fn, v) => { if (done) return; done = true; if (timer) clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); fn(v); };
    const kill = () => { try { p.kill('SIGKILL'); } catch { /* gone */ } };
    const onAbort = () => { kill(); finish(reject, Object.assign(new Error(`${path.basename(cmd)} aborted`), { code: 'aborted' })); };
    const timer = timeout ? setTimeout(() => { kill(); finish(reject, Object.assign(new Error(`${path.basename(cmd)} timed out after ${timeout} ms`), { code: 'timeout', stderrTail: err.slice(-2048) })); }, timeout) : null;
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    p.stdout.on('data', (d) => { if (out.length < maxBuffer) out += d; });
    p.stderr.on('data', (d) => { err += d; if (err.length > maxBuffer) err = err.slice(-maxBuffer); });
    p.on('error', (e) => finish(reject, Object.assign(e, { stderrTail: err.slice(-2048) })));
    p.on('close', (code) => {
      if (code === 0) finish(resolve, { out, err });
      else finish(reject, Object.assign(new Error(`${path.basename(cmd)} exited ${code}: ${err.slice(-400)}`), { code: 'tool_failed', exitCode: code, stderrTail: err.slice(-2048) }));
    });
  });
}

module.exports = { run, resolveBinaries };
