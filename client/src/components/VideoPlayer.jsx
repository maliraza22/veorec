import React, { useState, useRef, useEffect, useCallback } from 'react';
import Hls from 'hls.js';
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, Captions, RotateCcw, RotateCw, MessageSquare, Loader2 } from 'lucide-react';
import s from './VideoPlayer.module.css';

function clk(t) { if (!isFinite(t)) t = 0; const m = Math.floor(t / 60), x = Math.floor(t % 60); return `${m}:${String(x).padStart(2, '0')}`; }
const SPEEDS = [0.5, 1, 1.25, 1.5, 1.75, 2];
const isTyping = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

/** docs/11 §5: map a MediaError / hls.js error to a class the page can act on. */
export function classifyMediaError({ mediaError = null, hlsError = null } = {}) {
  if (hlsError) {
    if (hlsError.type === 'networkError') return (hlsError.response && hlsError.response.code === 404) ? 'removed' : (hlsError.response && hlsError.response.code === 403) ? 'expired' : 'network';
    if (hlsError.type === 'mediaError') return 'decode';
    return 'other';
  }
  const code = mediaError && mediaError.code;
  if (code === 2) return 'network';
  if (code === 3) return 'decode';
  if (code === 4) return 'unsupported';
  return code ? 'other' : null;
}

