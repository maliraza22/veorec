import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Play, Pause, Scissors, RotateCcw, ArrowLeft, Save, SkipBack, SkipForward, Plus, Upload, Film, X } from 'lucide-react';
import { useAuth } from '../AuthContext';
import API from '../api';
import { fetchClientConfig, webUploadIsV1, preflightSingle, uploadSingle, measureDuration, V1UploadError } from '../lib/v1Upload';
import s from './Editor.module.css';

// T-305: shown when a timeline holds a clip uploaded through the new storage.
// Composition of such a clip waits for the processing/render pipeline.
const NOT_COMPOSABLE_MSG = 'One of these clips was uploaded to the new storage and cannot be combined with other videos yet. You can still play it here — combining will be available once the new processing pipeline ships.';

function fmt(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60), sec = Math.floor(t % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

let KEY = 1;
const mkKey = () => 'c' + (KEY++);

// Gallery card thumbnail — static poster + muted autoplay video on hover (matches
// the library's animated thumbnail).
function GalThumb({ v }) {
  const [hover, setHover] = useState(false);
  return (
    <span className={s.galThumb} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {v.thumbnail ? <img src={v.thumbnail} alt="" loading="lazy" /> : <span className={s.galPh} />}
      {hover && <video src={v.filename} muted autoPlay loop playsInline />}
      <span className={s.galDur}>{fmt(v.duration || 0)}</span>
    </span>
  );
}

// The editor is a horizontal multi-clip timeline. Each clip is {id, in, out} from
// some owned video. You can reorder (drag), split, delete and add clips. Saving
// trims (base-only) or composes (multi-video) server-side via Cloudinary.
export default function Editor() {
  const { id } = useParams();
  const { authFetch } = useAuth();
  const navigate = useNavigate();
  const videoRef = useRef(null);
  const trackRef = useRef(null);
  const loadedKey = useRef(null);

  const [rec, setRec] = useState(null);
  const [clips, setClips] = useState([]); // [{key,id,src,title,dur,in,out}]
  const [playhead, setPlayhead] = useState(0); // global seconds
  const [playing, setPlaying] = useState(false);
  const [selKey, setSelKey] = useState(null);
  const [dragKey, setDragKey] = useState(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [exportMsg, setExportMsg] = useState('');
  const [indeterminate, setIndeterminate] = useState(false);
  const [chooser, setChooser] = useState(false);
  const [picker, setPicker] = useState(null); // { tab, videos, uploading }

  useEffect(() => {
    authFetch(`${API}/api/recordings/${id}`).then((r) => r.json()).then((d) => {
      setRec(d);
      const dur = d.duration || 0;
      let init;
      if (Array.isArray(d.segments) && d.segments.length) {
        init = d.segments.map((sg) => ({ key: mkKey(), id, src: d.filename, title: d.title, dur, in: sg.start, out: sg.end }));
      } else {
        const st = d.trimStart != null ? d.trimStart : 0, en = d.trimEnd != null ? d.trimEnd : dur;
        init = [{ key: mkKey(), id, src: d.filename, title: d.title, dur, in: st, out: en || dur }];
      }
      setClips(init);
    }).catch(() => {});
  }, [id]);

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
    setClips((cs) => {
      const c = cs[i]; const next = [...cs];
      next.splice(i, 1, { ...c, key: mkKey(), out: c.in + off }, { ...c, key: mkKey(), in: c.in + off });
      return next;
    });
  }
  function delClip(key) {
    setClips((cs) => (cs.length <= 1 ? cs : cs.filter((c) => c.key !== key)));
    if (selKey === key) setSelKey(null);
  }
  function resetEdits() {
    if (!rec) return;
    const dur = rec.duration || 0;
    loadedKey.current = null;
    setClips([{ key: mkKey(), id, src: rec.filename, title: rec.title, dur, in: 0, out: dur }]);
    setPlayhead(0);
  }

  // Pointer drag to reorder a clip on the timeline.
  useEffect(() => {
    if (!dragKey) return;
    function move(e) {
      const g = clientXToGlobal(e.clientX);
      const { i: target } = locate(g);
      setClips((cs) => {
        const from = cs.findIndex((c) => c.key === dragKey);
        if (from === -1 || from === target) return cs;
        const next = [...cs]; const [m] = next.splice(from, 1); next.splice(target, 0, m); return next;
      });
    }
    function up() { setDragKey(null); }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    // eslint-disable-next-line
  }, [dragKey, total]);

  // ── Add clips (popup: gallery / upload) ───────────────────────────────────────
  function openPicker() {
    if (rec && rec.canStitch === false) { if (window.confirm('Adding clips is a Pro feature. Open pricing to upgrade?')) navigate('/pricing'); return; }
    setPicker({ tab: 'gallery', videos: null, uploading: false });
    authFetch(`${API}/api/recordings`).then((r) => (r.ok ? r.json() : []))
      .then((d) => setPicker((p) => p && { ...p, videos: Array.isArray(d) ? d.filter((v) => v.id !== id) : [] }))
      .catch(() => setPicker((p) => p && { ...p, videos: [] }));
  }
  function addClip(vid, src, title, dur, extra = {}) {
    setClips((cs) => [...cs, { key: mkKey(), id: vid, src, title, dur: dur || 0, in: 0, out: dur || 0, ...extra }]);
    setPicker(null);
  }
  function addFromGallery(v) { addClip(v.id, v.filename, v.title, v.duration || 0); }
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
          // Marked v1: it plays from a signed URL, and it cannot be composed
          // by the current Cloudinary pipeline (see saveCompose).
          addClip(r.recordingId, r.playbackUrl || '', name, dur, { v1: true });
          return;
        } catch (e) {
          // Fallback to legacy is allowed ONLY before a v1 session existed.
          // After that, falling back would upload the same file twice.
          if (!(e instanceof V1UploadError) || !e.fallbackAllowed) {
            alert((e && e.userMessage) || 'Upload failed — please try again.');
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
      if (!res.ok || !d.id) { alert(d.error || 'Could not upload that clip.'); setPicker((p) => p && { ...p, uploading: false }); return; }
      // grab the playable URL + measured duration of the new asset
      let meta = {};
      try { meta = await authFetch(`${API}/api/recordings/${d.id}`).then((x) => x.json()); } catch (e) {}
      addClip(d.id, meta.filename || '', name, meta.duration || 0);
    } catch (e) { alert('Upload failed — please try again.'); setPicker((p) => p && { ...p, uploading: false }); }
  }

  // ── Save ──────────────────────────────────────────────────────────────────────
  const hasOther = clips.some((c) => c.id !== id);
  function onSaveClick() {
    const baseFull = !hasOther && clips.length === 1 && clips[0].in <= 0.05 && clips[0].out >= (rec.duration || 0) - 0.05;
    if (baseFull) { saveTrim('overwrite'); return; }
    setChooser(true);
  }
  function doSave(mode) { setChooser(false); if (hasOther) saveCompose(mode); else saveTrim(mode); }
  async function saveCompose(mode) {
    if (rec.canStitch === false) { if (window.confirm('Adding clips is a Pro feature. Upgrade?')) navigate('/pricing'); return; }
    // T-305: a v1-uploaded clip cannot be composed by the current pipeline.
    // Say so plainly here rather than sending a request that will be refused.
    if (clips.some((c) => c.v1)) { alert(NOT_COMPOSABLE_MSG); return; }
    try { videoRef.current && videoRef.current.pause(); } catch (e) {}
    setExporting(true); setIndeterminate(true); setProgress(0);
    setExportMsg(mode === 'copy' ? 'Building your video into a new copy…' : 'Building your video on our servers…');
    try {
      const res = await authFetch(`${API}/api/recordings/${id}/compose`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clips: clips.map((c) => ({ id: c.id, start: c.in, end: c.out })), mode }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { setIndeterminate(false); setProgress(1); setExportMsg('Saved ✓ Your video is ready.'); setTimeout(() => navigate(d.id ? `/watch/${d.id}` : '/'), 1100); return; }
      if (res.status === 403 && d.code === 'feature_locked') { setExporting(false); if (window.confirm('Adding clips is a Pro feature. Upgrade?')) navigate('/pricing'); return; }
      // T-305: the server's own refusal for a v1 clip — a plain explanation, never a generic failure.
      if (res.status === 409 && d.code === 'clip_not_composable') { setExporting(false); alert(NOT_COMPOSABLE_MSG); return; }
      throw new Error(d.error || 'Save failed');
    } catch (e) { setIndeterminate(false); setExportMsg('Could not save: ' + (e.message || 'error')); setTimeout(() => setExporting(false), 2800); }
  }
  async function saveTrim(mode) {
    const segments = clips.map((c) => ({ start: c.in, end: c.out }));
    const isFull = clips.length === 1 && segments[0].start <= 0.05 && segments[0].end >= (rec.duration || 0) - 0.05;
    if (isFull) {
      setSaving(true);
      await authFetch(`${API}/api/recordings/${id}/meta`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ segments: null, trimStart: null, trimEnd: null }) });
      setSaving(false); setTimeout(() => navigate('/'), 800); return;
    }
    try { videoRef.current && videoRef.current.pause(); } catch (e) {}
    setExporting(true); setIndeterminate(true); setProgress(0);
    setExportMsg(mode === 'copy' ? 'Creating a trimmed copy…' : 'Trimming your video…');
    try {
      const res = await authFetch(`${API}/api/recordings/${id}/trim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ segments, mode }) });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { setIndeterminate(false); setProgress(1); setExportMsg('Saved ✓'); setTimeout(() => navigate('/'), 1100); return; }
      throw new Error(d.error || 'Trim failed');
    } catch (e) { setIndeterminate(false); setExportMsg('Could not trim: ' + (e.message || 'error')); setTimeout(() => setExporting(false), 2800); }
  }

  if (!rec) return <div className={s.loading}>Loading editor…</div>;
  const pctL = (i) => (total ? (startOf(i) / total) * 100 : 0);
  const pctW = (c) => (total ? (len(c) / total) * 100 : 0);

  return (
    <div className={s.page}>
      <header className={s.topbar}>
        <Link to="/" className={s.back}><ArrowLeft size={16} /> Back to library</Link>
        <div className={s.title}>{rec.title}</div>
        <div className={s.topActions}>
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
            <button className={s.chooserOpt} onClick={() => doSave('overwrite')}>
              <span className={s.chooserOptIcon}>♻️</span>
              <span className={s.chooserOptText}><strong>Overwrite original</strong><em>Replace this video with the edited version.</em></span>
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
            <div className={s.exportNote}>Our servers are cutting and stitching your clips — this is usually quick.</div>
          </div>
        </div>
      )}
    </div>
  );
}
