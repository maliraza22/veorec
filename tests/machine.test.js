// T-501 RecorderMachine tests (run: cd server && npm run test:machine)
//
// The machine is pure (docs/03 §1): every side effect is an injected effect
// that records its calls, and time is a controllable clock. Sections:
//   A. exhaustive transition table — every state × every event
//   B. entry-order guarantees, elapsed math, limit enforcement
//   C. disposer registry (leak assertion in idle, per-state disposal)
//   D. projection contract + legacy mirror, re-entrancy, ignored events
// Branch coverage of extension/machine.js is measured by tests/coverage-machine.js.
'use strict';

const path = require('path');
const M = require(path.join(__dirname, '..', 'extension', 'machine.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const MiB = 1024 * 1024;

/** A machine with recording effects that track calls and hand back disposers. */
function harness(over = {}) {
  let clock = 1_000_000;
  const calls = [];
  const logs = [];
  const timers = [];
  const disposed = [];
  const effects = {
    acquire: (config) => { calls.push(['acquire', config]); },
    startCountdown: (sec) => { calls.push(['startCountdown', sec]); return () => disposed.push('countdown'); },
    createSession: () => { calls.push(['createSession']); return 'sess-1'; },
    createUploadSession: () => { calls.push(['createUploadSession']); },
    startRecorder: () => { calls.push(['startRecorder']); },
    pauseRecorder: () => { calls.push(['pauseRecorder']); },
    resumeRecorder: () => { calls.push(['resumeRecorder']); },
    stopRecorder: () => { calls.push(['stopRecorder']); },
    stopTracks: () => { calls.push(['stopTracks']); },
    finalize: () => { calls.push(['finalize']); },
    startUpload: () => { calls.push(['startUpload']); },
    complete: () => { calls.push(['complete']); },
    download: () => { calls.push(['download']); },
    discard: () => { calls.push(['discard']); },
    cleanup: () => { calls.push(['cleanup']); },
    wakeLock: () => { calls.push(['wakeLock']); return () => disposed.push('wake'); },
    setTimer: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); calls.push(['setTimer', ms]); return () => { t.cancelled = true; disposed.push('timer:' + ms); }; },
    publish: (p) => { calls.push(['publish', p.state]); },
    persist: (patch) => { calls.push(['persist', patch.status]); },
    clearProjection: () => { calls.push(['clearProjection']); },
    warn: (code) => { calls.push(['warn', code]); },
    chunk: () => { calls.push(['chunk']); },
    ...over,
  };
  const m = M.createMachine({ effects, now: () => clock, log: (level, msg) => logs.push(`${level}:${msg}`) });
  return { m, calls, logs, timers, disposed, effects, tick: (ms) => { clock += ms; }, get clock() { return clock; } };
}
const names = (calls) => calls.map((c) => c[0]);
const fireTimer = (h, ms) => { const t = h.timers.find((x) => x.ms === ms && !x.cancelled); if (t) t.fn(); return !!t; };