// Custom video player (docs/11 §3): native <video> with our own controls,
// reaction/comment markers and chapter ticks ON the progress bar, virtual
// trim/segments, recommended speed, keyboard controls, buffering feedback,
// captions (native <track> preferred, JS overlay fallback) and HLS via hls.js
// (native on Safari) with an MP4 fallback. The parent keeps the videoRef so it
// can seek and read currentTime.
//
// Media refresh (docs/11 §2): when `src`/`hlsUrl` change while playing, the
// swap is seamless — currentTime and the play state are restored.
export default function VideoPlayer({
  videoRef, src, hlsUrl = null, poster, captionsUrl = null, segments, trimStart, trimEnd, recommendedSpeed,
  markers = [], chapters = [], captions = [], onMarkerClick, onTime, branding = false,
  legacyWebm = false, onPlaybackError, onNeedRefresh, keyboard = true, autoPlay = true,
}) {
  const wrapRef = useRef(null), barRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [vol, setVol] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(recommendedSpeed || 1);
  const [fs, setFs] = useState(false);
  const [cc, setCc] = useState(false);
  const [spdOpen, setSpdOpen] = useState(false);
  const [hoverT, setHoverT] = useState(null);
  const [buffering, setBuffering] = useState(false);
  const [bufferedPct, setBufferedPct] = useState(0);
  const [useMp4, setUseMp4] = useState(false);          // HLS fell back to MP4
  const hlsRef = useRef(null);
  const resumeRef = useRef(null);                       // { t, playing } across a src swap
  const bufferTimer = useRef(null);
  const recoveries = useRef(0);

  const segs = Array.isArray(segments) && segments.length ? segments : null;
  const playHls = !!hlsUrl && !useMp4;

  // ── source management: hls.js → native HLS → MP4 ───────────────────────
  useEffect(() => {
    const v = videoRef.current; if (!v) return undefined;
    // Remember where we were, so a refreshed URL resumes in place.
    if (v.currentTime > 0.25 && (v.currentSrc || hlsRef.current)) resumeRef.current = { t: v.currentTime, playing: !v.paused };
    if (hlsRef.current) { try { hlsRef.current.destroy(); } catch {} hlsRef.current = null; }
    if (playHls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: false });
      hlsRef.current = hls;
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data || !data.fatal) return;
        const kind = classifyMediaError({ hlsError: data });
        if (kind === 'expired' && onNeedRefresh && recoveries.current < 1) { recoveries.current += 1; onNeedRefresh('expired'); return; }
        if (data.type === 'mediaError' && recoveries.current < 2) { recoveries.current += 1; try { hls.recoverMediaError(); return; } catch {} }
        // Anything else: fall back to MP4 once (docs/11 §5), else surface it.
        if (src) { setUseMp4(true); return; }
        onPlaybackError && onPlaybackError({ kind, detail: data.details || null });
      });
      // Clear any direct src BEFORE attaching: attachMedia sets the MediaSource
      // blob URL as the element's src, which must not be removed afterwards.
      v.removeAttribute('src');
      hls.loadSource(hlsUrl);
      hls.attachMedia(v);
    } else if (playHls && v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = hlsUrl;                                   // Safari: native HLS
    } else if (src) {
      v.src = src;
    } else {
      v.removeAttribute('src'); try { v.load(); } catch {}
    }
    return () => { if (hlsRef.current) { try { hlsRef.current.destroy(); } catch {} hlsRef.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, hlsUrl, playHls]);

  // Captions: a native <track> when the server minted a VTT URL; toggle by track mode.
  useEffect(() => {
    const v = videoRef.current; if (!v || !captionsUrl) return;
    const tracks = v.textTracks;
    for (let i = 0; i < tracks.length; i += 1) tracks[i].mode = cc ? 'showing' : 'hidden';
  }, [cc, captionsUrl, videoRef]);

  function togglePlay() {
    const v = videoRef.current; if (!v) return;
    if (v.paused) {
      if (segs && !segs.some(g => v.currentTime >= g.start && v.currentTime < g.end)) v.currentTime = segs[0].start;
      v.play().catch(() => {});
    } else v.pause();
  }
  const skip = useCallback((d) => { const v = videoRef.current; if (v) v.currentTime = Math.max(0, Math.min(dur || v.duration || 0, v.currentTime + d)); }, [dur, videoRef]);

  function onMeta(e) {
    const v = e.target;
    if (recommendedSpeed) { try { v.playbackRate = recommendedSpeed; setSpeed(recommendedSpeed); } catch {} }
    const start = segs ? segs[0].start : (Number(trimStart) || 0);
    const resume = resumeRef.current; resumeRef.current = null;
    // Legacy WebM from MediaRecorder reports Infinity until scanned (docs/11
    // §2): guarded so transcoded MP4/HLS never pays for it.
    if (legacyWebm && (v.duration === Infinity || isNaN(v.duration))) {
      v.currentTime = 1e101;
      v.ontimeupdate = () => { v.ontimeupdate = null; v.currentTime = resume ? resume.t : start; if (isFinite(v.duration)) setDur(v.duration); };
    } else {
      if (resume) v.currentTime = resume.t; else if (start) v.currentTime = start;
      if (isFinite(v.duration)) setDur(v.duration);
    }
    if (resume && resume.playing) v.play().catch(() => {});
    else if (autoPlay && !resume) v.play().catch(() => { /* autoplay blocked → the big play button stays */ });
  }
  function onTU(e) {
    const v = e.target; setCur(v.currentTime); onTime && onTime(v.currentTime);
    if (segs) {
      const t = v.currentTime;
      const inSeg = segs.find(g => t >= g.start - 0.05 && t < g.end);
      if (!inSeg) { const next = segs.find(g => g.start > t); if (next) v.currentTime = next.start; else { v.pause(); v.currentTime = segs[0].start; } }
      return;
    }
    const start = Number(trimStart) || 0;
    if (trimEnd != null && v.currentTime >= trimEnd) { v.pause(); v.currentTime = start; }
  }
  function onProgress(e) {
    const v = e.target; const d = dur || v.duration;
    if (!d || !v.buffered.length) return;
    let end = 0; for (let i = 0; i < v.buffered.length; i += 1) if (v.buffered.start(i) <= v.currentTime + 0.5) end = Math.max(end, v.buffered.end(i));
    setBufferedPct(Math.min(100, (end / d) * 100));
  }
  function onWaiting() { clearTimeout(bufferTimer.current); bufferTimer.current = setTimeout(() => setBuffering(true), 500); }
  function onPlayingEv() { clearTimeout(bufferTimer.current); setBuffering(false); setPlaying(true); }
  function onError(e) {
    const kind = classifyMediaError({ mediaError: e.target && e.target.error });
    if (!kind) return;
    if ((kind === 'network' || kind === 'other') && onNeedRefresh && recoveries.current < 1 && !playHls) { recoveries.current += 1; onNeedRefresh(kind); return; }
    onPlaybackError && onPlaybackError({ kind, detail: e.target && e.target.error ? e.target.error.message : null });
  }
  function seekEv(e) {
    const r = barRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    if (videoRef.current && (dur || videoRef.current.duration)) videoRef.current.currentTime = ratio * (dur || videoRef.current.duration);
  }
  function setVolume(x) { const v = videoRef.current; if (v) { v.volume = x; v.muted = x === 0; } setVol(x); setMuted(x === 0); }
  function toggleMute() { const v = videoRef.current; if (!v) return; v.muted = !v.muted; setMuted(v.muted); }
  function setSpd(x) { const v = videoRef.current; if (v) v.playbackRate = x; setSpeed(x); setSpdOpen(false); }
  function toggleFs() { const el = wrapRef.current; if (!document.fullscreenElement) el?.requestFullscreen?.(); else document.exitFullscreen?.(); }
  useEffect(() => { const h = () => setFs(!!document.fullscreenElement); document.addEventListener('fullscreenchange', h); return () => document.removeEventListener('fullscreenchange', h); }, []);
  useEffect(() => () => clearTimeout(bufferTimer.current), []);

  // Keyboard (docs/11 §3) — bound on the player container, ignored while typing.
  function onKey(e) {
    if (!keyboard || isTyping(e.target)) return;
    const v = videoRef.current; if (!v) return;
    const k = e.key;
    let handled = true;
    if (k === ' ' || k === 'k' || k === 'K') togglePlay();
    else if (k === 'ArrowLeft') skip(-5);
    else if (k === 'ArrowRight') skip(5);
    else if (k === 'j' || k === 'J') skip(-10);
    else if (k === 'l' || k === 'L') skip(10);
    else if (k === 'ArrowUp') setVolume(Math.min(1, (muted ? 0 : vol) + 0.1));
    else if (k === 'ArrowDown') setVolume(Math.max(0, (muted ? 0 : vol) - 0.1));
    else if (k === 'm' || k === 'M') toggleMute();
    else if (k === 'f' || k === 'F') toggleFs();
    else if ((k === 'c' || k === 'C') && (captionsUrl || captions.length)) setCc(c => !c);
    else if (/^[0-9]$/.test(k)) { const d = dur || v.duration; if (d) v.currentTime = (Number(k) / 10) * d; }
    else if (k === '>') { const i = SPEEDS.indexOf(speed); setSpd(SPEEDS[Math.min(SPEEDS.length - 1, i + 1)]); }
    else if (k === '<') { const i = SPEEDS.indexOf(speed); setSpd(SPEEDS[Math.max(0, i - 1)]); }
    else handled = false;
    if (handled) e.preventDefault();
  }

  const pct = t => (dur ? Math.min(100, (t / dur) * 100) : 0);
  const curCap = cc && !captionsUrl && captions.length ? (captions.find(c => cur >= c.start && cur < c.end)?.text || '') : '';
  const ccAvailable = !!captionsUrl || captions.length > 0;

  return (
    <div className={`${s.wrap} ${fs ? s.fs : ''}`} ref={wrapRef} tabIndex={0} onKeyDown={onKey} aria-label="Video player" data-source={playHls ? 'hls' : (src ? 'mp4' : 'none')}>
      <video ref={videoRef} poster={poster || undefined} className={s.video} playsInline crossOrigin="anonymous"
        onClick={togglePlay} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onPlaying={onPlayingEv}
        onWaiting={onWaiting} onStalled={onWaiting} onCanPlay={() => { clearTimeout(bufferTimer.current); setBuffering(false); }}
        onLoadedMetadata={onMeta} onTimeUpdate={onTU} onProgress={onProgress} onError={onError}>
        {captionsUrl && <track kind="captions" src={captionsUrl} srcLang="und" label="Captions" default={cc} />}
      </video>

      {curCap && <div className={s.caption}>{curCap}</div>}
      {buffering && <div className={s.spinner} aria-label="Buffering"><Loader2 size={34} /></div>}
      {!playing && !buffering && <button className={s.bigPlay} onClick={togglePlay} aria-label="Play"><Play size={28} fill="currentColor" /></button>}
      {branding && (
        <a className={s.watermark} href="https://veorec.com" target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title="Made with VeoRec">
          <span className={s.watermarkDot} /> VeoRec
        </a>
      )}

      <div className={s.controls}>
        <div className={s.bar} ref={barRef} onClick={seekEv}
          onMouseMove={e => { const r = barRef.current.getBoundingClientRect(); setHoverT(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur); }}
          onMouseLeave={() => setHoverT(null)}>
          <div className={s.barBg} />
          <div className={s.barBuffered} style={{ width: `${bufferedPct}%` }} />
          <div className={s.barFill} style={{ width: `${pct(cur)}%` }} />
          {hoverT != null && <div className={s.barHover} style={{ left: `${pct(hoverT)}%` }} />}
          {(chapters || []).map((c, i) => (c && c.t > 0 ? <span key={`ch${i}`} className={s.chapterTick} style={{ left: `${pct(c.t)}%` }} title={c.title || ''} /> : null))}
          {markers.map((m, i) => (
            <button key={i} className={`${s.marker} ${m.kind === 'comment' ? s.mComment : ''}`} style={{ left: `${pct(m.t)}%` }}
              title={m.label} onClick={e => { e.stopPropagation(); onMarkerClick && onMarkerClick(m.t); }}>
              {m.kind === 'comment' ? <MessageSquare size={13} fill="currentColor" /> : m.emoji}
            </button>
          ))}
        </div>

        <div className={s.btns}>
          <button className={s.cBtn} onClick={togglePlay} title={playing ? 'Pause (k)' : 'Play (k)'}>{playing ? <Pause size={18} /> : <Play size={18} fill="currentColor" />}</button>
          <button className={s.cBtn} onClick={() => skip(-5)} title="Back 5s (←)"><RotateCcw size={17} /></button>
          <button className={s.cBtn} onClick={() => skip(5)} title="Forward 5s (→)"><RotateCw size={17} /></button>
          <div className={s.vol}>
            <button className={s.cBtn} onClick={toggleMute} title="Mute (m)">{muted || vol === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
            <input className={s.volSlider} type="range" min="0" max="1" step="0.05" value={muted ? 0 : vol} onChange={e => setVolume(Number(e.target.value))} />
          </div>
          <span className={s.time}>{clk(cur)} / {clk(dur)}</span>
          <div className={s.spacer} />
          {ccAvailable && <button className={`${s.cBtn} ${cc ? s.on : ''}`} onClick={() => setCc(c => !c)} title="Captions (c)"><Captions size={18} /></button>}
          <div className={s.spdWrap}>
            <button className={s.cBtn} onClick={() => setSpdOpen(o => !o)} title="Playback speed (< >)"><span className={s.spdLabel}>{speed}×</span></button>
            {spdOpen && <div className={s.spdMenu}>{SPEEDS.map(x => <button key={x} className={`${s.spdItem} ${x === speed ? s.on : ''}`} onClick={() => setSpd(x)}>{x}×</button>)}</div>}
          </div>
          <button className={s.cBtn} onClick={toggleFs} title="Fullscreen (f)">{fs ? <Minimize size={18} /> : <Maximize size={18} />}</button>
        </div>
      </div>
    </div>
  );
}
