// T-502 CaptureManager tests (run: cd server && npm run test:capture)
//
// Playwright fake-media is not available here (not installed, ~300 MB of
// browsers), so the manager is driven by SCRIPTED fakes of mediaDevices,
// AudioContext and MediaRecorder.isTypeSupported that reproduce the browser
// contracts (constraint shapes, error names, track/ended events, the
// suspended-context state machine). Each docs/20 §9 row R1–R11 / R20 has its
// unit-level counterpart below; the real-browser parts that need a picker are
// recorded as unverifiable in docs/24.
'use strict';

const path = require('path');
const C = require(path.join(__dirname, '..', 'extension', 'capture.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// ── Fakes ──────────────────────────────────────────────────────────────────
class FakeTrack {
  constructor(kind, settings = {}) { this.kind = kind; this.readyState = 'live'; this.settings = settings; this.listeners = {}; this.stopped = false; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  end() { this.readyState = 'ended'; (this.listeners.ended || []).forEach((fn) => fn()); }
  stop() { this.stopped = true; }
  getSettings() { return this.settings; }
}
class FakeStream {
  constructor(tracks) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
}
const err = (name, message = '') => { const e = new Error(message); e.name = name; return e; };

function fakeDevices(script) {
  const calls = { gum: [], gdm: [], listeners: {} };
  return {
    calls,
    getUserMedia: async (c) => { calls.gum.push(c); const r = script.gum ? script.gum(c) : null; if (r instanceof Error) throw r; return r; },
    getDisplayMedia: async (c) => { calls.gdm.push(c); const r = script.gdm ? script.gdm(c) : null; if (r instanceof Error) throw r; return r; },
    enumerateDevices: async () => script.devices || [],
    addEventListener(t, fn) { (calls.listeners[t] = calls.listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { calls.listeners[t] = (calls.listeners[t] || []).filter((f) => f !== fn); },
    fire(t) { (calls.listeners[t] || []).forEach((fn) => fn()); },
  };
}
function fakeAudioContextFactory({ initialState = 'running', resumeTo = 'running', resumeThrows = false } = {}) {
  const instances = [];
  class FakeAudioContext {
    constructor() {
      this.state = initialState; this.closed = false; this.connections = []; this.listeners = {};
      this.destination = { id: 'speakers' };
      instances.push(this);
    }
    createMediaStreamDestination() { const t = new FakeTrack('audio'); return { id: 'dest', stream: new FakeStream([t]) }; }
    createMediaStreamSource(stream) { const node = { id: 'src', stream, connect: (to) => this.connections.push(['src', to.id || 'node']) }; return node; }
    createGain() { const node = { id: 'gain', gain: { value: 0 }, connect: (to) => this.connections.push(['gain', to.id || 'node']), disconnect: () => this.connections.push(['gain', 'disconnect']) }; return node; }
    async resume() { if (resumeThrows) throw new Error('no gesture'); this.state = resumeTo; (this.listeners.statechange || []).forEach((fn) => fn()); }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
    close() { this.closed = true; this.state = 'closed'; }
  }
  return { FakeAudioContext, instances };
}
const screenWithAudio = () => new FakeStream([new FakeTrack('video'), new FakeTrack('audio')]);
const screenNoAudio = () => new FakeStream([new FakeTrack('video')]);
const micStream = () => new FakeStream([new FakeTrack('audio', { deviceId: 'mic-1' })]);
const camStream = () => new FakeStream([new FakeTrack('video')]);
const supported = (m) => m === 'video/webm;codecs=vp9,opus' || m === 'video/webm;codecs=vp8,opus' || m === 'video/webm';

function manager(script, audio = {}, extra = {}) {
  const devices = fakeDevices(script);
  const { FakeAudioContext, instances } = fakeAudioContextFactory(audio);
  const logs = [];
  const sleeps = [];
  const cm = C.createCaptureManager({ mediaDevices: devices, AudioContext: FakeAudioContext, isTypeSupported: extra.isTypeSupported || supported, sleep: async (ms) => { sleeps.push(ms); }, log: (l, m) => logs.push(m) });
  return { cm, devices, instances, logs, sleeps };
}

(async () => {
  console.log('T-502 CaptureManager tests');

  // ── A. Constraints per mode (docs/03 §4) ─────────────────────────────────
  console.log('\nA. Constraints');
  const tab = C.constraintsFor({ mode: 'tab', tabStreamId: 'sid-1', quality: 'high' });
  ok(tab.kind === 'tab' && tab.constraints.video.mandatory.chromeMediaSource === 'tab' && tab.constraints.video.mandatory.chromeMediaSourceId === 'sid-1'
    && tab.constraints.audio.mandatory.chromeMediaSource === 'tab' && tab.constraints.video.mandatory.maxWidth === 1920 && tab.constraints.video.mandatory.maxFrameRate === 30,
    'tab mode uses the legacy mandatory shape (REQUIRED for chromeMediaSource:tab) with tab audio');
  const screen = C.constraintsFor({ mode: 'screen', surface: 'monitor', quality: 'medium' });
  ok(screen.kind === 'display' && screen.constraints.video.displaySurface === 'monitor' && screen.constraints.video.width.ideal === 1280 && screen.constraints.audio === true && screen.constraints.systemAudio === 'include',
    'screen mode asks getDisplayMedia for the monitor with system audio offered');
  ok(C.constraintsFor({ mode: 'screen', surface: 'window', quality: 'low' }).constraints.video.displaySurface === 'window' && C.constraintsFor({ mode: 'screen', surface: 'window', quality: 'low' }).constraints.video.width.ideal === 854, 'window mode hints displaySurface:window at 854×480 for low');
  ok(C.constraintsFor({ mode: 'screen', surface: 'weird' }).constraints.video.displaySurface === undefined, 'an unknown surface adds no hint');
  const cam = C.constraintsFor({ camera: 'only' });
  ok(cam.kind === 'camera' && cam.constraints.video.width.ideal === 1280 && cam.constraints.audio === false, 'camera-only is a 720p getUserMedia with no audio (mic is separate)');
  ok(C.constraintsFor({ mode: 'tab', tabStreamId: null }).kind === 'display', 'tab mode without a stream id falls back to the picker');
  ok(C.QUALITY.high.videoBitsPerSecond === 4_000_000 && C.QUALITY.medium.videoBitsPerSecond === 2_500_000 && C.QUALITY.low.videoBitsPerSecond === 1_000_000, 'bitrates as today');

  // ── B. MediaRecorder options (docs/03 §6) ─────────────────────────────────
  console.log('\nB. Recorder options');
  const ro = C.recorderOptions({ quality: 'high' }, supported);
  ok(ro.mimeType === 'video/webm;codecs=vp9,opus' && ro.videoBitsPerSecond === 4_000_000 && ro.audioBitsPerSecond === 128_000, 'vp9+opus first, 4 Mbps, audio 128 kbps explicitly set');
  ok(C.recorderOptions({ quality: 'low' }, (m) => m === 'video/webm;codecs=vp8,opus').mimeType === 'video/webm;codecs=vp8,opus', 'falls back to vp8+opus');
  ok(C.recorderOptions({}, () => false).mimeType === 'video/webm' && C.recorderOptions({}, () => { throw new Error('x'); }).mimeType === 'video/webm', 'falls back to plain webm, even when isTypeSupported throws');
  ok(C.recorderOptions({ quality: 'bogus' }, supported).videoBitsPerSecond === 2_500_000, 'unknown quality → medium');

  // ── C. Acquisition per mode (R1–R4) and the mixer (docs/03 §5) ──────────
  console.log('\nC. Acquire and mix');
  {
    const h = manager({ gdm: () => screenWithAudio(), gum: () => micStream() });
    const r = await h.cm.acquire({ mode: 'screen', surface: 'monitor', audio: true, quality: 'high' });
    ok(r.tracks.video && r.tracks.video.kind === 'video' && r.tracks.audio && r.tracks.audio.kind === 'audio', 'R1 screen + mic: a video track and ONE mixed audio track');
    ok(h.devices.calls.gdm.length === 1 && h.devices.calls.gum.length === 1 && h.devices.calls.gum[0].audio === true, 'getDisplayMedia once, then the mic');
    const ctx = h.instances[0];
    ok(h.instances.length === 1 && ctx.connections.filter((c) => c[0] === 'src').length === 2 && ctx.connections.filter((c) => c[1] === 'dest').length === 2, 'both sources go through gain nodes into one destination');
    ok(!ctx.connections.some((c) => c[1] === 'speakers'), 'screen mode does NOT loop audio back to the speakers');
    ok(r.warnings.length === 0, 'no warnings when system audio and mic are both present');
    r.dispose();
    ok(ctx.closed && r.streams.screen.getTracks().every((t) => t.stopped) && r.streams.mic.getTracks().every((t) => t.stopped), 'dispose stops every track and closes the AudioContext');
  }
  {
    const h = manager({ gum: (c) => (c.video && c.video.mandatory ? screenWithAudio() : micStream()) });
    const r = await h.cm.acquire({ mode: 'tab', tabStreamId: 'sid', audio: true });
    ok(h.devices.calls.gdm.length === 0 && h.devices.calls.gum.length === 2, 'R2 tab mode: no picker — getUserMedia for the tab, then the mic');
    ok(h.instances[0].connections.some((c) => c[0] === 'gain' && c[1] === 'speakers'), 'R2: tab audio is looped back to the speakers (tabCapture mutes the tab locally)');
    ok(r.tracks.audio && r.warnings.length === 0, 'R2: both audio sources mixed, no warning');
  }
  {
    const h = manager({ gdm: () => screenNoAudio(), gum: () => micStream() });
    const r = await h.cm.acquire({ mode: 'screen', surface: 'window', audio: true });
    ok(r.warnings.includes('no_system_audio') && r.warningText[0] === C.WARNING_TEXT.no_system_audio, 'R3 window mode: no system audio → the existing "Only YOUR mic is captured" warning');
    ok(r.tracks.audio, 'R3: mic-only audio still mixed');
  }
  {
    const h = manager({ gum: (c) => (c.video ? camStream() : micStream()) });
    const r = await h.cm.acquire({ camera: 'only', audio: true });
    ok(h.devices.calls.gdm.length === 0 && h.devices.calls.gum[0].video.width.ideal === 1280 && r.tracks.video.kind === 'video' && r.tracks.audio, 'R4 camera-only: 720p cam video + mic');
    ok(r.streams.camera && !r.streams.screen, 'camera stream recorded, no screen');
  }
  {
    const h = manager({ gdm: () => screenNoAudio() });
    const r = await h.cm.acquire({ mode: 'screen', audio: false });
    ok(r.tracks.audio === null && h.instances.length === 0 && r.warnings.length === 0, 'audio off + no system audio: no AudioContext, no warning');
    ok(h.devices.calls.gum.length === 0, 'the mic is not requested when audio is off');
  }
  {
    const h = manager({ gdm: () => screenNoAudio(), gum: () => screenNoAudio() /* mic returns no audio track */ });
    const r = await h.cm.acquire({ mode: 'screen', audio: true });
    ok(r.warnings[0] === 'no_audio_at_all' && r.warningText[0] === C.WARNING_TEXT.no_audio_at_all, 'no audio track at all while audio was wanted → the existing prominent warning; recording continues');
  }
  {
    const h = manager({ gum: (c) => (c.video && c.video.mandatory ? screenNoAudio() : micStream()) });
    const r = await h.cm.acquire({ mode: 'tab', tabStreamId: 'sid', audio: true });
    ok(r.warnings.includes('tab_audio_missing') && r.warningText.includes(C.WARNING_TEXT.tab_audio_missing), 'tab mode without tab audio → the existing "This tab’s audio didn’t come through" warning');
  }
  {
    const h = manager({ gdm: () => screenWithAudio(), gum: () => micStream() });
    const r = await h.cm.acquire({ mode: 'screen', surface: 'monitor', camera: 'bubble', bubbleTabId: 7, audio: true });
    ok(r.warnings.includes('bubble_not_captured'), 'R6: bubble on a tab while sharing a monitor → bubble_not_captured');
    const h2 = manager({ gdm: () => screenWithAudio(), gum: () => micStream() });
    const r2 = await h2.cm.acquire({ mode: 'screen', surface: 'browser', camera: 'bubble', bubbleTabId: 7, audio: true });
    ok(!r2.warnings.includes('bubble_not_captured'), 'R5: bubble on the shared tab → no warning');
  }

  // ── D. Failures and the mic policy (R7, R8, docs/18 §4) ──────────────────
  console.log('\nD. Failures');
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e instanceof C.CaptureError ? e.code : 'not-a-CaptureError:' + e.message; } };
  {
    const h = manager({ gdm: () => screenWithAudio(), gum: () => err('NotAllowedError', 'Permission denied') });
    ok(await codeOf(() => h.cm.acquire({ mode: 'screen', audio: true })) === 'mic_denied', 'R7: mic denied while audio requested → mic_denied (NOT a silent mic-less recording)');
    ok(h.devices.calls.gdm.length === 1, 'the screen was acquired first…');
    // …and released: nothing is left running on failure.
    const again = manager({ gdm: () => { const s = screenWithAudio(); again.last = s; return s; }, gum: () => err('NotAllowedError', 'Permission denied') });
    await codeOf(() => again.cm.acquire({ mode: 'screen', audio: true }));
    ok(again.last.getTracks().every((t) => t.stopped), 'on failure every acquired track is stopped (no orphan capture)');
    const muted = manager({ gdm: () => screenWithAudio() });
    const r = await muted.cm.acquire({ mode: 'screen', audio: false });
    ok(r.tracks.audio && r.warnings.length === 0 && muted.devices.calls.gum.length === 0, 'R7 "Record without mic": acquire again with audio:false → system audio only, no mic request, no error');
  }
  {
    const h = manager({ gdm: () => err('NotAllowedError', 'Permission denied by user') });
    ok(await codeOf(() => h.cm.acquire({ mode: 'screen' })) === 'permission_denied', 'a real deny → permission_denied');
    const h2 = manager({ gdm: () => err('NotAllowedError', '') });
    ok(await codeOf(() => h2.cm.acquire({ mode: 'screen' })) === 'permission_dismissed', 'R8: picker cancelled → permission_dismissed');
    const h3 = manager({ gum: () => err('NotFoundError') });
    ok(await codeOf(() => h3.cm.acquire({ camera: 'only', audio: false })) === 'no_device', 'no camera → no_device');
    const h4 = manager({ gum: (c) => (c.video && c.video.mandatory ? err('AbortError', 'tab gone') : micStream()) });
    ok(await codeOf(() => h4.cm.acquire({ mode: 'tab', tabStreamId: 'sid', audio: true })) === 'tab_capture_failed', 'a tab-capture failure → tab_capture_failed');
    const h5 = manager({ gdm: () => screenWithAudio(), gum: () => err('NotFoundError') });
    ok(await codeOf(() => h5.cm.acquire({ mode: 'screen', audio: true })) === 'no_device', 'no microphone present → no_device (not mic_denied)');
    const h6 = manager({ gdm: () => err('NotReadableError') });
    ok(await codeOf(() => h6.cm.acquire({ mode: 'screen' })) === 'device_busy', 'a busy device → device_busy');
    const h7 = manager({ gdm: () => err('WeirdError') });
    ok(await codeOf(() => h7.cm.acquire({ mode: 'screen' })) === 'capture_failed', 'anything else → capture_failed');
    const none = C.createCaptureManager({ mediaDevices: null });
    ok(await codeOf(() => none.acquire({ mode: 'screen' })) === 'capture_failed', 'no mediaDevices → capture_failed');
  }
  {
    // OverconstrainedError → one automatic retry at the next lower quality.
    let n = 0;
    const h = manager({ gdm: (c) => { n += 1; return c.video.width.ideal === 1920 ? err('OverconstrainedError') : screenWithAudio(); }, gum: () => micStream() });
    const r = await h.cm.acquire({ mode: 'screen', quality: 'high', audio: true });
    ok(n === 2 && r.retriedAtQuality === 'medium' && r.quality === 'medium' && h.logs.some((m) => /retrying at lower quality/.test(m)), 'constraint_failed retries once at the lower quality');
    const h2 = manager({ gdm: () => err('OverconstrainedError') });
    ok(await codeOf(() => h2.cm.acquire({ mode: 'screen', quality: 'medium' })) === 'constraint_failed' && h2.devices.calls.gdm.length === 2, 'a second failure surfaces constraint_failed (exactly one retry)');
    const h3 = manager({ gdm: () => err('OverconstrainedError') });
    ok(await codeOf(() => h3.cm.acquire({ mode: 'screen', quality: 'low' })) === 'constraint_failed' && h3.devices.calls.gdm.length === 1, 'at the lowest quality there is nothing to retry with');
  }

  // ── E. Suspended-context safeguard (docs/03 §5) ──────────────────────────
  console.log('\nE. AudioContext safeguards');
  {
    const h = manager({ gdm: () => screenWithAudio(), gum: () => micStream() }, { initialState: 'suspended', resumeTo: 'running' });
    const r = await h.cm.acquire({ mode: 'screen', audio: true });
    ok(h.instances[0].state === 'running' && !r.warnings.includes('audio_context_suspended') && r.mixer.suspended === false, 'a suspended context is resumed before recording starts');
  }
  {
    const h = manager({ gdm: () => screenWithAudio(), gum: () => micStream() }, { initialState: 'suspended', resumeTo: 'suspended' });
    const r = await h.cm.acquire({ mode: 'screen', audio: true });
    ok(h.sleeps.includes(C.RESUME_WAIT_MS) && r.mixer.suspended === true && r.warnings.includes('audio_context_suspended') && r.warningText.includes(C.WARNING_TEXT.audio_context_suspended),
      'a context that stays suspended after the 1.5 s wait surfaces audio_context_suspended instead of proceeding silently');
  }
  {
    const h = manager({ gdm: () => screenWithAudio(), gum: () => micStream() }, { initialState: 'suspended', resumeTo: 'suspended', resumeThrows: true });
    const r = await h.cm.acquire({ mode: 'screen', audio: true });
    ok(r.mixer.suspended === true, 'a throwing resume() is tolerated and still reported as suspended');
    const ctx = h.instances[0];
    ok(typeof ctx.onstatechange === 'function', 'an onstatechange re-resume is installed');
    ctx.state = 'interrupted'; ctx.onstatechange();
    ok(true, 'the re-resume handler runs without throwing');
  }

  // ── F. Interruption watchers (R10, R20, docs/03 §9) ──────────────────────
  console.log('\nF. Interruptions');
  {
    const h = manager({ gdm: () => screenWithAudio(), gum: () => micStream(), devices: [] });
    const r = await h.cm.acquire({ mode: 'screen', audio: true });
    const events = [];
    const off = h.cm.watch({ streams: r.streams, mixer: r.mixer, onEvent: (e) => events.push(e) });
    r.streams.mic.getAudioTracks()[0].end();
    ok(events[0] && events[0].type === 'TRACK_ENDED' && events[0].kind === 'mic', 'R20: mic unplugged → TRACK_ENDED(mic)');
    ok(h.instances[0].connections.some((c) => c[0] === 'gain' && c[1] === 'disconnect') && !r.mixer.sources.mic, 'R20: the mic is removed from the mix; recording continues');
    ok(r.mixer.dropMic() === false, 'dropMic is idempotent');
    r.streams.screen.getAudioTracks()[0].end();
    ok(events[1].type === 'TRACK_ENDED' && events[1].kind === 'tab_audio', 'tab/system audio ended → TRACK_ENDED(tab_audio)');
    r.streams.screen.getVideoTracks()[0].end();
    ok(events[2].type === 'TRACK_ENDED' && events[2].kind === 'video', 'R10: the browser "Stop sharing" bar → TRACK_ENDED(video)');
    off();
    r.streams.screen.getVideoTracks()[0].end();
    ok(events.length === 3, 'the disposer removes every listener');
  }
  {
    const h = manager({ gdm: () => screenWithAudio(), gum: () => micStream(), devices: [{ kind: 'audioinput', deviceId: 'other' }] });
    const r = await h.cm.acquire({ mode: 'screen', audio: true });
    const events = [];
    h.cm.watch({ streams: r.streams, mixer: r.mixer, onEvent: (e) => events.push(e) });
    h.devices.fire('devicechange');
    await new Promise((res) => setTimeout(res, 5));
    ok(events.some((e) => e.type === 'MIC_LOST') && !r.mixer.sources.mic, 'devicechange with the active mic gone → MIC_LOST, mic dropped from the mix, no auto-switch');
  }
  {
    const h = manager({ gdm: () => screenWithAudio(), gum: () => micStream(), devices: [{ kind: 'audioinput', deviceId: 'mic-1' }] });
    const r = await h.cm.acquire({ mode: 'screen', audio: true });
    const events = [];
    h.cm.watch({ streams: r.streams, mixer: r.mixer, onEvent: (e) => events.push(e) });
    h.devices.fire('devicechange');
    await new Promise((res) => setTimeout(res, 5));
    ok(events.length === 0 && r.mixer.sources.mic, 'a devicechange that keeps the active mic changes nothing');
  }
  {
    const h = manager({ gum: (c) => (c.video ? camStream() : micStream()) });
    const r = await h.cm.acquire({ camera: 'only', audio: true });
    const events = [];
    h.cm.watch({ streams: r.streams, mixer: r.mixer, onEvent: (e) => events.push(e) });
    r.streams.camera.getVideoTracks()[0].end();
    ok(events[0].kind === 'video', 'camera failure in camera-only → TRACK_ENDED(video) (there is no video without it)');
  }

  // ── G. Boundaries ────────────────────────────────────────────────────────
  console.log('\nG. Boundaries');
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'capture.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok(!/chrome\./.test(code) && !/document\./.test(code) && !/fetch\(/.test(code), 'no chrome.*, no DOM, no network');
  ok(!/canvas|captureStream\(/i.test(code), 'no canvas compositing (docs/03 §13)');
  ok(/mandatory: \{ chromeMediaSource: 'tab'/.test(src), 'the required legacy mandatory shape is kept');
  ok(src.includes(C.WARNING_TEXT.no_audio_at_all) && src.includes(C.WARNING_TEXT.tab_audio_missing) && src.includes(C.WARNING_TEXT.no_system_audio), 'the audience-facing warning strings are kept verbatim');
  const rec = fs.readFileSync(path.join(__dirname, '..', 'extension', 'recorder.js'), 'utf8');
  for (const k of ['no_audio_at_all', 'tab_audio_missing', 'no_system_audio']) ok(rec.includes(C.WARNING_TEXT[k]), `recorder.js still carries the ${k} text (T-503 will render from the manager)`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
