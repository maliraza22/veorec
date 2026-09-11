// ─────────────────────────────────────────────────────────────────────────────
// RecorderMachine — the one owner of recording lifecycle state (T-501, docs/03)
//
// ── DESIGN RULES (docs/03 §1) ───────────────────────────────────────────────
// 1. One machine, one owner: nothing else keeps an isRecording boolean.
// 2. Every transition publishes the projection (docs/03 §11) and persists.
// 3. Every side effect is owned by a state: entry/exit actions call injected
//    EFFECTS; whoever allocates registers a DISPOSER in the registry, and the
//    owning state's exit (or idle/cancelling) runs it.
// 4. Events are the only way in. Unknown or invalid-in-state events are
//    ignored and logged — never thrown, never partially applied.
//
// This module is PURE: no DOM, no chrome.*, no MediaRecorder, no network. The
// recorder window (T-503) supplies `effects` that do the real work and send
// events back (ACQUIRED, RECORDER_STOPPED, FINALIZED, UPLOAD_COMPLETE, …).
// Effects are never awaited by the machine; they are fire-and-forget requests.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VeoRecMachine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATES = [
    'idle', 'acquiring', 'permission_denied', 'countdown', 'recording', 'paused',
    'stopping', 'finalizing', 'uploading', 'upload_failed', 'completed', 'saved_locally', 'cancelling',
  ];
  const EVENTS = [
    'START', 'ACQUIRED', 'ACQUIRE_FAILED', 'RETRY', 'DISMISS', 'COUNTDOWN_DONE', 'CANCEL', 'RESTART',
    'PAUSE', 'RESUME', 'STOP', 'RECORDER_STOPPED', 'STOP_TIMEOUT', 'FINALIZED', 'UPLOAD_COMPLETE',
    'UPLOAD_FAILED', 'RETRY_UPLOAD', 'DOWNLOAD_FALLBACK', 'DISCARD', 'CLEANED', 'CHUNK', 'TRACK_ENDED',
    'MIC_LOST', 'TICK', 'UPLOAD_PROGRESS', 'WARNING',
  ];
  const TERMINAL = new Set(['completed', 'saved_locally']);
  const MiB = 1024 * 1024;
  const BYTE_MARGIN = 16 * MiB;            // docs/03 §8: stop at ceiling − 16 MiB
  const STOP_GUARD_MS = 10 * 1000;         // docs/03 §3.6: force-transition if onstop never arrives
  const DURATION_WARN_SEC = 30;            // docs/03 §8: 30 s warning

  // docs/03 §11 — the overlay projection's state vocabulary.
  const PROJECTED = {
    idle: 'idle', acquiring: 'idle', permission_denied: 'idle', countdown: 'countdown', recording: 'recording',
    paused: 'paused', stopping: 'stopping', finalizing: 'stopping', uploading: 'uploading', upload_failed: 'failed',
    completed: 'completed', saved_locally: 'completed', cancelling: 'idle',
  };

  function freshContext() {
    return {
      config: null, tracks: null, warnings: [],
      sessionId: null, recordingId: null, uploadSessionId: null,
      startedAt: null, pausedTotal: 0, pauseStartedAt: null,
      recordedBytes: 0, chunkCount: 0,
      durationLimitSec: 0, byteCeiling: null,
      restart: false, discarding: false, stopSource: null,
      warning: null, uploadedPct: null, lastError: null, watchUrl: null,
      durationWarned: false, byteWarned: false,
    };
  }

  /**
   * @param {object} options
   * @param {object} options.effects   side-effect requests (all optional, all fire-and-forget)
   * @param {() => number} [options.now]
   * @param {(level:string, msg:string, meta?:object) => void} [options.log]
   * @param {(t:{from:string,to:string,event:string,context:object}) => void} [options.onTransition]
   */
  function createMachine(options = {}) {
    const effects = options.effects || {};
    const now = options.now || (() => Date.now());
    const log = options.log || (() => {});
    const onTransition = options.onTransition || (() => {});

    let state = 'idle';
    let ctx = freshContext();
    const registry = new Map();           // id -> { ownerState, dispose }
    const queue = [];
    let processing = false;

    const fx = (name, ...args) => {
      const f = effects[name];
      if (typeof f !== 'function') return undefined;
      try { return f(...args); } catch (e) { log('warn', `effect ${name} threw`, { error: e && e.message }); return undefined; }
    };

    // ── Disposer registry (docs/03 §10) ────────────────────────────────────
    function register(id, ownerState, dispose) {
      if (typeof dispose !== 'function') throw new TypeError('register: dispose must be a function');
      if (registry.has(id)) { runDisposer(id); }
      registry.set(id, { ownerState, dispose });
      return () => runDisposer(id);
    }
    function runDisposer(id) {
      const d = registry.get(id);
      if (!d) return false;
      registry.delete(id);
      try { d.dispose(); } catch (e) { log('warn', `disposer ${id} threw`, { error: e && e.message }); }
      return true;
    }
    function disposeOwnedBy(ownerState) {
      for (const [id, d] of [...registry]) if (d.ownerState === ownerState) runDisposer(id);
    }
    function disposeAll() { for (const id of [...registry.keys()]) runDisposer(id); }
    const leaks = () => [...registry.keys()];

    // ── Elapsed — computed in exactly one place (docs/03 §3.5) ────────────
    function elapsedMs(at = now()) {
      if (ctx.startedAt == null) return 0;
      const pausedNow = ctx.pauseStartedAt != null ? (at - ctx.pauseStartedAt) : 0;
      return Math.max(0, at - ctx.startedAt - ctx.pausedTotal - pausedNow);
    }

    // ── Projection (docs/03 §11) + legacy keys mirrored ────────────────────
    function projection() {
      const s = PROJECTED[state];
      const active = state === 'recording' || state === 'paused' || state === 'countdown' || state === 'stopping' || state === 'finalizing';
      return {
        state: s,
        startedAt: ctx.startedAt, pausedTotal: ctx.pausedTotal, pauseStartedAt: ctx.pauseStartedAt,
        warning: ctx.warning, uploadedPct: ctx.uploadedPct, sessionId: ctx.sessionId,
        // Legacy keys, written in parallel during migration (deleted in Phase 14).
        recording: state === 'recording' || state === 'paused',
        recState: { recording: state === 'recording' || state === 'paused', paused: state === 'paused', active },
        startTime: ctx.startedAt,
      };
    }
    function publish() { fx('publish', projection(), state, ctx); }
    function persist(patch) { fx('persist', patch, ctx); }

    // ── Entry / exit actions (docs/03 §3) ──────────────────────────────────
    const entry = {
      idle() {
        disposeAll();
        ctx = freshContext();
        fx('clearProjection');
      },
      acquiring() {
        ctx.tracks = null; ctx.warnings = [];
        fx('acquire', ctx.config);
      },
      permission_denied() {},
      countdown() {
        const dispose = fx('startCountdown', ctx.countdownSec);
        if (typeof dispose === 'function') register('countdown-timer', 'countdown', dispose);
      },
      recording(from) {
        if (from === 'paused') {
          // Resume: pausedTotal absorbs the pause; the recorder resumes.
          ctx.pausedTotal += now() - ctx.pauseStartedAt;
          ctx.pauseStartedAt = null;
          fx('resumeRecorder');
          persist({ status: 'recording' });
          return;
        }
        // docs/03 §3.4, in order: session row → upload session → recorder → clock → wake lock → projection.
        ctx.sessionId = fx('createSession', ctx) || ctx.sessionId;
        fx('createUploadSession', ctx);
        fx('startRecorder', ctx);
        ctx.startedAt = now(); ctx.pausedTotal = 0; ctx.pauseStartedAt = null;
        ctx.recordedBytes = 0; ctx.chunkCount = 0; ctx.durationWarned = false; ctx.byteWarned = false;
        const wake = fx('wakeLock');
        if (typeof wake === 'function') register('wake-lock', 'recording', wake);
        armDurationBackstop();
        persist({ status: 'recording' });
      },
      paused() {
        ctx.pauseStartedAt = now();
        fx('pauseRecorder');
        persist({ status: 'recording' });
      },
      stopping() {
        // docs/03 §3.6: stop the recorder and NOTHING else; guard against a lost onstop.
        fx('stopRecorder');
        const dispose = fx('setTimer', () => send({ type: 'STOP_TIMEOUT' }), STOP_GUARD_MS);
        if (typeof dispose === 'function') register('stop-guard', 'stopping', dispose);
      },
      finalizing() {
        fx('stopTracks');           // now the tracks may go (docs/03 §3.6)
        runDisposer('wake-lock');
        ctx.clientDuration = Math.round(elapsedMs() / 1000);
        if (ctx.stopSource === 'limit' && ctx.durationLimitSec > 0) ctx.clientDuration = Math.min(ctx.clientDuration, ctx.durationLimitSec);
        persist({ status: 'stopped', clientDuration: ctx.clientDuration, totalBytes: ctx.recordedBytes, chunkCount: ctx.chunkCount });
        fx('finalize', ctx);
      },
      uploading() {
        ctx.uploadedPct = ctx.uploadedPct || 0;
        persist({ status: 'uploading' });
        fx('startUpload', ctx);
      },
      upload_failed() { persist({ status: 'failed' }); },
      completed() {
        persist({ status: 'uploaded' });
        fx('complete', ctx);           // lastRecording, delete local session (after server 200), open watch page
        disposeAll();
      },
      saved_locally() { fx('download', ctx); disposeAll(); },
      cancelling() {
        ctx.discarding = true;         // suppress the chunk pipeline (docs/03 §3.11)
        disposeAll();
        fx('cleanup', ctx);            // stop recorder, stop tracks, delete session, abort upload → CLEANED
      },
    };
    const exit = {
      countdown() { disposeOwnedBy('countdown'); },
      recording(to) { if (to !== 'paused') { disposeOwnedBy('recording'); } },
      stopping() { disposeOwnedBy('stopping'); },
    };

    function armDurationBackstop() {
      runDisposer('duration-backstop');
      if (!(ctx.durationLimitSec > 0)) return;
      const remainingMs = Math.max(0, ctx.durationLimitSec * 1000 - elapsedMs()) + 500;
      const dispose = fx('setTimer', () => send({ type: 'TICK', backstop: true }), remainingMs);
      if (typeof dispose === 'function') register('duration-backstop', 'recording', dispose);
    }

    // ── Limit enforcement (docs/03 §8) — one pattern for both caps ─────────
    function enforceLimits() {
      // Reached only from the `recording` handlers (CHUNK / TICK).
      const elapsedSec = elapsedMs() / 1000;
      if (ctx.durationLimitSec > 0) {
        if (elapsedSec >= ctx.durationLimitSec) return send({ type: 'STOP', source: 'limit' });
        if (!ctx.durationWarned && ctx.durationLimitSec - elapsedSec <= DURATION_WARN_SEC) {
          ctx.durationWarned = true; ctx.warning = 'duration_limit_near'; fx('warn', ctx.warning, ctx); publish();
        }
      }
      if (ctx.byteCeiling > 0) {
        if (ctx.recordedBytes >= Math.max(0, ctx.byteCeiling - BYTE_MARGIN)) return send({ type: 'STOP', source: 'byte_limit' });
        if (!ctx.byteWarned && ctx.recordedBytes >= ctx.byteCeiling * 0.9) {
          ctx.byteWarned = true; ctx.warning = 'byte_limit_near'; fx('warn', ctx.warning, ctx); publish();
        }
      }
    }

    // ── Transition table (docs/03 §2) ──────────────────────────────────────
    // Each handler returns the next state (or null to stay) after mutating ctx.
    const table = {
      idle: {
        START(e) { ctx = freshContext(); ctx.config = e.config || {}; ctx.durationLimitSec = Number(e.durationLimitSec || (e.config && e.config.durationLimitSec)) || 0; ctx.byteCeiling = e.byteCeiling || null; return 'acquiring'; },
      },
      acquiring: {
        ACQUIRED(e) { ctx.tracks = e.tracks || null; ctx.warnings = e.warnings || []; ctx.warning = ctx.warnings[0] || null; ctx.countdownSec = Number(ctx.config.countdown) || 0; return ctx.countdownSec > 0 ? 'countdown' : 'recording'; },
        ACQUIRE_FAILED(e) { ctx.lastError = e.code || 'acquire_failed'; return 'permission_denied'; },
        CANCEL() { ctx.restart = false; return 'cancelling'; },
      },
      permission_denied: {
        RETRY(e) { if (e && e.config) ctx.config = { ...ctx.config, ...e.config }; return 'acquiring'; },
        DISMISS() { return 'idle'; },
        CANCEL() { return 'idle'; },
      },
      countdown: {
        COUNTDOWN_DONE() { return 'recording'; },
        CANCEL() { ctx.restart = false; return 'cancelling'; },
        RESTART() { ctx.restart = true; return 'cancelling'; },
        TRACK_ENDED() { ctx.restart = false; return 'cancelling'; },
      },
      recording: {
        PAUSE() { return 'paused'; },
        STOP(e) { ctx.stopSource = (e && e.source) || 'user'; return 'stopping'; },
        CANCEL() { ctx.restart = false; return 'cancelling'; },
        RESTART() { ctx.restart = true; return 'cancelling'; },
        CHUNK(e) { ctx.recordedBytes += Number(e.size) || 0; ctx.chunkCount += 1; fx('chunk', e, ctx); enforceLimits(); return null; },
        TICK() { enforceLimits(); return null; },
        TRACK_ENDED(e) { if (e && e.kind === 'mic') { ctx.warning = 'mic_lost'; fx('warn', 'mic_lost', ctx); return null; } if (e && e.kind === 'tab_audio') { ctx.warning = 'tab_audio_lost'; fx('warn', 'tab_audio_lost', ctx); return null; } ctx.stopSource = 'track_ended'; return 'stopping'; },
        MIC_LOST() { ctx.warning = 'mic_lost'; fx('warn', 'mic_lost', ctx); return null; },
        WARNING(e) { ctx.warning = (e && e.code) || null; return null; },
        UPLOAD_PROGRESS(e) { ctx.uploadedPct = e && e.pct != null ? e.pct : ctx.uploadedPct; return null; },
      },
      paused: {
        RESUME() { return 'recording'; },
        STOP(e) { ctx.pausedTotal += now() - ctx.pauseStartedAt; ctx.pauseStartedAt = null; ctx.stopSource = (e && e.source) || 'user'; return 'stopping'; },
        CANCEL() { ctx.restart = false; return 'cancelling'; },
        RESTART() { ctx.restart = true; return 'cancelling'; },
        TRACK_ENDED(e) { if (e && (e.kind === 'mic' || e.kind === 'tab_audio')) { ctx.warning = e.kind === 'mic' ? 'mic_lost' : 'tab_audio_lost'; return null; } ctx.pausedTotal += now() - ctx.pauseStartedAt; ctx.pauseStartedAt = null; ctx.stopSource = 'track_ended'; return 'stopping'; },
        CHUNK(e) { ctx.recordedBytes += Number(e.size) || 0; ctx.chunkCount += 1; fx('chunk', e, ctx); return null; },
      },
      stopping: {
        RECORDER_STOPPED() { return 'finalizing'; },
        STOP_TIMEOUT() { log('warn', 'onstop never arrived — forcing finalize with the chunks we have'); return 'finalizing'; },
        CHUNK(e) { ctx.recordedBytes += Number(e.size) || 0; ctx.chunkCount += 1; fx('chunk', e, ctx); return null; },   // the final flush
        CANCEL() { ctx.restart = false; return 'cancelling'; },
      },
      finalizing: {
        FINALIZED(e) { if (e && e.recordingId) ctx.recordingId = e.recordingId; return 'uploading'; },
        UPLOAD_FAILED(e) { ctx.lastError = e && e.code; return 'upload_failed'; },
        CANCEL() { ctx.restart = false; return 'cancelling'; },
      },
      uploading: {
        UPLOAD_PROGRESS(e) { ctx.uploadedPct = e && e.pct != null ? e.pct : ctx.uploadedPct; return null; },
        UPLOAD_COMPLETE(e) { ctx.recordingId = (e && e.recordingId) || ctx.recordingId; ctx.watchUrl = (e && e.watchUrl) || null; ctx.uploadedPct = 100; return 'completed'; },
        UPLOAD_FAILED(e) { ctx.lastError = e && e.code; ctx.retryable = !!(e && e.retryable); return 'upload_failed'; },
      },
      upload_failed: {
        RETRY_UPLOAD() { return 'uploading'; },
        DOWNLOAD_FALLBACK() { return 'saved_locally'; },
        DISCARD() { fx('discard', ctx); return 'idle'; },
      },
      completed: {},
      saved_locally: {},
      cancelling: {
        CLEANED() { return ctx.restart ? 'acquiring' : 'idle'; },
        CHUNK() { return null; },                 // pipeline suppressed while discarding
      },
    };

    // ── Dispatch: one event at a time, queued for re-entrancy ──────────────
    function send(event) {
      if (!event || typeof event.type !== 'string') { log('warn', 'malformed event ignored', { event }); return state; }
      queue.push(event);
      if (processing) return state;
      processing = true;
      try {
        while (queue.length) step(queue.shift());
      } finally { processing = false; }
      return state;
    }

    function step(event) {
      if (!EVENTS.includes(event.type)) { log('warn', `unknown event ${event.type} ignored in state ${state}`); return; }
      const handler = table[state][event.type];
      if (!handler) { log('warn', `event ${event.type} ignored in state ${state}`); return; }
      const from = state;
      const next = handler(event);
      if (next === null || next === undefined || next === from) { if (event.type !== 'CHUNK') publish(); return; }
      // The table is static and exercised cell by cell; every returned name is a STATE.
      if (exit[from]) exit[from](next);
      state = next;
      if (entry[next]) entry[next](from);
      // A handler-triggered nested send (e.g. limit → STOP) may already have moved on.
      if (state === next) { publish(); onTransition({ from, to: next, event: event.type, context: snapshot() }); }
    }

    const snapshot = () => ({ ...ctx, warnings: [...ctx.warnings] });

    return {
      send,
      get state() { return state; },
      get context() { return snapshot(); },
      get isTerminal() { return TERMINAL.has(state); },
      elapsedMs, projection,
      register, dispose: runDisposer, disposeAll, leaks,
      can(type) { return !!(table[state] && table[state][type]); },
    };
  }

  return { createMachine, STATES, EVENTS, PROJECTED, BYTE_MARGIN, STOP_GUARD_MS, DURATION_WARN_SEC };
}));
