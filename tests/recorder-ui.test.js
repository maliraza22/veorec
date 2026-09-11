// T-503 recorder UI refactor tests (run: cd server && npm run test:recorder-ui)
//
// Since T-503 the recorder window is a RENDERER of RecorderMachine projections
// (docs/03 §1): no lifecycle booleans, every side effect an injected effect,
// every input an event. recorder.js needs DOM + chrome.*, so these are
// source-level assertions on that discipline and on the effect wiring; the
// same file is run end to end in a real browser with only chrome.* and the
// picker stubbed (recorded in docs/24).
'use strict';

const fs = require('fs');
const path = require('path');
const EXT = path.join(__dirname, '..', 'extension');
const rec = fs.readFileSync(path.join(EXT, 'recorder.js'), 'utf8');
const html = fs.readFileSync(path.join(EXT, 'recorder.html'), 'utf8');
const code = rec.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const M = require(path.join(EXT, 'machine.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const section = (startRe, endRe) => { const a = code.search(startRe); const b = code.slice(a + 1).search(endRe); return b < 0 ? code.slice(a) : code.slice(a, a + 1 + b); };

console.log('T-503 recorder UI refactor tests');

// ── A. One machine, one owner (docs/03 §1) ────────────────────────────────
console.log('\nA. Renderer discipline');
const scripts = html.match(/<script src="([^"]+)"><\/script>/g).map((s) => s.match(/"([^"]+)"/)[1]);
ok(scripts.indexOf('machine.js') < scripts.indexOf('capture.js') && scripts.indexOf('capture.js') < scripts.indexOf('recorder.js'), 'recorder.html loads machine.js and capture.js before recorder.js');
ok(/const machine = VeoRecMachine\.createMachine\(\{\s*effects,/.test(code), 'exactly one machine is created with the effects');
ok((code.match(/VeoRecMachine\.createMachine\(/g) || []).length === 1, 'and only one');
for (const v of ['let isRecording', 'let startTime', 'let pausedAccum', 'let pauseStartedAt', 'let limitReached', 'let limitWarned', 'let timerInterval', 'let hardStopTimer', 'let audioCtx', 'let activeStreams']) {
  ok(!code.includes(v + ' '), `no private lifecycle state: ${v}`);
}
ok(!/function beginRecording|function handleStop|function togglePause|function cancelRecording|function restartRecording|function stopRecording\(/.test(code), 'the imperative lifecycle functions are gone');
ok(!/mediaRecorder\.onstop = null/.test(code), 'the onstop=null trick is gone (cancelling suppresses the pipeline in the machine)');
ok(/mainBtn\.addEventListener\('click', \(\) => \{ if \(!mainBtn\.dataset\.custom\) startRecording\(\); \}\)/.test(code), 'Start → startRecording (→ START / RETRY)');
ok(/pauseBtn\.addEventListener\('click', \(\) => machine\.send\(\{ type: machine\.state === 'paused' \? 'RESUME' : 'PAUSE' \}\)\)/.test(code), 'Pause/Resume → PAUSE / RESUME');
ok(/stopBtn\.addEventListener\('click', \(\) => machine\.send\(\{ type: 'STOP', source: 'user' \}\)\)/.test(code), 'Stop → STOP(user)');
ok(/cancelBtn\.addEventListener\('click', \(\) => \{ machine\.send\(\{ type: 'CANCEL' \}\)/.test(code), 'Cancel → CANCEL');
const msgSrc = section(/chrome\.runtime\.onMessage\.addListener/, /window\.addEventListener\('beforeunload'/);
ok(/'STOP_RECORDING' \|\| msg\.type === 'SR_STOP'\) machine\.send\(\{ type: 'STOP'/.test(msgSrc) && /'SR_PAUSE'\) machine\.send/.test(msgSrc) && /'SR_CANCEL'\) \{ machine\.send\(\{ type: 'CANCEL' \}\)/.test(msgSrc) && /'SR_RESTART'\) machine\.send\(\{ type: 'RESTART' \}\)/.test(msgSrc),
  'popup/overlay commands map 1:1 onto events (docs/03 §12; invalid-in-state ones are ignored by the machine)');
ok(!/const active = mediaRecorder && mediaRecorder\.state/.test(code), 'no ad-hoc "active" gate in front of commands');

// ── B. Effects (docs/03 §3) ──────────────────────────────────────────────
console.log('\nB. Effects');
const fx = section(/const effects = \{/, /const machine = VeoRecMachine\.createMachine/);
const has = (name) => new RegExp(`\\n  (async )?${name}\\(`).test(fx);
for (const name of ['acquire', 'startCountdown', 'createSession', 'createUploadSession', 'startRecorder', 'pauseRecorder', 'resumeRecorder', 'stopRecorder', 'stopTracks', 'finalize', 'startUpload', 'complete', 'download', 'discard', 'cleanup', 'wakeLock', 'setTimer', 'persist', 'warn', 'clearProjection', 'publish']) {
  ok(has(name), `effect ${name} is provided`);
}
ok(/captureManager\.acquire\(config\)\.then\([\s\S]*?machine\.send\(\{ type: 'ACQUIRED', tracks: result\.tracks, warnings: result\.warnings \}\)/.test(fx) && /machine\.send\(\{ type: 'ACQUIRE_FAILED', code: \(err && err\.code\) \|\| 'capture_failed'/.test(fx),
  'acquire → CaptureManager (T-502) → ACQUIRED / ACQUIRE_FAILED with the docs/18 §4 code');
ok(/const captureManager = \(typeof VeoRecCapture !== 'undefined'\) \? VeoRecCapture\.createCaptureManager\(\{\}\) : null/.test(code), 'all getUserMedia/getDisplayMedia calls live in CaptureManager — none here');
ok(!/getDisplayMedia|getUserMedia|new AudioContext/.test(code), 'recorder.js itself makes no capture calls');
ok(/mediaRecorder\.onstop = \(\) => machine\.send\(\{ type: 'RECORDER_STOPPED' \}\)/.test(fx), 'onstop → RECORDER_STOPPED');
ok(/mediaRecorder\.onerror = \(\) => machine\.send\(\{ type: 'STOP', source: 'recorder_error' \}\)/.test(fx), 'onerror → STOP(recorder_error): salvage what exists (docs/03 §6)');
ok(/machine\.send\(\{ type: 'CHUNK', size: e\.data\.size \}\)/.test(fx), 'every dataavailable feeds the machine\'s limit clock');
ok(/mediaRecorder\.start\(1000\)/.test(fx), '1 s timeslice');
ok(/captureManager\.recorderOptions\(opts\)/.test(fx), 'MediaRecorder options come from CaptureManager (mime chain + bitrates)');
ok(/captureManager\.watch\(\{ streams: capture\.streams, mixer: capture\.mixer, onEvent: \(e\) => machine\.send\(e\) \}\)/.test(fx), 'interruption watchers feed TRACK_ENDED / MIC_LOST to the machine');
const stopRec = section(/\n  stopRecorder\(\) \{/, /\n  stopTracks\(\) \{/);
ok(/mediaRecorder\.stop\(\)/.test(stopRec) && !/dispose|getTracks|closeBubble/.test(stopRec), 'stopRecorder stops the recorder and NOTHING else (docs/03 §3.6)');
const stopTr = section(/\n  stopTracks\(\) \{/, /\n  finalize\(ctx\) \{/);
ok(/capture\.dispose\(\)/.test(stopTr) && /captureWatchOff\(\)/.test(stopTr), 'stopTracks disposes the capture (tracks + AudioContext) and the watchers — only after RECORDER_STOPPED');
ok(/wakeLock\(\) \{[\s\S]*?navigator\.wakeLock/.test(fx) && /return \(\) => \{ try \{ lock && lock\.release\(\)/.test(fx), 'a screen wake lock with a disposer');
ok(/setTimer\(fn, ms\) \{ const t = setTimeout\(fn, ms\); return \(\) => clearTimeout\(t\); \}/.test(fx), 'timers are disposable');
const complete = section(/\n  complete\(ctx\) \{/, /\n  download\(\) \{/);
ok(/await deleteLocalSession\(\);/.test(complete) && /lastRecording/.test(complete) && /openTab\(url\)/.test(complete) && /setTimeout\(closeWindow, 1200\)/.test(complete), 'completed: delete local session (server 200), lastRecording, open watch page, close after 1.2 s (docs/03 §3.10)');
const cleanup = section(/\n  cleanup\(ctx\) \{/, /\n  wakeLock\(\) \{/);
ok(/machine\.send\(\{ type: 'CLEANED' \}\)/.test(cleanup) && /discardLocalSession\(\)/.test(cleanup) && /capture\.dispose\(\)/.test(cleanup), 'cancelling: recorder stopped, tracks disposed, local session discarded, then CLEANED (docs/03 §3.11)');
ok(/machine\.send\(\{ type: 'STOP', source: 'byte_limit' \}\)/.test(code), 'the uploader\'s ceiling-reached → STOP(byte_limit) (docs/03 §8 layer 1)');
ok(/machine\.send\(\{ type: 'UPLOAD_PROGRESS', pct:/.test(code), 'upload progress is an event');
ok(/durationLimitSec: recordingLimitSec/.test(code), 'the plan duration limit is passed to the machine at START');

// ── C. Projection contract (docs/03 §11) ──────────────────────────────────
console.log('\nC. Projection');
const publish = section(/\n  publish\(projection, state, ctx\) \{/, /\n\};/);
ok(/chrome\.storage\.local\.set\(\{ recSession: projection, recording: !!projection\.recording, startTime: projection\.startedAt, recState \}\)/.test(publish), 'recSession is written on every publish with the legacy keys mirrored');
ok(/\{ recording: true, startTime: projection\.startedAt, paused: state === 'paused', pausedAccum: projection\.pausedTotal, pauseStartedAt: projection\.pauseStartedAt \}/.test(publish),
  'the legacy recState carries exactly what the overlay reads (recording, startTime, paused, pausedAccum, pauseStartedAt)');
ok(/\{ recording: false \}/.test(publish), 'and recording:false when not recording (background.js keys off it)');
const overlay = fs.readFileSync(path.join(EXT, 'overlay.js'), 'utf8');
ok(/recState/.test(overlay) && /pausedAccum|pauseStartedAt/.test(overlay), 'the overlay still reads the mirrored recState (unchanged consumer)');
ok(/const s = Math\.floor\(machine\.elapsedMs\(\) \/ 1000\)/.test(code), 'the timer renders the machine\'s elapsed — computed in one place (docs/03 §3.5)');
ok(!/Date\.now\(\) - startTime/.test(code), 'no second elapsed formula');

// ── D. UI states: mic-denied choice, upload progress, failures ───────────
console.log('\nD. UI states');
const pd = section(/function renderPermissionDenied\(ctx\)/, /async function startRecording/);
ok(/code === 'mic_denied'/.test(pd) && /Record without mic/.test(pd) && /Fix permission/.test(pd) && /Cancel/.test(pd), 'mic denied → explicit three-way choice (docs/03 §3.2)');
ok(/machine\.send\(\{ type: 'RETRY', config: \{ audio: false \} \}\)/.test(pd), '"Record without mic" re-enters acquiring with audio:false');
ok(/machine\.send\(\{ type: 'RETRY' \}\)/.test(pd) && /machine\.send\(\{ type: 'DISMISS' \}\)/.test(pd), '"Fix permission" retries; Cancel dismisses');
for (const c of ['permission_dismissed', 'permission_denied', 'no_device', 'tab_capture_failed', 'constraint_failed', 'device_busy']) ok(new RegExp(`${c}:`).test(pd), `docs/18 §4 copy for ${c}`);
ok(/Click “Start Recording”, then choose what to share\./.test(pd), 'the existing picker-cancelled copy is kept');
const render = section(/function render\(projection, state, ctx\)/, /let renderedWarning/);
ok(/state === 'uploading'/.test(render) && /Uploading… \$\{pct\}%/.test(render), 'uploading renders progress');
ok(/state === 'countdown'/.test(render) && /'Get ready…'/.test(render), 'countdown renders');
ok(/state === 'paused'/.test(render) && /'⏸ Paused'/.test(render) && /'▶ Resume' : '⏸ Pause'/.test(render), 'paused renders and the button flips');
ok(/stopSource === 'limit'/.test(render) && /Recording limit reached/.test(render), 'the limit stop is explained');
ok(/state === 'saved_locally'/.test(render) && /state === 'completed'/.test(render) && /state === 'permission_denied'/.test(render) && /state === 'upload_failed'/.test(render), 'every terminal / failure state renders');
const uf = section(/function renderUploadFailed\(ctx\)/, /function renderPermissionDenied/);
ok(/code === 'plan_limit'/.test(uf) && /showUpgradePrompt\(message\); showQuotaOptions\(\)/.test(uf), 'a plan refusal keeps the T-307 options');
ok(/'↻ Retry upload'/.test(uf) && /machine\.send\(\{ type: 'RETRY_UPLOAD' \}\)/.test(uf) && /retry\.style\.display = ctx\.retryable \? '' : 'none'/.test(uf), 'Retry is offered only when retryable (docs/03 §3.9)');
ok(/showDownloadFallback\(\)/.test(uf) && /machine\.send\(\{ type: 'DOWNLOAD_FALLBACK' \}\)/.test(code), 'Save to device → DOWNLOAD_FALLBACK');
ok(/window\.addEventListener\('beforeunload'/.test(code) && /\['recording', 'paused', 'stopping', 'finalizing', 'uploading'\]\.includes\(s\)/.test(code), 'closing the window while active or uploading warns (docs/03 §9)');
const warnFx = section(/const WARN_TEXT = /, /function render\(projection/);
ok(/VeoRecCapture\.WARNING_TEXT\[code\]/.test(warnFx) && /duration_limit_near/.test(warnFx) && /byte_limit_near/.test(warnFx), 'warnings render from CaptureManager texts plus the limit warnings');

// ── E. The machine drives the recorder's contract ─────────────────────────
console.log('\nE. Contract');
// The effects the recorder provides are exactly the ones the machine can call.
const machineSrc = fs.readFileSync(path.join(EXT, 'machine.js'), 'utf8');
const wanted = [...new Set([...machineSrc.matchAll(/fx\('([a-zA-Z]+)'/g)].map((m) => m[1]))];
for (const name of wanted) ok(has(name) || name === 'chunk', `the machine's effect "${name}" is provided (chunk is handled inline in startRecorder)`);
// Launch order (docs/03 §3.0/§3.1): options → limit → recovery scan → pre-flight → START.
const launch = section(/\(async \(\) => \{\s*try \{\s*const \{ recOptions \}/, /\}\)\(\);\s*$/);
ok(/await loadPlanLimit\(\);[\s\S]*?await runRecoveryScan\(\)[\s\S]*?await loadQuotaPreflight\(\)[\s\S]*?startRecording\(\);/.test(launch), 'launch order: plan limit → recovery scan → quota pre-flight → START');
ok(/if \(opts\.countdown === true\) opts\.countdown = 3;/.test(launch), 'the legacy countdown:true is normalised to 3 s');

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
