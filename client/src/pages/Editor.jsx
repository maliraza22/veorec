import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Play, Pause, Scissors, RotateCcw, ArrowLeft, Save, SkipBack, SkipForward, Plus, Upload, Film, X, Undo2, Redo2, AudioLines } from 'lucide-react';
import { useAuth } from '../AuthContext';
import API from '../api';
import { fetchClientConfig, webUploadIsV1, preflightSingle, uploadSingle, measureDuration, V1UploadError } from '../lib/v1Upload';
import { useEditorClient } from '../hooks/useEditorClient';
import { isFullLength, isSingleSource, timelineFromRecording } from '../lib/editorApi.mjs';
import { useToast } from '../components/Toast';
import s from './Editor.module.css';

// T-305: shown when a LEGACY timeline holds a clip uploaded through the new storage.
// (On the v1 editor every owned, ready recording is composable — the worker renders.)
const NOT_COMPOSABLE_MSG = 'One of these clips was uploaded to the new storage and cannot be combined with other videos yet. You can still play it here — combining will be available once the new processing pipeline ships.';

function fmt(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60), sec = Math.floor(t % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

let KEY = 1;
const mkKey = () => 'c' + (KEY++);

// Gallery card thumbnail — static poster + muted autoplay video on hover (matches
// the library's animated thumbnail). A v1 row has no full-file URL: poster only.
function GalThumb({ v }) {
  const [hover, setHover] = useState(false);
  return (
    <span className={s.galThumb} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {v.thumbnail ? <img src={v.thumbnail} alt="" loading="lazy" /> : <span className={s.galPh} />}
      {hover && v.filename && <video src={v.filename} muted autoPlay loop playsInline />}
      <span className={s.galDur}>{fmt(v.duration || 0)}</span>
    </span>
  );
}

/** What the current timeline means for "Save" (docs/14 §4). */
function saveKindFor(clips, rec) {
  if (!rec) return null;
  if (isFullLength(clips, rec)) return 'clear';                 // whole video → clears the virtual edit
  if (isSingleSource(clips, rec.id)) return 'single';            // cuts on this video only → virtual or bake
  return 'multi';                                                // several videos → bake (Pro)
}

// The editor is a horizontal multi-clip timeline. Each clip is {id, in, out} from
// some owned video. You can reorder (drag), split, delete and add clips, undo /
// redo, and remove silences. Saving is instant (a virtual edit on the recording)
// or a RENDER in the worker (edit session → render job with real progress) —
// which API answers is the server's decision (T-1201; legacy = Cloudinary as before).
export default function Editor() {
  const { id } = useParams();
  const { authFetch } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const { client, ready: clientReady, useV1 } = useEditorClient();
  const videoRef = useRef(null);
  const trackRef = useRef(null);
  const loadedKey = useRef(null);
  const renderAbort = useRef(null);

  const [rec, setRec] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [clips, setClipsRaw] = useState([]); // [{key,id,src,title,dur,in,out}]
  const [history, setHistory] = useState({ past: [], future: [] });
  const [playhead, setPlayhead] = useState(0); // global seconds
  const [playing, setPlaying] = useState(false);
  const [selKey, setSelKey] = useState(null);
  const [dragKey, setDragKey] = useState(null);
  const dragStart = useRef(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [exportMsg, setExportMsg] = useState('');
  const [exportNote, setExportNote] = useState('');
  const [indeterminate, setIndeterminate] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  const [chooser, setChooser] = useState(false);
  const [picker, setPicker] = useState(null); // { tab, videos, uploading }
  const [desilencing, setDesilencing] = useState(false);

  /** Every edit goes through here so undo/redo see it. */
  function commit(next) {
    setHistory((h) => ({ past: [...h.past.slice(-49), clips], future: [] }));
    setClipsRaw(next);
  }
  function undo() {
    if (!history.past.length) return;
    const prev = history.past[history.past.length - 1];
    setHistory({ past: history.past.slice(0, -1), future: [clips, ...history.future].slice(0, 50) });
    setClipsRaw(prev); loadedKey.current = null; setPlayhead(0);
  }
  function redo() {
    if (!history.future.length) return;
    const next = history.future[0];
    setHistory({ past: [...history.past, clips].slice(-50), future: history.future.slice(1) });
    setClipsRaw(next); loadedKey.current = null; setPlayhead(0);
  }
  const clipsRef = useRef(clips); clipsRef.current = clips;
  const baseClips = (d) => timelineFromRecording(d).map((c) => ({ key: mkKey(), id: d.id, src: d.filename, title: d.title, dur: d.duration || 0, in: c.start, out: c.end }));

  useEffect(() => {
    if (!client) return;
    let alive = true;
    client.loadRecording(id).then((r) => {
      if (!alive) return;
      if (r.error || !r.rec) { setLoadError(r.error || 'Could not load this video.'); return; }
      setRec(r.rec);
      setClipsRaw(baseClips(r.rec));
      setHistory({ past: [], future: [] });
    }).catch(() => { if (alive) setLoadError('Could not load this video.'); });
    return () => { alive = false; };
    // eslint-disable-next-line
  }, [id, client]);

  const len = (c) => Math.max(0, c.out - c.in);
  const total = useMemo(() => clips.reduce((a, c) => a + len(c), 0), [clips]);
  const startOf = (i) => clips.slice(0, i).reduce((a, c) => a + len(c), 0);
  function locate(g) {
    let a = 0;
    for (let i = 0; i < clips.length; i++) {
      const l = len(clips[i]);
      if (g < a + l || i === clips.length - 1) return { i, off: Math.max(0, Math.min(l, g - a)) };
      a += l;
    }
    return { i: 0, off: 0 };
  }

  // ── Preview: load the clip under the playhead; switch <video> src per clip ─────
  const here = useMemo(() => locate(playhead), [playhead, clips]);
  const hereClip = clips[here.i];
  useEffect(() => {
    const v = videoRef.current; const c = hereClip; if (!v || !c) return;
    if (loadedKey.current === c.key) return;
    loadedKey.current = c.key;
    const off = here.off;
    const go = () => { try { v.currentTime = c.in + off; } catch (e) {} if (playing) v.play().catch(() => {}); };
    // Guard against a stale load callback from a previous clip firing after a
    // rapid seek moved us to a different clip (would seek the new source to the
    // old time). Only apply if this is still the clip we want.
    if (v.src !== c.src) { v.src = c.src; v.onloadeddata = () => { if (loadedKey.current === c.key) { v.onloadeddata = null; go(); } }; }
    else go();
    // eslint-disable-next-line
  }, [hereClip && hereClip.key]);

  function onTimeUpdate() {
    const v = videoRef.current; if (!v) return;
    const c = clips.find((x) => x.key === loadedKey.current); if (!c) return;
    const i = clips.indexOf(c);
    if (v.currentTime >= c.out - 0.05) {
      if (i < clips.length - 1) setPlayhead(startOf(i + 1) + 0.01);
      else { v.pause(); setPlaying(false); setPlayhead(total); }
    } else {
      setPlayhead(Math.min(total, startOf(i) + Math.max(0, v.currentTime - c.in)));
    }
  }
  function togglePlay() {
    const v = videoRef.current; if (!v) return;
    if (v.paused) { setPlaying(true); if (playhead >= total - 0.1) seekGlobal(0); v.play().catch(() => {}); }
    else { v.pause(); setPlaying(false); }
  }
  function clientXToGlobal(clientX) {
    const rect = trackRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * total;
  }
  function seekGlobal(g) {
    g = Math.max(0, Math.min(total, g));
    const { i, off } = locate(g);
    const c = clips[i];
    setPlayhead(g);
    if (c && loadedKey.current === c.key) { const v = videoRef.current; if (v) v.currentTime = c.in + off; }
  }

  // ── Edits ─────────────────────────────────────────────────────────────────────
  function splitAtPlayhead() {
    const { i, off } = locate(playhead);
    if (!clips[i] || off < 0.2 || off > len(clips[i]) - 0.2) return;
    const c = clips[i]; const next = [...clips];
    next.splice(i, 1, { ...c, key: mkKey(), out: c.in + off }, { ...c, key: mkKey(), in: c.in + off });
    commit(next);
  }
  function delClip(key) {
    if (clips.length <= 1) return;
    commit(clips.filter((c) => c.key !== key));
    if (selKey === key) setSelKey(null);
  }
  function resetEdits() {
    if (!rec) return;
    loadedKey.current = null;
    commit([{ key: mkKey(), id, src: rec.filename, title: rec.title, dur: rec.duration || 0, in: 0, out: rec.duration || 0 }]);
    setPlayhead(0);
  }

  // Pointer drag to reorder a clip on the timeline (one undo step per drag).
  useEffect(() => {
    if (!dragKey) return;
    dragStart.current = clips;
    function move(e) {
      const g = clientXToGlobal(e.clientX);
      const { i: target } = locate(g);
      setClipsRaw((cs) => {
        const from = cs.findIndex((c) => c.key === dragKey);
        if (from === -1 || from === target) return cs;
        const next = [...cs]; const [m] = next.splice(from, 1); next.splice(target, 0, m); return next;
      });
    }
    function up() {
      setDragKey(null);
      const before = dragStart.current; dragStart.current = null;
      const after = clipsRef.current;
      if (before && before.map((c) => c.key).join() !== after.map((c) => c.key).join()) setHistory((h) => ({ past: [...h.past.slice(-49), before], future: [] }));
    }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    // eslint-disable-next-line
  }, [dragKey, total]);

  // ── Add clips (popup: gallery / upload) ───────────────────────────────────────
  function openPicker() {
    if (rec && rec.canStitch === false) { if (window.confirm('Adding clips is a Pro feature. Open pricing to upgrade?')) navigate('/pricing'); return; }
    setPicker({ tab: 'gallery', videos: null, uploading: false });
    client.listGallery(id)
      .then((videos) => setPicker((p) => p && { ...p, videos }))
      .catch(() => setPicker((p) => p && { ...p, videos: [] }));
  }
  function addClip(vid, src, title, dur, extra = {}) {
    commit([...clips, { key: mkKey(), id: vid, src, title, dur: dur || 0, in: 0, out: dur || 0, ...extra }]);
    setPicker(null);
  }
  async function addFromGallery(v) {
    if (!useV1) { addClip(v.id, v.filename, v.title, v.duration || 0); return; }
    // A v1 row carries no media URL: fetch the detail for its signed, active media.
    const r = await client.loadRecording(v.id);
    if (r.error || !r.rec || !r.rec.filename) { toast.error(r.error || 'That video cannot be previewed right now.'); return; }
    addClip(v.id, r.rec.filename, r.rec.title, r.rec.duration || v.duration || 0);
  }
  async function uploadClip(file) {
    if (!file) return;
    setPicker((p) => p && { ...p, uploading: true });
    try {
      const name = (file.name || 'Uploaded clip').replace(/\.[^.]+$/, '').slice(0, 60) || 'Uploaded clip';

      // T-305: the SERVER decides whether this editor uses the v1 single-PUT
      // path (a gate separate from the extension rollout). Only an explicit
      // "v1" answer changes anything; everything else is the legacy path below,
      // exactly as before.
      const cfg = await fetchClientConfig({ API, authFetch });
      if (webUploadIsV1(cfg) && preflightSingle(file).ok) {
        try {
          const r = await uploadSingle({ API, authFetch, file, title: name });
          const dur = await measureDuration(file);
          // On the v1 editor the upload is composable once its pipeline is done
          // (the render refuses a clip that is not ready, honestly); on the
          // legacy editor it is marked so compose says why (T-305).
          addClip(r.recordingId, r.playbackUrl || '', name, dur, useV1 ? { fresh: true } : { v1: true });
          if (useV1) toast.info('Your upload is processing — it can be combined as soon as it is ready.', { ttl: 6000 });
          return;
        } catch (e) {
          // Fallback to legacy is allowed ONLY before a v1 session existed.
          // After that, falling back would upload the same file twice.
          if (!(e instanceof V1UploadError) || !e.fallbackAllowed) {
            toast.error((e && e.userMessage) || 'Upload failed — please try again.');
            setPicker((p) => p && { ...p, uploading: false });
            return;
          }
          // Nothing was established on v1 — continue on the legacy path.
        }
      }

      const form = new FormData();
      form.append('video', file, file.name || 'clip.mp4');
      form.append('title', name); form.append('duration', '0');
      const res = await authFetch(`${API}/api/upload`, { method: 'POST', body: form });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.id) { toast.error(d.error || 'Could not upload that clip.'); setPicker((p) => p && { ...p, uploading: false }); return; }
      // grab the playable URL + measured duration of the new asset
      let meta = {};
      try { meta = await authFetch(`${API}/api/recordings/${d.id}`).then((x) => x.json()); } catch (e) {}
      addClip(d.id, meta.filename || '', name, meta.duration || 0);
    } catch (e) { toast.error('Upload failed — please try again.'); setPicker((p) => p && { ...p, uploading: false }); }
  }

  // ── Remove silences (T-1204: a worker job on v1; the legacy route otherwise) ──
  async function removeSilences() {
    if (!rec || desilencing) return;
    if (useV1 && rec.ready === false) { toast.info('Silence removal needs a fully processed video — try again once it is ready.'); return; }
    setDesilencing(true);
    try {
      const r = await client.removeSilences(id);
      if (r.error) { toast.error(r.error); return; }
      const next = (r.segments || []).map((sg) => ({ key: mkKey(), id, src: rec.filename, title: rec.title, dur: rec.duration || 0, in: sg.start, out: sg.end }));
      if (!next.length) { toast.info('No silences to remove.'); return; }
      loadedKey.current = null; commit(next); setPlayhead(0);
      setRec((x) => ({ ...x, segments: r.segments }));
      toast.success(`Removed ~${r.removedSeconds}s of silence (kept ${r.keptSeconds}s). The player now skips the quiet gaps — save to bake it permanently.`, { ttl: 8000 });
    } catch { toast.error('Network error — please try again.'); }
    finally { setDesilencing(false); }
  }

  // ── Save ──────────────────────────────────────────────────────────────────────
  const hasOther = clips.some((c) => c.id !== id);
  const saveKind = saveKindFor(clips, rec);
  function onSaveClick() {
    if (saveKind === 'clear') { saveVirtual(null); return; }
    setChooser(true);
  }
  function doSave(mode) { setChooser(false); if (mode === 'virtual') saveVirtual(clips.map((c) => ({ start: c.in, end: c.out }))); else saveRender(mode); }
  async function saveVirtual(segments) {
    setSaving(true);
    try {
      const r = await client.saveVirtual(id, { segments, trimStart: null, trimEnd: null });
      if (r.error) { toast.error(r.error); return; }
      toast.success(segments ? 'Saved — the player skips the cut parts instantly.' : 'Edits cleared.');
      setTimeout(() => navigate(useV1 ? `/watch/${id}` : '/'), 800);
    } catch { toast.error('Network error — please try again.'); }
    finally { setSaving(false); }
  }
  function upgradePrompt(message) {
    setExporting(false);
    if (window.confirm(`${message || 'This is a Pro feature.'} Open pricing to upgrade?`)) navigate('/pricing');
  }
  async function saveRender(mode) {
    if (hasOther && rec.canStitch === false) { upgradePrompt('Adding clips is a Pro feature.'); return; }
    // T-305: a v1-uploaded clip cannot be composed by the LEGACY pipeline.
    if (!useV1 && clips.some((c) => c.v1)) { toast.error(NOT_COMPOSABLE_MSG, { ttl: 8000 }); return; }
    try { videoRef.current && videoRef.current.pause(); } catch (e) {}
    setPlaying(false);
    setExporting(true); setExportFailed(false); setIndeterminate(true); setProgress(0);
    setExportMsg(mode === 'copy' ? 'Building your video into a new copy…' : 'Building your video on our servers…');
    setExportNote(useV1 ? 'Your clips are being cut and stitched by our render workers. The original is never touched — you can leave this page; the render continues.' : 'Our servers are cutting and stitching your clips — this is usually quick.');
    try {
      const r = await client.startRender({ recordingId: id, clips, mode });
      if (r.error) {
        if (r.code === 'feature_locked' || r.upgradeRequired) return upgradePrompt(r.error);
        if (r.code === 'render_in_progress') { setExporting(false); toast.info('A render of this video is already running — check back in a moment.'); return; }
        if (r.code === 'clip_not_composable') { setExporting(false); toast.error(NOT_COMPOSABLE_MSG, { ttl: 8000 }); return; }
        throw new Error(r.error);
      }
      if (r.done) { setIndeterminate(false); setProgress(1); setExportMsg('Saved ✓ Your video is ready.'); setTimeout(() => navigate(hasOther && r.id ? `/watch/${r.id}` : '/'), 1100); return; }
      // v1: the worker renders; the progress bar is the job's real progress.
      setIndeterminate(false);
      renderAbort.current = new AbortController();
      const job = await client.waitForRender(r.renderJobId, { onProgress: (p) => setProgress(p / 100), signal: renderAbort.current.signal });
      if (job.status === 'done') {
        setProgress(1); setExportMsg(mode === 'copy' ? 'Saved ✓ Your new copy is processing and will be ready shortly.' : 'Saved ✓ Your video is ready.');
        setTimeout(() => navigate(`/watch/${r.outputRecordingId || id}`), 1100); return;
      }
      if (job.status === 'aborted') return;
      throw new Error(job.error || 'The render failed. Your edit is kept — you can try again.');
    } catch (e) {
      setIndeterminate(false); setExportFailed(true);
      setExportMsg('Could not save: ' + (e.message || 'error'));
      setExportNote('Nothing was changed. Your timeline is still here — adjust it or try again.');
    }
  }

  if (loadError) return <div className={s.loading}>{loadError} <Link to="/">Back to library</Link></div>;
  if (!clientReady || !rec) return <div className={s.loading}>Loading editor…</div>;
  const pctL = (i) => (total ? (startOf(i) / total) * 100 : 0);
  const pctW = (c) => (total ? (len(c) / total) * 100 : 0);
  const modeHint = saveKind === 'clear' ? 'Whole video — saving clears your edits'
    : saveKind === 'single' ? 'Cuts on this video — save instantly (virtual) or bake a new file'
    : `${clips.length} clips — saving renders a new file${rec.canStitch === false ? ' (Pro)' : ''}`;

  return (
    <div className={s.page}>
      <header className={s.topbar}>
        <Link to="/" className={s.back}><ArrowLeft size={16} /> Back to library</Link>
        <div className={s.title}>{rec.title}</div>
        <div className={s.topActions}>
          <button className={s.ghost} onClick={undo} disabled={!history.past.length} title="Undo (the last edit)"><Undo2 size={15} /> Undo</button>
          <button className={s.ghost} onClick={redo} disabled={!history.future.length} title="Redo"><Redo2 size={15} /> Redo</button>
          <button className={s.ghost} onClick={resetEdits}><RotateCcw size={15} /> Reset</button>
          <button className={s.primary} onClick={onSaveClick} disabled={saving}>
            <Save size={15} /> {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </header>

      <div className={s.stage}>
        <video ref={videoRef} className={s.video} onTimeUpdate={onTimeUpdate} onClick={togglePlay} playsInline />
      </div>

      {/* Transport — Add video sits beside Split */}
      <div className={s.transport}>
        <button className={s.tbtn} onClick={() => seekGlobal(playhead - 5)} title="Back 5s"><SkipBack size={18} /></button>
        <button className={s.playBtn} onClick={togglePlay}>{playing ? <Pause size={20} /> : <Play size={20} fill="currentColor" />}</button>
        <button className={s.tbtn} onClick={() => seekGlobal(playhead + 5)} title="Forward 5s"><SkipForward size={18} /></button>
        <div className={s.time}>{fmt(playhead)} <span>/ {fmt(total)}</span></div>
        <div className={s.spacer} />
        <button className={s.tbtn} onClick={removeSilences} disabled={desilencing} title="Detect the quiet gaps and cut them (you can undo)">
          <AudioLines size={17} /> {desilencing ? 'Finding silences…' : 'Remove silences'}
        </button>
        <button className={s.tbtn} onClick={openPicker} title="Add a video clip">
          <Plus size={17} /> Add video{rec.canStitch === false && <span className={s.proTag}>Pro</span>}
        </button>
        <button className={s.tbtn} onClick={splitAtPlayhead} title="Split at playhead"><Scissors size={17} /> Split</button>
      </div>

      {/* Multi-clip timeline */}
      <div className={s.timelineWrap}>
        <div className={s.track} ref={trackRef} onClick={(e) => { if (!dragKey) seekGlobal(clientXToGlobal(e.clientX)); }}>
          {clips.map((c, i) => (
            <div
              key={c.key}
              className={`${s.clip} ${selKey === c.key ? s.clipSel : ''} ${dragKey === c.key ? s.clipDrag : ''} ${c.id !== id ? s.clipAlt : ''}`}
              style={{ left: `${pctL(i)}%`, width: `${pctW(c)}%` }}
              onMouseDown={(e) => { if (e.target.closest('[data-nodrag]')) return; e.stopPropagation(); setSelKey(c.key); setDragKey(c.key); }}
              title={c.title}
            >
              <span className={s.clipName}>{c.title}</span>
              <span className={s.clipDur}>{fmt(len(c))}</span>
              {clips.length > 1 && (
                <button data-nodrag className={s.clipDel} onClick={(e) => { e.stopPropagation(); delClip(c.key); }} title="Remove clip"><X size={12} /></button>
              )}
            </div>
          ))}
          <div className={s.playhead} style={{ left: `${total ? (playhead / total) * 100 : 0}%` }} />
        </div>
        <div className={s.tlMeta}>
          <span>Drag a clip to reorder · Split &amp; delete to cut · Add video to append</span>
          <span className={s.modeHint} data-kind={saveKind}>{modeHint}</span>
          <span>Final length: <strong>{fmt(total)}</strong></span>
        </div>
      </div>

      {/* Add-video popup */}
      {picker && (
        <div className={s.modalBg} onClick={() => setPicker(null)}>
          <div className={s.modal} onClick={(e) => e.stopPropagation()}>
            <div className={s.modalHead}>
              <div className={s.tabs}>
                <button className={`${s.tab} ${picker.tab === 'gallery' ? s.tabActive : ''}`} onClick={() => setPicker((p) => ({ ...p, tab: 'gallery' }))}>Gallery</button>
                <button className={`${s.tab} ${picker.tab === 'upload' ? s.tabActive : ''}`} onClick={() => setPicker((p) => ({ ...p, tab: 'upload' }))}>Upload new</button>
              </div>
              <button className={s.modalClose} onClick={() => setPicker(null)}><X size={18} /></button>
            </div>
            {picker.tab === 'upload' ? (
              <label className={s.uploadZone}>
                <Upload size={30} />
                <strong>{picker.uploading ? 'Uploading…' : 'Upload a video'}</strong>
                <span>Choose a file from your computer to add to the timeline</span>
                <input type="file" accept="video/*" hidden disabled={picker.uploading} onChange={(e) => uploadClip(e.target.files && e.target.files[0])} />
              </label>
            ) : (
              <div className={s.gallery}>
                {picker.videos == null ? <p className={s.galEmpty}>Loading your videos…</p>
                  : picker.videos.length === 0 ? <p className={s.galEmpty}>No other videos in your library yet.</p>
                  : picker.videos.map((v) => (
                    <button key={v.id} className={s.galCard} onClick={() => addFromGallery(v)}>
                      <GalThumb v={v} />
                      <span className={s.galTitle}>{v.title}</span>
                    </button>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}

      {chooser && (
        <div className={s.exportOverlay} onClick={() => setChooser(false)}>
          <div className={s.chooserCard} onClick={(e) => e.stopPropagation()}>
            <div className={s.chooserTitle}>How do you want to save?</div>
            <div className={s.chooserSub}>Final length <strong>{fmt(total)}</strong>{hasOther ? ` · ${clips.length} clips` : ''}</div>
            {saveKind === 'single' && (
              <button className={s.chooserOpt} onClick={() => doSave('virtual')}>
                <span className={s.chooserOptIcon}>⚡</span>
                <span className={s.chooserOptText}><strong>Save instantly</strong><em>The player skips the cut parts. Free, immediate and reversible — nothing is re-encoded.</em></span>
              </button>
            )}
            <button className={s.chooserOpt} onClick={() => doSave('overwrite')}>
              <span className={s.chooserOptIcon}>♻️</span>
              <span className={s.chooserOptText}><strong>Overwrite original</strong><em>{useV1 ? 'Render a new file and make it this video (the original recording is kept safe).' : 'Replace this video with the edited version.'}</em></span>
            </button>
            <button className={s.chooserOpt} onClick={() => doSave('copy')}>
              <span className={s.chooserOptIcon}>➕</span>
              <span className={s.chooserOptText}><strong>Save as a new copy</strong><em>Keep the original and add the edit to your library.</em></span>
            </button>
            <button className={s.chooserCancel} onClick={() => setChooser(false)}>Cancel</button>
          </div>
        </div>
      )}

      {exporting && (
        <div className={s.exportOverlay}>
          <div className={s.exportCard}>
            <div className={s.exportTitle}>{exportMsg}</div>
            {indeterminate ? (
              <div className={s.exportBar}><div className={s.exportIndet} /></div>
            ) : (
              <><div className={s.exportBar}><div className={s.exportFill} style={{ width: `${Math.round(progress * 100)}%` }} /></div><div className={s.exportPct}>{Math.round(progress * 100)}%</div></>
            )}
            <div className={s.exportNote}>{exportNote}</div>
            {exportFailed && <button className={s.ghost} onClick={() => setExporting(false)} style={{ marginTop: 14 }}>Back to the editor</button>}
            {!exportFailed && useV1 && progress < 1 && !indeterminate && (
              <button className={s.ghost} onClick={() => { if (renderAbort.current) renderAbort.current.abort(); setExporting(false); toast.info('The render continues in the background — the result appears in your library when it is done.', { ttl: 7000 }); }} style={{ marginTop: 14 }}>Continue in background</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