/** Drive a fresh machine into `state` through the happy path. */
function reach(state, over = {}) {
  const h = harness(over);
  const m = h.m;
  const seq = {
    idle: [],
    acquiring: [['START', { config: { countdown: 3 } }]],
    permission_denied: [['START', { config: {} }], ['ACQUIRE_FAILED', { code: 'permission_denied' }]],
    countdown: [['START', { config: { countdown: 3 } }], ['ACQUIRED', { tracks: {} }]],
    recording: [['START', { config: { countdown: 0 } }], ['ACQUIRED', { tracks: {} }]],
    paused: [['START', { config: { countdown: 0 } }], ['ACQUIRED', { tracks: {} }], ['PAUSE']],
    stopping: [['START', { config: { countdown: 0 } }], ['ACQUIRED', { tracks: {} }], ['STOP', { source: 'user' }]],
    finalizing: [['START', { config: { countdown: 0 } }], ['ACQUIRED', { tracks: {} }], ['STOP', { source: 'user' }], ['RECORDER_STOPPED']],
    uploading: [['START', { config: { countdown: 0 } }], ['ACQUIRED', { tracks: {} }], ['STOP', { source: 'user' }], ['RECORDER_STOPPED'], ['FINALIZED', { recordingId: 'rec_1' }]],
    upload_failed: [['START', { config: { countdown: 0 } }], ['ACQUIRED', { tracks: {} }], ['STOP', { source: 'user' }], ['RECORDER_STOPPED'], ['FINALIZED', { recordingId: 'rec_1' }], ['UPLOAD_FAILED', { code: 'x', retryable: true }]],
    completed: [['START', { config: { countdown: 0 } }], ['ACQUIRED', { tracks: {} }], ['STOP', { source: 'user' }], ['RECORDER_STOPPED'], ['FINALIZED', { recordingId: 'rec_1' }], ['UPLOAD_COMPLETE', { recordingId: 'rec_1', watchUrl: 'u' }]],
    saved_locally: [['START', { config: { countdown: 0 } }], ['ACQUIRED', { tracks: {} }], ['STOP', { source: 'user' }], ['RECORDER_STOPPED'], ['FINALIZED', { recordingId: 'rec_1' }], ['UPLOAD_FAILED', { code: 'x' }], ['DOWNLOAD_FALLBACK']],
    cancelling: [['START', { config: { countdown: 0 } }], ['ACQUIRED', { tracks: {} }], ['CANCEL']],
  }[state];
  for (const [type, payload] of seq) m.send({ type, ...(payload || {}) });
  if (m.state !== state) throw new Error(`reach(${state}) landed in ${m.state}`);
  return h;
}

