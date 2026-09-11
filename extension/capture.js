// ─────────────────────────────────────────────────────────────────────────────
// CaptureManager — acquisition, audio mixing, warnings, interruption watchers
// (T-502, docs/03 §4, §5, §6, §9)
//
// The effect side of the recorder machine (T-501): the machine asks
// `acquire(config)`; this module talks to getUserMedia / getDisplayMedia /
// tabCapture streams and the Web Audio API, and answers with tracks, warnings
// and a disposer — or throws a CaptureError whose `code` is one of docs/18 §4.
//
// ── MIC DENIAL POLICY (docs/03 §3.2, changed from the legacy recorder) ──────
// If `config.audio` is true and the microphone cannot be acquired, this does
// NOT silently record without it: it throws `mic_denied`, and the UI offers
// Record without mic / Fix permission / Cancel. "Record without mic" acquires
// again with `audio:false`.
//
// ── EVERYTHING INJECTABLE ───────────────────────────────────────────────────
// mediaDevices, AudioContext, MediaRecorder (for isTypeSupported), a sleep and
// a clock are constructor options, so the manager is testable in Node with
// scripted fakes; in the recorder window the browser globals are the defaults.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VeoRecCapture = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // docs/03 §4 — quality → constraints / bitrate (as today).
  const QUALITY = {
    high: { width: 1920, height: 1080, videoBitsPerSecond: 4_000_000 },
    medium: { width: 1280, height: 720, videoBitsPerSecond: 2_500_000 },
    low: { width: 854, height: 480, videoBitsPerSecond: 1_000_000 },
  };
  const LOWER = { high: 'medium', medium: 'low', low: null };
  const AUDIO_BITS = 128_000;                       // docs/03 §6 — explicitly set
  const MIME_CHAIN = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const RESUME_WAIT_MS = 1500;                      // docs/03 §5 — statechange wait

  // Audience-facing texts — kept verbatim from the legacy recorder (docs/03 §3.2).
  const WARNING_TEXT = {
    no_audio_at_all: 'No audio is being captured. Allow microphone access (or share a tab/screen WITH audio), then re-record.',
    tab_audio_missing: 'This tab’s audio didn’t come through — Stop and try again, or use “Entire Screen” with system audio.',
    no_system_audio: 'Only YOUR mic is captured — others’ audio isn’t. To record everyone, Stop and use “This Tab” mode, or re-share a TAB/whole SCREEN with audio.',
    audio_context_suspended: 'Audio could not be started by the browser — this recording may be silent. Click the page once and try again.',
    mic_lost: 'Your microphone was disconnected — recording continues without it.',
    tab_audio_lost: 'The tab’s audio stopped — recording continues without it.',
    bubble_not_captured: 'Your camera bubble is on a different tab than the one being shared, so it won’t appear in the recording.',
  };

  class CaptureError extends Error {
    constructor(code, message, cause) { super(message || code); this.name = 'CaptureError'; this.code = code; if (cause) this.cause = cause; }
  }

  /** docs/18 §4 — map a getUserMedia/getDisplayMedia failure to a code. */
  function classifyError(err, { stage }) {
    const name = (err && err.name) || '';
    if (stage === 'tab') return 'tab_capture_failed';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      // A cancelled picker is a NotAllowedError too; Chrome says "Permission denied" for a real deny.
      const msg = String((err && err.message) || '').toLowerCase();
      if (stage === 'display' && !/denied by system|permission denied by user|policy/.test(msg)) return 'permission_dismissed';
      return 'permission_denied';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'no_device';
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') return 'constraint_failed';
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'device_busy';
    return 'capture_failed';
  }

  /** Pure: the constraints a mode/quality needs (docs/03 §4). */
  function constraintsFor(config) {
    const q = QUALITY[config.quality] || QUALITY.medium;
    const camera = config.camera || 'off';
    if (camera === 'only') {
      return { kind: 'camera', constraints: { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false } };
    }
    if (config.mode === 'tab' && config.tabStreamId) {
      // The legacy `mandatory` shape is REQUIRED for chromeMediaSource:'tab'.
      return {
        kind: 'tab',
        constraints: {
          video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: config.tabStreamId, maxWidth: q.width, maxHeight: q.height, maxFrameRate: 30 } },
          audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: config.tabStreamId } },
        },
      };
    }
    const video = { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: 30 } };
    if (['monitor', 'browser', 'window'].includes(config.surface)) video.displaySurface = config.surface;
    return { kind: 'display', constraints: { video, audio: true, systemAudio: 'include' } };
  }

  /** docs/03 §6 — MediaRecorder options. */
  function recorderOptions(config, isTypeSupported) {
    const q = QUALITY[config.quality] || QUALITY.medium;
    const supported = typeof isTypeSupported === 'function' ? isTypeSupported : () => false;
    const mimeType = MIME_CHAIN.find((m) => { try { return !!supported(m); } catch (e) { return false; } }) || 'video/webm';
    return { mimeType, videoBitsPerSecond: q.videoBitsPerSecond, audioBitsPerSecond: AUDIO_BITS };
  }

  /** docs/03 §3.2 / §5 — the warnings an acquisition produced. */
  function warningsFor({ config, screenStream, micStream, mixedAudio }) {
    const wantMic = config.audio !== false;
    const camera = config.camera || 'off';
    const screenAudio = screenStream ? screenStream.getAudioTracks().length : 0;
    const out = [];
    if (wantMic && !mixedAudio) out.push('no_audio_at_all');
    else if (config.mode === 'tab' && screenStream && screenAudio === 0) out.push('tab_audio_missing');
    else if (camera !== 'only' && config.mode !== 'tab' && screenStream && screenAudio === 0 && wantMic) out.push('no_system_audio');
    if (camera === 'bubble' && config.bubbleTabId != null && config.surface && config.surface !== 'browser' && config.mode !== 'tab') out.push('bubble_not_captured');
    return out;
  }

  /**
   * @param {object} [deps]
   * @param {MediaDevices} [deps.mediaDevices]
   * @param {Function} [deps.AudioContext]
   * @param {Function} [deps.isTypeSupported]   MediaRecorder.isTypeSupported
   * @param {(ms:number)=>Promise} [deps.sleep]
   * @param {Function} [deps.log]
   */
  function createCaptureManager(deps = {}) {
    const mediaDevices = deps.mediaDevices || (typeof navigator !== 'undefined' && navigator.mediaDevices) || null;
    const AudioCtx = deps.AudioContext || (typeof AudioContext !== 'undefined' ? AudioContext : null);
    const isTypeSupported = deps.isTypeSupported || (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported ? MediaRecorder.isTypeSupported.bind(MediaRecorder) : null);
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const log = deps.log || (() => {});

    /**
     * Acquire every source a config needs. Resolves
     * `{ tracks:{video, audio}, streams, warnings, warningText, mixer, dispose, retriedAtQuality }`.
     * Rejects with CaptureError(code) — nothing acquired is left running.
     */
    async function acquire(config, { _retry = false } = {}) {
      if (!mediaDevices) throw new CaptureError('capture_failed', 'mediaDevices unavailable');
      const cfg = { ...config };
      const camera = cfg.camera || 'off';
      const wantMic = cfg.audio !== false;
      const streams = [];
      const stopAll = () => { for (const s of streams) { try { s.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ } } };

      let screenStream = null, camStream = null, micStream = null;
      try {
        const plan = constraintsFor(cfg);
        if (plan.kind === 'tab') {
          try { screenStream = await mediaDevices.getUserMedia(plan.constraints); }
          catch (e) { throw new CaptureError('tab_capture_failed', 'tab capture failed', e); }
          streams.push(screenStream);
        } else if (plan.kind === 'display') {
          try { screenStream = await mediaDevices.getDisplayMedia(plan.constraints); }
          catch (e) { throw new CaptureError(classifyError(e, { stage: 'display' }), e && e.message, e); }
          streams.push(screenStream);
        } else {
          try { camStream = await mediaDevices.getUserMedia(plan.constraints); }
          catch (e) { throw new CaptureError(classifyError(e, { stage: 'camera' }), e && e.message, e); }
          streams.push(camStream);
        }
        if (wantMic) {
          try { micStream = await mediaDevices.getUserMedia({ audio: true, video: false }); streams.push(micStream); }
          catch (e) {
            // docs/03 §3.2: never silently record without the mic the user asked for.
            const code = classifyError(e, { stage: 'mic' });
            throw new CaptureError(code === 'no_device' ? 'no_device' : 'mic_denied', 'microphone unavailable', e);
          }
        }
      } catch (err) {
        stopAll();
        // docs/18 §4: OverconstrainedError → retry once at the next lower quality.
        if (err instanceof CaptureError && err.code === 'constraint_failed' && !_retry && LOWER[cfg.quality || 'medium']) {
          log('warn', 'capture: constraints failed, retrying at lower quality', { from: cfg.quality });
          const again = await acquire({ ...cfg, quality: LOWER[cfg.quality || 'medium'] }, { _retry: true });
          again.retriedAtQuality = LOWER[cfg.quality || 'medium'];
          return again;
        }
        throw err instanceof CaptureError ? err : new CaptureError('capture_failed', err && err.message, err);
      }

      const videoTrack = camera === 'only' ? camStream.getVideoTracks()[0] : screenStream.getVideoTracks()[0];
      const mixer = await mix({ screenStream, micStream, tabLoopback: cfg.mode === 'tab' });
      const warnings = warningsFor({ config: cfg, screenStream, micStream, mixedAudio: !!mixer.track });
      if (mixer.suspended) warnings.push('audio_context_suspended');
      const disposers = [() => stopAll(), () => mixer.dispose()];
      return {
        tracks: { video: videoTrack, audio: mixer.track || null },
        streams: { screen: screenStream, camera: camStream, mic: micStream },
        warnings, warningText: warnings.map((w) => WARNING_TEXT[w] || w),
        mixer, quality: cfg.quality || 'medium',
        dispose() { for (const d of disposers.splice(0)) { try { d(); } catch (e) { /* ignore */ } } },
      };
    }

    /**
     * docs/03 §5 — one AudioContext mixes display/tab audio + mic into ONE
     * track, with gain nodes per source and the tab loopback so the host
     * still hears the call. Resolves with `suspended:true` when the context
     * could not be brought to `running` — the caller shows the warning
     * instead of proceeding silently.
     */
    async function mix({ screenStream, micStream: micIn, tabLoopback = false }) {
      const screenAudio = screenStream ? screenStream.getAudioTracks() : [];
      // A mic stream only counts as a source if it actually carries audio.
      const micStream = micIn && micIn.getAudioTracks().length > 0 ? micIn : null;
      if (screenAudio.length === 0 && !micStream) return { track: null, context: null, suspended: false, sources: {}, dispose() {} };
      if (!AudioCtx) return { track: null, context: null, suspended: false, sources: {}, dispose() {} };
      const context = new AudioCtx();
      const dest = context.createMediaStreamDestination();
      const sources = {};
      if (screenAudio.length > 0) {
        const src = context.createMediaStreamSource(screenStream);
        const gain = context.createGain(); gain.gain.value = 1;
        src.connect(gain); gain.connect(dest);
        if (tabLoopback) gain.connect(context.destination);     // tabCapture mutes the tab locally
        sources.screen = { src, gain };
      }
      if (micStream) {
        const src = context.createMediaStreamSource(micStream);
        const gain = context.createGain(); gain.gain.value = 1;  // +0 dB default
        src.connect(gain); gain.connect(dest);
        sources.mic = { src, gain };
      }
      // Suspended-context safeguard: resume, wait up to 1.5 s for `running`.
      let suspended = false;
      try { if (context.state !== 'running') await context.resume(); } catch (e) { /* fall through to the wait */ }
      if (context.state !== 'running') {
        await Promise.race([
          new Promise((res) => { const h = () => { if (context.state === 'running') { context.removeEventListener && context.removeEventListener('statechange', h); res(); } }; context.addEventListener && context.addEventListener('statechange', h); }),
          sleep(RESUME_WAIT_MS),
        ]);
        suspended = context.state !== 'running';
      }
      // Re-resume if the OS interrupts audio mid-recording.
      context.onstatechange = () => { if (context.state !== 'running') { try { context.resume().catch(() => {}); } catch (e) { /* ignore */ } } };
      return {
        track: dest.stream.getAudioTracks()[0] || null, context, suspended, sources,
        /** docs/03 §9: a lost mic is removed from the mix; recording continues. */
        dropMic() { if (sources.mic) { try { sources.mic.gain.disconnect(); } catch (e) { /* ignore */ } delete sources.mic; return true; } return false; },
        dispose() { context.onstatechange = null; try { context.close(); } catch (e) { /* ignore */ } },
      };
    }

    /**
     * docs/03 §9 — interruption watchers. Emits typed events through
     * `onEvent`; returns a disposer that removes every listener.
     */
    function watch({ streams, mixer, onEvent }) {
      const offs = [];
      const on = (target, type, fn) => { if (!target || !target.addEventListener) return; target.addEventListener(type, fn); offs.push(() => target.removeEventListener(type, fn)); };
      const video = (streams.camera || streams.screen) && (streams.camera || streams.screen).getVideoTracks()[0];
      if (video) on(video, 'ended', () => onEvent({ type: 'TRACK_ENDED', kind: 'video' }));
      const mic = streams.mic && streams.mic.getAudioTracks()[0];
      if (mic) on(mic, 'ended', () => { if (mixer && mixer.dropMic) mixer.dropMic(); onEvent({ type: 'TRACK_ENDED', kind: 'mic' }); });
      const tabAudio = streams.screen && streams.screen.getAudioTracks()[0];
      if (tabAudio) on(tabAudio, 'ended', () => onEvent({ type: 'TRACK_ENDED', kind: 'tab_audio' }));
      if (mediaDevices && mic) {
        // Do NOT auto-switch devices mid-recording; only report the loss.
        on(mediaDevices, 'devicechange', async () => {
          try {
            const devices = await mediaDevices.enumerateDevices();
            const stillThere = devices.some((d) => d.kind === 'audioinput' && (!mic.getSettings || !mic.getSettings().deviceId || d.deviceId === mic.getSettings().deviceId));
            if (!stillThere) { if (mixer && mixer.dropMic) mixer.dropMic(); onEvent({ type: 'MIC_LOST' }); }
          } catch (e) { /* ignore */ }
        });
      }
      return () => { for (const off of offs.splice(0)) { try { off(); } catch (e) { /* ignore */ } } };
    }

    return { acquire, mix, watch, constraintsFor, recorderOptions: (config) => recorderOptions(config, isTypeSupported), warningsFor };
  }

  return { createCaptureManager, CaptureError, classifyError, constraintsFor, recorderOptions, warningsFor, WARNING_TEXT, QUALITY, MIME_CHAIN, AUDIO_BITS, RESUME_WAIT_MS };
}));