(async () => {
  console.log('T-501 RecorderMachine tests');

  // ── A. Exhaustive transition table (docs/03 §2) ──────────────────────────
  console.log('\nA. Transition table');
  // expected[state][event] = next state ('=' means handled but stays; undefined means ignored+logged)
  const expected = {
    idle: { START: 'acquiring' },
    acquiring: { ACQUIRED: 'recording', ACQUIRE_FAILED: 'permission_denied', CANCEL: 'cancelling' },
    permission_denied: { RETRY: 'acquiring', DISMISS: 'idle', CANCEL: 'idle' },
    countdown: { COUNTDOWN_DONE: 'recording', CANCEL: 'cancelling', RESTART: 'cancelling', TRACK_ENDED: 'cancelling' },
    recording: { PAUSE: 'paused', STOP: 'stopping', CANCEL: 'cancelling', RESTART: 'cancelling', CHUNK: '=', TICK: '=', TRACK_ENDED: 'stopping', MIC_LOST: '=', WARNING: '=', UPLOAD_PROGRESS: '=' },
    paused: { RESUME: 'recording', STOP: 'stopping', CANCEL: 'cancelling', RESTART: 'cancelling', TRACK_ENDED: 'stopping', CHUNK: '=' },
    stopping: { RECORDER_STOPPED: 'finalizing', STOP_TIMEOUT: 'finalizing', CHUNK: '=', CANCEL: 'cancelling' },
    finalizing: { FINALIZED: 'uploading', UPLOAD_FAILED: 'upload_failed', CANCEL: 'cancelling' },
    uploading: { UPLOAD_PROGRESS: '=', UPLOAD_COMPLETE: 'completed', UPLOAD_FAILED: 'upload_failed' },
    upload_failed: { RETRY_UPLOAD: 'uploading', DOWNLOAD_FALLBACK: 'saved_locally', DISCARD: 'idle' },
    completed: {},
    saved_locally: {},
    cancelling: { CLEANED: 'idle', CHUNK: '=' },
  };
  let cells = 0;
  for (const state of M.STATES) {
    for (const event of M.EVENTS) {
      const h = reach(state);
      const before = h.m.state;
      const logsBefore = h.logs.length;
      // A CANCEL-from-countdown for ACQUIRED in 'acquiring' with countdown:3 lands in 'countdown'; the table above uses countdown:0 for `recording`.
      const payload = event === 'ACQUIRED' && state === 'acquiring' ? { tracks: {} } : event === 'STOP' ? { source: 'user' } : event === 'CHUNK' ? { size: 10 } : {};
      const after = h.m.send({ type: event, ...payload });
      const exp = expected[state][event];
      cells += 1;
      if (exp === undefined) {
        ok(after === before && h.logs.slice(logsBefore).some((l) => /ignored in state/.test(l)), `${state} × ${event}: ignored and logged (stays ${before})`);
      } else if (exp === '=') {
        ok(after === before && !h.logs.slice(logsBefore).some((l) => /ignored/.test(l)), `${state} × ${event}: handled, stays ${before}`);
      } else {
        const want = (state === 'acquiring' && event === 'ACQUIRED') ? 'countdown' : exp;   // reach('acquiring') uses countdown:3
        ok(after === want, `${state} × ${event}: → ${want} (got ${after})`);
      }
    }
  }
  ok(cells === M.STATES.length * M.EVENTS.length, `every cell exercised (${cells})`);
  // ACQUIRED without a countdown goes straight to recording.
  { const h = harness(); h.m.send({ type: 'START', config: { countdown: 0 } }); ok(h.m.send({ type: 'ACQUIRED', tracks: {} }) === 'recording', 'ACQUIRED [no countdown] → recording'); }
  // CLEANED [restart] → acquiring.
  { const h = reach('recording'); h.m.send({ type: 'RESTART' }); ok(h.m.state === 'cancelling' && h.m.context.restart === true, 'RESTART → cancelling with restart=true'); ok(h.m.send({ type: 'CLEANED' }) === 'acquiring', 'CLEANED [restart=true] → acquiring'); ok(names(h.calls).filter((n) => n === 'acquire').length === 2, 'acquire is requested again'); }
  { const h = reach('cancelling'); ok(h.m.send({ type: 'CLEANED' }) === 'idle', 'CLEANED [restart=false] → idle'); }
  // permission_denied RETRY carries a config override (Record without mic).
  { const h = reach('permission_denied'); h.m.send({ type: 'RETRY', config: { audio: false } }); ok(h.m.state === 'acquiring' && h.m.context.config.audio === false && h.calls.filter((c) => c[0] === 'acquire').pop()[1].audio === false, 'RETRY re-enters acquiring with the overridden config'); }
  // Terminal states accept nothing.
  for (const t of ['completed', 'saved_locally']) { const h = reach(t); ok(h.m.isTerminal && h.m.send({ type: 'START', config: {} }) === t, `${t} is terminal`); }
  // Malformed / unknown events.
  { const h = harness(); ok(h.m.send(null) === 'idle' && h.m.send({}) === 'idle' && h.m.send({ type: 'BOGUS' }) === 'idle' && h.logs.length === 3, 'malformed and unknown events are ignored and logged, never thrown'); }

  // ── B. Entry order, elapsed, limits (docs/03 §3.4, §3.5, §8) ─────────────
  console.log('\nB. Entry actions, elapsed and limits');
  {
    const h = reach('recording');
    const n = names(h.calls);
    const order = ['createSession', 'createUploadSession', 'startRecorder', 'wakeLock'].map((x) => n.indexOf(x));
    ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), 'recording entry: session row → upload session → recorder → wake lock, in that order');
    ok(h.m.context.sessionId === 'sess-1' && h.m.context.startedAt === h.clock, 'the session id and the wall clock are recorded');
    // Elapsed excludes pauses, computed in one place.
    h.tick(10_000); h.m.send({ type: 'PAUSE' }); h.tick(30_000);
    ok(h.m.elapsedMs() === 10_000, 'elapsed stops while paused');
    ok(names(h.calls).includes('pauseRecorder'), 'pause calls the recorder');
    h.m.send({ type: 'RESUME' }); h.tick(5_000);
    ok(h.m.elapsedMs() === 15_000 && h.m.context.pausedTotal === 30_000, 'elapsed = now − startedAt − pausedTotal (±0 here)');
    ok(names(h.calls).includes('resumeRecorder') && names(h.calls).filter((x) => x === 'createSession').length === 1, 'resume does NOT re-run the recording entry');
    // Stop from paused folds the open pause in.
    h.m.send({ type: 'PAUSE' }); h.tick(7_000); h.m.send({ type: 'STOP', source: 'user' });
    ok(h.m.state === 'stopping' && h.m.context.pausedTotal === 37_000 && h.m.context.pauseStartedAt === null, 'STOP from paused folds the open pause into pausedTotal');
    ok(names(h.calls).includes('stopRecorder') && !names(h.calls).includes('stopTracks'), 'stopping stops the recorder and NOTHING else (tracks still live)');
    h.m.send({ type: 'RECORDER_STOPPED' });
    ok(h.m.state === 'finalizing' && names(h.calls).includes('stopTracks') && h.disposed.includes('wake'), 'finalizing stops the tracks and releases the wake lock');
    ok(h.m.context.clientDuration === 15, 'clientDuration is the elapsed seconds');
    h.m.send({ type: 'FINALIZED', recordingId: 'rec_9' });
    ok(h.m.state === 'uploading' && names(h.calls).includes('startUpload'), 'uploading starts the upload drain');
    h.m.send({ type: 'UPLOAD_PROGRESS', pct: 40 });
    ok(h.m.context.uploadedPct === 40 && h.m.projection().uploadedPct === 40, 'progress is projected');
    h.m.send({ type: 'UPLOAD_COMPLETE', recordingId: 'rec_9', watchUrl: 'https://w' });
    ok(h.m.state === 'completed' && names(h.calls).includes('complete') && h.m.context.uploadedPct === 100, 'completion runs the complete effect');
  }
  // Stop guard: onstop never arrives.
  {
    const h = reach('stopping');
    ok(h.timers.some((t) => t.ms === M.STOP_GUARD_MS), 'a 10 s guard timer is armed on stopping');
    ok(fireTimer(h, M.STOP_GUARD_MS) && h.m.state === 'finalizing' && h.logs.some((l) => /forcing finalize/.test(l)), 'a lost onstop forces finalizing with the chunks we have');
    ok(h.disposed.includes('timer:' + M.STOP_GUARD_MS) || h.timers.find((t) => t.ms === M.STOP_GUARD_MS).cancelled === false, 'the guard disposer ran on exit');
  }
  {
    const h = reach('stopping');
    h.m.send({ type: 'RECORDER_STOPPED' });
    ok(h.timers.find((t) => t.ms === M.STOP_GUARD_MS).cancelled === true, 'a timely onstop cancels the guard timer');
  }
  // Duration limit: encoder-clock primary, backstop timer, 30 s warning, clamp.
  {
    const h = harness();
    h.m.send({ type: 'START', config: { countdown: 0 }, durationLimitSec: 60 });
    h.m.send({ type: 'ACQUIRED', tracks: {} });
    ok(h.timers.some((t) => t.ms === 60_500), 'the duration backstop is armed at limit + 500 ms');
    h.tick(31_000); h.m.send({ type: 'CHUNK', size: 100 });
    ok(h.m.context.warning === 'duration_limit_near' && h.calls.some((c) => c[0] === 'warn' && c[1] === 'duration_limit_near'), 'a 30 s warning fires once from the chunk clock');
    h.tick(20_000); h.m.send({ type: 'CHUNK', size: 100 });
    ok(h.m.state === 'recording' && h.calls.filter((c) => c[0] === 'warn').length === 1, 'the warning fires only once');
    h.tick(10_000); h.m.send({ type: 'CHUNK', size: 100 });
    ok(h.m.state === 'stopping' && h.m.context.stopSource === 'limit', 'reaching the limit inside dataavailable stops with source=limit');
    h.m.send({ type: 'RECORDER_STOPPED' });
    ok(h.m.context.clientDuration === 60, 'clientDuration is clamped to the limit');
  }
  {
    const h = harness();
    h.m.send({ type: 'START', config: { countdown: 0 }, durationLimitSec: 60 });
    h.m.send({ type: 'ACQUIRED', tracks: {} });
    h.tick(61_000);
    ok(fireTimer(h, 60_500) && h.m.state === 'stopping' && h.m.context.stopSource === 'limit', 'the backstop timer trips the limit when the chunk clock is throttled');
  }
  // Byte ceiling: warn at 90%, stop at ceiling − 16 MiB.
  {
    const h = harness();
    h.m.send({ type: 'START', config: { countdown: 0 }, byteCeiling: 100 * MiB });
    h.m.send({ type: 'ACQUIRED', tracks: {} });
    h.m.send({ type: 'CHUNK', size: 50 * MiB });
    ok(h.m.state === 'recording' && !h.m.context.byteWarned, '50% — nothing');
    h.m.send({ type: 'CHUNK', size: 20 * MiB });
    ok(h.m.context.warning !== 'byte_limit_near' && h.m.context.byteWarned === false, '70% of the ceiling — no warning yet (the 90% rule)');
    h.m.send({ type: 'CHUNK', size: 15 * MiB });                    // 85 MiB ≥ 84 MiB (100−16) → stop
    ok(h.m.state === 'stopping' && h.m.context.stopSource === 'byte_limit', 'reaching ceiling − 16 MiB stops with source=byte_limit (the take is preserved)');
  }
  {
    const h = harness();
    h.m.send({ type: 'START', config: { countdown: 0 }, byteCeiling: 100 * MiB });
    h.m.send({ type: 'ACQUIRED', tracks: {} });
    h.m.send({ type: 'CHUNK', size: 83 * MiB });                    // < 84 stop, but ≥ 90? no (90 MiB)
    ok(h.m.state === 'recording' && h.m.context.warning !== 'byte_limit_near', '83 MiB of 100: no stop, no 90% warning yet');
    h.m.send({ type: 'CHUNK', size: 0 });
    ok(h.m.state === 'recording', 'a zero-size chunk changes nothing');
  }
  {
    const h = harness();
    h.m.send({ type: 'START', config: { countdown: 0 }, byteCeiling: 1000 * MiB });
    h.m.send({ type: 'ACQUIRED', tracks: {} });
    h.m.send({ type: 'CHUNK', size: 901 * MiB });
    ok(h.m.state === 'recording' && h.m.context.warning === 'byte_limit_near' && h.calls.some((c) => c[0] === 'warn' && c[1] === 'byte_limit_near'), '90% warning fires while still under the stop margin');
  }
  // Interruptions (docs/03 §9).
  { const h = reach('recording'); h.m.send({ type: 'TRACK_ENDED', kind: 'video' }); ok(h.m.state === 'stopping' && h.m.context.stopSource === 'track_ended', 'screen-share ended → STOP(track_ended)'); }
  { const h = reach('recording'); h.m.send({ type: 'TRACK_ENDED', kind: 'mic' }); ok(h.m.state === 'recording' && h.m.context.warning === 'mic_lost', 'mic ended → keep recording, mic_lost warning'); }
  { const h = reach('recording'); h.m.send({ type: 'TRACK_ENDED', kind: 'tab_audio' }); ok(h.m.state === 'recording' && h.m.context.warning === 'tab_audio_lost', 'tab audio ended → keep recording, tab_audio_lost'); }
  { const h = reach('paused'); h.m.send({ type: 'TRACK_ENDED', kind: 'mic' }); ok(h.m.state === 'paused' && h.m.context.warning === 'mic_lost', 'mic ended while paused → warning, stay paused'); }
  { const h = reach('paused'); h.tick(4000); h.m.send({ type: 'TRACK_ENDED', kind: 'video' }); ok(h.m.state === 'stopping' && h.m.context.pausedTotal === 4000, 'share ended while paused → stopping, pause folded in'); }
  { const h = reach('recording'); h.m.send({ type: 'WARNING', code: 'audio_suspended' }); ok(h.m.context.warning === 'audio_suspended', 'an external WARNING is projected'); }
  // Cancelling suppresses the chunk pipeline.
  { const h = reach('cancelling'); const before = h.m.context.chunkCount; h.m.send({ type: 'CHUNK', size: 10 }); ok(h.m.context.chunkCount === before && !h.calls.some((c) => c[0] === 'chunk'), 'chunks are dropped while discarding'); ok(names(h.calls).includes('cleanup'), 'cancelling requests cleanup'); }
  // The final flush during stopping still counts.
  { const h = reach('stopping'); h.m.send({ type: 'CHUNK', size: 5 }); ok(h.m.context.chunkCount === 1 && h.calls.some((c) => c[0] === 'chunk'), 'the final dataavailable during stopping is kept'); }
  { const h = reach('paused'); h.m.send({ type: 'CHUNK', size: 5 }); ok(h.m.context.chunkCount === 1, 'a chunk arriving in paused is kept'); }
  // upload_failed paths.
  { const h = reach('upload_failed'); ok(h.m.context.retryable === true, 'retryable is recorded'); h.m.send({ type: 'RETRY_UPLOAD' }); ok(h.m.state === 'uploading' && names(h.calls).filter((x) => x === 'startUpload').length === 2, 'RETRY_UPLOAD restarts the drain'); }
  { const h = reach('upload_failed'); h.m.send({ type: 'DOWNLOAD_FALLBACK' }); ok(h.m.state === 'saved_locally' && names(h.calls).includes('download'), 'DOWNLOAD_FALLBACK → saved_locally + download effect'); }
  { const h = reach('upload_failed'); h.m.send({ type: 'DISCARD' }); ok(h.m.state === 'idle' && names(h.calls).includes('discard'), 'DISCARD → idle + discard effect'); }
  { const h = reach('finalizing'); h.m.send({ type: 'UPLOAD_FAILED', code: 'no_session' }); ok(h.m.state === 'upload_failed', 'a failure surfaced during finalizing goes to upload_failed'); }

  // ── C. Disposer registry (docs/03 §10) ──────────────────────────────────
  console.log('\nC. Disposers');
  {
    const h = reach('completed');
    ok(h.m.leaks().length === 0, 'nothing leaks after a full happy path');
  }
  {
    const h = reach('recording');
    ok(h.m.leaks().includes('wake-lock'), 'the wake lock is registered while recording');
    h.m.send({ type: 'CANCEL' }); h.m.send({ type: 'CLEANED' });
    ok(h.m.state === 'idle' && h.m.leaks().length === 0 && h.disposed.includes('wake'), 'cancel → idle leaves an empty registry');
  }
  {
    const h = reach('countdown');
    ok(h.m.leaks().includes('countdown-timer'), 'the countdown timer is registered');
    h.m.send({ type: 'COUNTDOWN_DONE' });
    ok(!h.m.leaks().includes('countdown-timer') && h.disposed.includes('countdown'), 'countdown exit disposes its timer');
  }
  {
    const h = reach('recording');
    h.m.send({ type: 'PAUSE' });
    ok(h.m.leaks().includes('wake-lock'), 'pausing keeps the recording-owned resources (wake lock)');
  }
  {
    const h = harness();
    let n = 0;
    h.m.register('x', 'idle', () => { n += 1; });
    h.m.register('x', 'idle', () => { n += 10; });
    ok(n === 1 && h.m.leaks().length === 1, 're-registering an id disposes the previous one first');
    h.m.dispose('x');
    ok(n === 11 && h.m.leaks().length === 0 && h.m.dispose('x') === false, 'dispose is idempotent');
    let threw = null; try { h.m.register('y', 'idle', 'nope'); } catch (e) { threw = e; }
    ok(threw instanceof TypeError, 'a non-function disposer is refused');
    h.m.register('bad', 'idle', () => { throw new Error('boom'); });
    h.m.disposeAll();
    ok(h.m.leaks().length === 0 && h.logs.some((l) => /disposer bad threw/.test(l)), 'a throwing disposer is logged and the registry still empties');
  }
  {
    const h = harness({ acquire: () => { throw new Error('effect boom'); } });
    h.m.send({ type: 'START', config: {} });
    ok(h.m.state === 'acquiring' && h.logs.some((l) => /effect acquire threw/.test(l)), 'a throwing effect is logged and never breaks the transition');
  }
  {
    const h = harness({ setTimer: undefined, wakeLock: undefined, startCountdown: undefined, createSession: undefined });
    h.m.send({ type: 'START', config: { countdown: 3 } }); h.m.send({ type: 'ACQUIRED', tracks: {} }); h.m.send({ type: 'COUNTDOWN_DONE' });
    ok(h.m.state === 'recording' && h.m.leaks().length === 0 && h.m.context.sessionId === null, 'missing optional effects are simply not requested');
  }

  // ── D. Projection, legacy mirror, re-entrancy (docs/03 §11–§12) ───────────
  console.log('\nD. Projection and dispatch');
  {
    const h = reach('recording');
    const p = h.m.projection();
    ok(p.state === 'recording' && p.startedAt === h.m.context.startedAt && p.pausedTotal === 0 && p.pauseStartedAt === null && p.sessionId === 'sess-1', 'the projection carries the docs/03 §11 fields');
    ok(p.recording === true && p.recState.recording === true && p.startTime === p.startedAt, 'legacy keys (recording, recState, startTime) are mirrored');
    h.m.send({ type: 'PAUSE' });
    const q = h.m.projection();
    ok(q.state === 'paused' && q.pauseStartedAt === h.clock && q.recState.paused === true, 'paused is projected with pauseStartedAt');
    ok(M.PROJECTED.finalizing === 'stopping' && M.PROJECTED.acquiring === 'idle' && M.PROJECTED.saved_locally === 'completed' && M.PROJECTED.upload_failed === 'failed', 'internal states map onto the overlay vocabulary');
    ok(h.calls.filter((c) => c[0] === 'publish').length >= 3, 'publish runs on every transition (START, ACQUIRED, PAUSE)');
  }
  {
    const h = reach('idle');
    ok(names(h.calls).length === 0, 'constructing does not fire effects');
    h.m.send({ type: 'START', config: {} }); h.m.send({ type: 'ACQUIRE_FAILED', code: 'permission_denied' }); h.m.send({ type: 'DISMISS' });
    ok(h.m.state === 'idle' && names(h.calls).includes('clearProjection') && h.m.context.config === null, 'idle entry clears the projection and resets the context');
  }
  {
    // Re-entrancy: an effect that sends synchronously is queued, not nested.
    const seen = [];
    const h = harness({ startRecorder: () => { h.m.send({ type: 'CHUNK', size: 1 }); }, chunk: () => seen.push(h.m.state) });
    h.m.send({ type: 'START', config: { countdown: 0 } }); h.m.send({ type: 'ACQUIRED', tracks: {} });
    ok(h.m.state === 'recording' && h.m.context.chunkCount === 1 && seen[0] === 'recording', 'a synchronous nested send is processed after the current transition completes');
  }
  {
    const transitions = [];
    const h = harness();
    const m = M.createMachine({ effects: h.effects, now: () => 1, onTransition: (t) => transitions.push(`${t.from}>${t.to}:${t.event}`) });
    m.send({ type: 'START', config: {} }); m.send({ type: 'ACQUIRED', tracks: {} });
    ok(transitions.join(' ') === 'idle>acquiring:START acquiring>recording:ACQUIRED', 'onTransition reports from/to/event');
    ok(m.can('PAUSE') && !m.can('START'), 'can() reflects the table');
  }

  // ── E. Defaults and the remaining branches ───────────────────────────────
  console.log('\nE. Defaults and edge branches');
  {
    const m = M.createMachine();                                   // no effects, default clock, default log
    ok(m.state === 'idle' && m.elapsedMs() === 0, 'a bare machine idles with elapsed 0');
    ok(m.send({ type: 'BOGUS' }) === 'idle' && m.send({ type: 'START', config: {} }) === 'acquiring', 'default log and empty effects work');
    ok(m.send({ type: 'ACQUIRED' }) === 'recording' && m.context.tracks === null && m.context.startedAt > 0, 'ACQUIRED without tracks → tracks null; the default clock stamps startedAt');
    ok(m.send({ type: 'UPLOAD_PROGRESS', pct: 12 }) === 'recording' && m.context.uploadedPct === 12, 'UPLOAD_PROGRESS while recording is recorded (parts stream during recording)');
    ok(m.send({ type: 'UPLOAD_PROGRESS' }) === 'recording' && m.context.uploadedPct === 12, 'a progress event without pct keeps the last value');
    ok(m.send({ type: 'STOP' }) === 'stopping' && m.context.stopSource === 'user', 'STOP without a source defaults to user');
    ok(m.send({ type: 'CHUNK' }) === 'stopping' && m.context.recordedBytes === 0 && m.context.chunkCount === 1, 'a CHUNK without a size counts as 0 bytes');
  }
  {
    const h = reach('paused');
    ok(h.m.send({ type: 'CHUNK' }) === 'paused' && h.m.context.recordedBytes === 0, 'a sizeless chunk in paused counts 0 bytes');
    ok(h.m.send({ type: 'TRACK_ENDED', kind: 'tab_audio' }) === 'paused' && h.m.context.warning === 'tab_audio_lost', 'tab audio ended while paused → warning, stay paused');
    h.tick(2500);
    ok(h.m.send({ type: 'STOP' }) === 'stopping' && h.m.context.stopSource === 'user' && h.m.context.pausedTotal === 2500, 'STOP from paused without a source defaults to user and folds the pause');
  }
  {
    const h = harness();
    let n = 0;
    const unregister = h.m.register('z', 'idle', () => { n += 1; });
    unregister();
    ok(n === 1 && h.m.leaks().length === 0 && unregister() === false, 'register() returns an unregister closure that is idempotent');
  }
  {
    const h = reach('paused');
    const startedAt = h.m.context.startedAt;
    h.m.send({ type: 'RESUME' });
    ok(h.m.context.startedAt === startedAt, 'resume keeps the original startedAt');
  }
  {
    // The browser UMD branch: load the same file in a sandbox that has `self` and no `module`.
    const vm = require('vm');
    const fs = require('fs');
    const TARGET = path.join(__dirname, '..', 'extension', 'machine.js');
    const sandbox = { self: {} };
    sandbox.self.self = sandbox.self;
    vm.runInNewContext(fs.readFileSync(TARGET, 'utf8'), sandbox, { filename: TARGET });
    ok(sandbox.self.VeoRecMachine && typeof sandbox.self.VeoRecMachine.createMachine === 'function', 'in a browser-like context the module attaches VeoRecMachine to self');
    const bm = sandbox.self.VeoRecMachine.createMachine();
    ok(bm.send({ type: 'START', config: { countdown: 5 } }) === 'acquiring' && bm.send({ type: 'ACQUIRED', warnings: ['no_mic'] }) === 'countdown' && bm.context.warning === 'no_mic', 'the sandboxed machine works and surfaces the first acquisition warning');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
