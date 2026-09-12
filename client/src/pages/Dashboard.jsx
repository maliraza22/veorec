import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  MoreHorizontal, Copy, Share2, BarChart2, Pencil, Trash2, Check,
  LayoutGrid, List, Lock, Users as UsersIcon, Play, Film, FolderInput, Scissors, CopyPlus,
  Archive, ArchiveRestore,
} from 'lucide-react';
import styles from './Dashboard.module.css';
import API from '../api';
import { useAuth } from '../AuthContext';
import AppShell from '../components/AppShell';
import UpgradeModal from '../components/UpgradeModal';
import { useToast } from '../components/Toast';
import { useLibraryClient } from '../hooks/useLibraryClient';

// T-803: the library reads (and its writes) go through the library data layer:
// PostgreSQL via /api/v1 when the server says `library.path === 'v1'`, the
// legacy routes otherwise. A v1 card never builds a Cloudinary URL — its
// thumbnail/poster/preview are signed storage URLs minted by the API, and a
// legacy row the backfill has not reached arrives with `legacyMedia`.

const CLIENT_BASE = typeof window !== 'undefined' ? window.location.origin : '';

function fmtDur(s) { const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; }
function timeAgo(ts) {
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) { const h = Math.floor(d / 3600); return `${h} hour${h > 1 ? 's' : ''} ago`; }
  const days = Math.floor(d / 86400);
  if (days < 30) return `${days} day${days > 1 ? 's' : ''} ago`;
  return new Date(ts).toLocaleDateString();
}

export default function Dashboard() {
  const { user, authFetch } = useAuth();
  const [recordings, setRecordings] = useState([]);
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [copied, setCopied] = useState(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('newest');
  const [view, setView] = useState('grid');
  const [showArchived, setShowArchived] = useState(false);
  const [settingsRec, setSettingsRec] = useState(null);
  const [analyticsRec, setAnalyticsRec] = useState(null);
  const [upgrade, setUpgrade] = useState(null);
  const [confirmState, setConfirmState] = useState(null);

  const { client, ready } = useLibraryClient();
  const toast = useToast();
  const byId = (id) => recordings.find((x) => x.id === id);

  async function load() {
    if (!client) return;
    try {
      const [r, f] = await Promise.all([client.listRecordings(), client.listFolders()]);
      setRecordings(r);
      setFolders(f);
    } catch (e) { toast.error(e.message || 'Could not load your library.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (ready) load(); /* eslint-disable-next-line */ }, [ready, client]);

  function deleteRec(id) {
    setConfirmState({
      title: 'Delete recording?', message: 'This permanently removes the video and its link. This cannot be undone.',
      danger: true, confirmLabel: 'Delete',
      onConfirm: async () => { const r = await client.remove(byId(id)); if (r.ok) setRecordings((rs) => rs.filter((x) => x.id !== id)); else toast.error('Could not delete this video.'); },
    });
  }
  async function duplicateRec(id) {
    const rec = byId(id);
    if (rec && rec.source === 'v1') { toast.info('Duplicating is coming to migrated recordings soon.'); return; }
    const res = await authFetch(`${API}/api/recordings/${id}/duplicate`, { method: 'POST' });
    const d = await res.json().catch(() => ({}));
    if (res.ok && d.id) load(); else toast.error(d.error || 'Could not duplicate this video.');
  }
  async function saveTitle(id) {
    const title = (editTitle || '').trim();
    if (!title) { setEditingId(null); return; }  // don't save empty titles
    const r = await client.rename(byId(id), title);
    if (r.error) { toast.error(r.error); return; }
    setRecordings((rs) => rs.map((x) => (x.id === id ? { ...x, title: r.title } : x)));
    setEditingId(null);
  }
  function copyLink(id) { navigator.clipboard.writeText(`${CLIENT_BASE}/watch/${id}`); setCopied(id); setTimeout(() => setCopied(null), 2000); }
  async function patchRec(id, patch, local = patch) {
    const r = await client.patchMeta(byId(id), patch);
    if (r.error) { toast.error(r.error); return false; }
    setRecordings((rs) => rs.map((x) => (x.id === id ? { ...x, ...local } : x)));
    return true;
  }
  const moveToFolder = (id, folderId) => patchRec(id, { folder: folderId });
  const setArchived = (id, archived) => patchRec(id, { archived });
  const setAnimated = (id, animatedThumbnail) => patchRec(id, { animatedThumbnail });

  const archivedCount = recordings.filter((r) => r.archived).length;
  const filtered = recordings
    .filter((r) => (showArchived ? r.archived : !r.archived))
    .filter((r) => !search || (r.title || '').toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (sort === 'oldest' ? a.created_at - b.created_at : sort === 'views' ? (b.views || 0) - (a.views || 0) : b.created_at - a.created_at));

  return (
    <AppShell active="library" search={search} onSearch={setSearch}>
      <div className={styles.pageHead}>
        <div className={styles.titleRow}>
          <h1 className={styles.pageTitle}>{showArchived ? 'Archived' : 'Library'}</h1>
          <span className={styles.count}>{filtered.length} video{filtered.length === 1 ? '' : 's'}</span>
        </div>
        <div className={styles.toolbar}>
          {(archivedCount > 0 || showArchived) && (
            <button
              className={showArchived ? styles.archiveToggleActive : styles.archiveToggle}
              onClick={() => setShowArchived((v) => !v)}
              title={showArchived ? 'Back to your library' : 'View archived videos'}
            >
              {showArchived ? <><ArchiveRestore size={15} /> Library</> : <><Archive size={15} /> Archived{archivedCount ? ` (${archivedCount})` : ''}</>}
            </button>
          )}
          <select className={styles.sort} value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="views">Most viewed</option>
          </select>
          <div className={styles.viewToggle}>
            <button className={view === 'grid' ? styles.viewActive : styles.viewBtn} onClick={() => setView('grid')}><LayoutGrid size={16} /></button>
            <button className={view === 'list' ? styles.viewActive : styles.viewBtn} onClick={() => setView('list')}><List size={16} /></button>
          </div>
        </div>
      </div>

      {loading && (
        <div className={styles.grid}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className={styles.card}><div className={`${styles.thumb} ${styles.skel}`} /><div className={styles.cardBody}><div className={styles.skelLine} style={{ width: '70%' }} /><div className={styles.skelLine} style={{ width: '45%', height: 10 }} /></div></div>
          ))}
        </div>
      )}

      {!loading && recordings.length === 0 && (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}><Film size={30} color="#5b5bf6" /></div>
          <h2>No recordings yet</h2>
          <p>Click <strong>Record Video</strong> and the VeoRec extension captures your screen. Your videos show up here.</p>
        </div>
      )}
      {!loading && recordings.length > 0 && filtered.length === 0 && (
        <p className={styles.noMatch}>
          {search ? `No recordings match “${search}”.` : showArchived ? 'No archived videos.' : 'No videos here yet.'}
        </p>
      )}

      <div className={view === 'grid' ? styles.grid : styles.list}>
        {filtered.map((r) => (
          <Card
            key={r.id} r={r} view={view} folders={folders}
            copied={copied === r.id} editing={editingId === r.id} editTitle={editTitle}
            onCopy={() => copyLink(r.id)}
            onShare={() => setSettingsRec(r)}
            onStats={() => setAnalyticsRec(r)}
            onRename={() => { setEditingId(r.id); setEditTitle(r.title); }}
            onRenameChange={setEditTitle}
            onRenameSave={() => saveTitle(r.id)}
            onRenameCancel={() => setEditingId(null)}
            onMove={(fid) => moveToFolder(r.id, fid)}
            onDelete={() => deleteRec(r.id)}
            onDuplicate={() => duplicateRec(r.id)}
            onArchive={() => setArchived(r.id, !r.archived)}
          />
        ))}
      </div>

      {confirmState && <Confirm state={confirmState} onClose={() => setConfirmState(null)} />}
      {settingsRec && (
        <ShareSettings rec={settingsRec} folders={folders} client={client}
          onClose={() => setSettingsRec(null)}
          onUpgrade={(feature, reason) => { setSettingsRec(null); setUpgrade({ feature, reason }); }}
          onAnimated={setAnimated}
          onSaved={(patch) => { setRecordings((rs) => rs.map((x) => (x.id === settingsRec.id ? { ...x, ...patch } : x))); setSettingsRec(null); }} />
      )}
      {analyticsRec && (
        <Analytics rec={analyticsRec} authFetch={authFetch}
          onUpgrade={(feature, reason) => { setAnalyticsRec(null); setUpgrade({ feature, reason }); }}
          onClose={() => setAnalyticsRec(null)} />
      )}
      <UpgradeModal open={!!upgrade} feature={upgrade?.feature || 'default'} reason={upgrade?.reason} onClose={() => setUpgrade(null)} />
    </AppShell>
  );
}

/* ── Video card (grid + list) ─────────────────────────────────────────────── */
function Card({ r, view, folders, copied, editing, editTitle, onCopy, onShare, onStats, onRename, onRenameChange, onRenameSave, onRenameCancel, onMove, onDelete, onDuplicate, onArchive }) {
  const [menu, setMenu] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [pos, setPos] = useState(null);   // fixed-position coords for the portal menu
  const btnRef = useRef(null);

  // Open into a body-level portal so the card's overflow:hidden can't clip us,
  // and flip up/down depending on which side has room (fixes "cut from the top").
  function openMenu() {
    if (menu) { setMenu(false); setMoveOpen(false); return; }
    const b = btnRef.current?.getBoundingClientRect() || { bottom: 0, top: 0, right: 0 };
    const WIDTH = 232, EST_H = 360;
    const right = Math.max(10, window.innerWidth - b.right);
    const spaceBelow = window.innerHeight - b.bottom;
    const p = { width: WIDTH, right, left: 'auto' };
    if (spaceBelow >= EST_H || spaceBelow >= b.top) { p.top = Math.round(b.bottom + 6); p.bottom = 'auto'; }
    else { p.bottom = Math.round(window.innerHeight - b.top + 6); p.top = 'auto'; }
    setPos(p);
    setMenu(true);
  }
  function close() { setMenu(false); setMoveOpen(false); }

  const menuEl = (
    <div className={styles.cardMenuWrap}>
      <button ref={btnRef} className={styles.menuBtn} onClick={openMenu}><MoreHorizontal size={18} /></button>
      {menu && createPortal(
        <>
          <div className={styles.menuBackdrop} onClick={close} />
          <div className={styles.menu} style={{ position: 'fixed', ...pos }}>
            <button className={styles.menuItem} onClick={() => { close(); onCopy(); }}>{copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied!' : 'Copy link'}</button>
            <button className={styles.menuItem} onClick={() => { close(); onShare(); }}><Share2 size={15} /> Share settings</button>
            <button className={styles.menuItem} onClick={() => { close(); onStats(); }}><BarChart2 size={15} /> Analytics</button>
            <Link className={styles.menuItem} to={`/edit/${r.id}`}><Scissors size={15} /> Edit / trim</Link>
            <button className={styles.menuItem} onClick={() => { close(); onRename(); }}><Pencil size={15} /> Rename</button>
            <div className={styles.menuSub}>
              <button className={styles.menuItem} onClick={() => setMoveOpen((o) => !o)}><FolderInput size={15} /> Move to folder</button>
              {moveOpen && (
                <div className={styles.subMenu}>
                  <button className={styles.menuItem} onClick={() => { close(); onMove(null); }}>No folder</button>
                  {folders.map((f) => <button key={f.id} className={styles.menuItem} onClick={() => { close(); onMove(f.id); }}>{f.name}</button>)}
                  {!folders.length && <span className={styles.menuEmpty}>No folders yet</span>}
                </div>
              )}
            </div>
            <div className={styles.menuDivider} />
            <button className={styles.menuItem} onClick={() => { close(); onDuplicate(); }}><CopyPlus size={15} /> Duplicate</button>
            <button className={styles.menuItem} onClick={() => { close(); onArchive(); }}>
              {r.archived ? <><ArchiveRestore size={15} /> Unarchive</> : <><Archive size={15} /> Archive</>}
            </button>
            <button className={`${styles.menuItem} ${styles.menuDanger}`} onClick={() => { close(); onDelete(); }}><Trash2 size={15} /> Delete</button>
          </div>
        </>,
        document.body
      )}
    </div>
  );

  const titleEl = editing ? (
    <div className={styles.editRow}>
      <input value={editTitle} onChange={(e) => onRenameChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onRenameSave()} autoFocus />
      <button className={styles.miniPrimary} onClick={onRenameSave}>Save</button>
      <button className={styles.miniGhost} onClick={onRenameCancel}>×</button>
    </div>
  ) : (
    <h3 className={styles.title} onClick={onRename} title="Click to rename">{r.title}</h3>
  );

  if (view === 'list') {
    return (
      <div className={styles.listRow}>
        <Thumb r={r} small />
        <div className={styles.listMain}>{titleEl}<p className={styles.meta}><UsersIcon size={13} /> {r.views || 0} views · {timeAgo(r.created_at)}</p></div>
        {menuEl}
      </div>
    );
  }
  return (
    <div className={styles.card}>
      <Thumb r={r} />
      <div className={styles.cardBody}>
        {titleEl}
        <div className={styles.cardFoot}>
          <p className={styles.meta}><UsersIcon size={13} /> {r.views || 0} views · {timeAgo(r.created_at)}</p>
          {menuEl}
        </div>
      </div>
    </div>
  );
}

function Thumb({ r, small }) {
  const [hover, setHover] = useState(false);
  // Legacy rows keep the legacy hover rule (the full file, muted, looping).
  // A v1 row shows the pipeline's animated WebP preview when there is one —
  // never the full video, never a Cloudinary URL.
  const isV1 = r.source === 'v1';
  const legacySrc = !isV1 && r.filename ? (r.cloudinary ? r.filename : `${API}/uploads/${r.filename}`) : null;
  const showPreview = hover && !small && r.animatedThumbnail !== false;
  return (
    <Link to={`/watch/${r.id}`} className={small ? styles.thumbSmall : styles.thumb} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} data-source={r.source || 'legacy'}>
      {r.thumbnail ? <img src={r.thumbnail} className={styles.preview} alt={r.title} loading="lazy" /> : <div className={styles.preview} style={{ background: '#1a1a2e' }} />}
      {showPreview && isV1 && r.previewUrl && (
        <img className={styles.previewVid} src={r.previewUrl} alt="" />
      )}
      {showPreview && !isV1 && legacySrc && (
        <video className={styles.previewVid} src={legacySrc} muted autoPlay loop playsInline
          onLoadedMetadata={(e) => { const v = e.target; if (v.duration === Infinity || isNaN(v.duration)) { v.currentTime = 1e101; v.ontimeupdate = () => { v.ontimeupdate = null; v.currentTime = 0; v.play(); }; } }} />
      )}
      {isV1 && r.status && r.status !== 'ready' && (
        <span className={styles.duration} style={{ left: 8, right: 'auto', background: r.status === 'failed' || r.status === 'rejected_limit' ? '#b91c1c' : '#5b5bf6' }} data-status={r.status}>
          {r.status === 'failed' || r.status === 'rejected_limit' ? 'Failed' : 'Processing…'}
        </span>
      )}
      <div className={styles.duration}>{fmtDur(r.duration)}</div>
      {r.privacy && r.privacy !== 'public' && <div className={styles.lock}>{r.privacy === 'password' ? <Lock size={12} /> : <UsersIcon size={12} />}</div>}
      {!hover && !small && <span className={styles.playOverlay}><Play size={20} fill="#fff" /></span>}
    </Link>
  );
}

function Confirm({ state, onClose }) {
  return (
    <div className={styles.modalBg} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
        <h2 className={styles.modalTitle}>{state.title}</h2>
        <p className={styles.modalText}>{state.message}</p>
        <div className={styles.modalActions}>
          <button className={styles.ghostBtn} onClick={onClose}>Cancel</button>
          <button className={state.danger ? styles.dangerBtn : styles.primaryBtn} onClick={async () => { const fn = state.onConfirm; onClose(); if (fn) await fn(); }}>{state.confirmLabel || 'Confirm'}</button>
        </div>
      </div>
    </div>
  );
}

/* ── Share settings modal (unchanged behaviour) ───────────────────────────── */
function ShareSettings({ rec, folders, client, onClose, onSaved, onUpgrade, onAnimated }) {
  const [title, setTitle] = useState(rec.title || '');
  const [animated, setAnimated] = useState(rec.animatedThumbnail !== false);
  function toggleAnimated() {
    const next = !animated;
    setAnimated(next);            // instant visual
    onAnimated?.(rec.id, next);   // PATCH + sync the library list immediately
  }
  const [privacy, setPrivacy] = useState(rec.privacy || 'public');
  const [password, setPassword] = useState('');
  const [description, setDescription] = useState(rec.description || '');
  const [ctaLabel, setCtaLabel] = useState(rec.cta?.label || '');
  const [ctaUrl, setCtaUrl] = useState(rec.cta?.url || '');
  const [folder, setFolder] = useState(rec.folder || '');
  const [trimStart, setTrimStart] = useState(rec.trimStart ?? '');
  const [trimEnd, setTrimEnd] = useState(rec.trimEnd ?? '');
  const [saving, setSaving] = useState(false);
  const embed = `<iframe src="${CLIENT_BASE}/embed/${rec.id}" width="640" height="360" frameborder="0" allowfullscreen></iframe>`;
  const [copiedEmbed, setCopiedEmbed] = useState(false);

  async function save() {
    setSaving(true);
    const body = {
      title: title.trim() || undefined, privacy, description, folder: folder || null,
      cta: ctaUrl ? { label: ctaLabel || 'Learn more', url: ctaUrl } : null,
      trimStart: trimStart === '' ? null : Number(trimStart), trimEnd: trimEnd === '' ? null : Number(trimEnd),
    };
    if (privacy === 'password' && password) body.password = password;
    // The write follows the recording's source (v1 → /api/v1, legacy → /api).
    // v1 answers the nested error contract: a Pro gate is `feature_locked`.
    const r = await client.patchMeta(rec, body);
    setSaving(false);
    if (r.meta) {
      const d = r.meta;
      onSaved({ title: title.trim() || rec.title, privacy: d.privacy, description: d.description, cta: d.cta, folder: d.folder ?? d.folder_id ?? null, trimStart: d.trimStart, trimEnd: d.trimEnd });
    } else if (r.code === 'feature_locked' || /upgrade/i.test(r.error || '')) {
      if (onUpgrade) onUpgrade('default', r.error);
    }
  }

  return (
    <div className={styles.modalBg} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.modalTitle}>Video settings</h2>
        <label className={styles.fieldLabel}>Title</label>
        <input className={styles.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Video title" />
        <label className={styles.fieldLabel}>Trim (seconds) — viewers only see this range</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className={styles.input} type="number" min="0" value={trimStart} onChange={(e) => setTrimStart(e.target.value)} placeholder="Start (e.g. 3)" />
          <input className={styles.input} type="number" min="0" value={trimEnd} onChange={(e) => setTrimEnd(e.target.value)} placeholder={`End (e.g. ${rec.duration || 60})`} />
        </div>
        <label className={styles.fieldLabel}>Privacy</label>
        <select className={styles.select} value={privacy} onChange={(e) => setPrivacy(e.target.value)}>
          <option value="public">Anyone with the link</option>
          <option value="login">Signed-in users only</option>
          <option value="password">Password protected</option>
        </select>
        {privacy === 'password' && <input className={styles.input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Set a password" />}
        <label className={styles.fieldLabel}>Description</label>
        <textarea className={styles.input} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Add a description…" />
        <label className={styles.fieldLabel}>Call-to-action button (optional)</label>
        <input className={styles.input} value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)} placeholder="Button text (e.g. Book a call)" />
        <input className={styles.input} value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} placeholder="https://…" />
        <label className={styles.fieldLabel}>Folder</label>
        <select className={styles.select} value={folder} onChange={(e) => setFolder(e.target.value)}>
          <option value="">No folder</option>
          {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <label className={styles.fieldLabel}>Animated thumbnail</label>
        <button type="button" className={styles.switchRow} onClick={toggleAnimated}>
          <span className={styles.switchText}>Play a short looping preview on hover and when shared</span>
          <span className={`${styles.switch} ${animated ? styles.switchOn : ''}`}><span className={styles.knob} /></span>
        </button>
        <label className={styles.fieldLabel}>Embed code</label>
        <code className={styles.embedCode}>{embed}</code>
        <button className={styles.ghostBtn} style={{ fontSize: 12, marginBottom: 8 }} onClick={() => { navigator.clipboard.writeText(embed); setCopiedEmbed(true); setTimeout(() => setCopiedEmbed(false), 2000); }}>{copiedEmbed ? '✓ Copied!' : 'Copy embed code'}</button>
        <div className={styles.modalActions}>
          <button className={styles.ghostBtn} onClick={onClose}>Cancel</button>
          <button className={styles.primaryBtn} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

function Analytics({ rec, authFetch, onClose, onUpgrade }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    // The per-recording analytics endpoint is legacy-only until Phase 10; a
    // v1 recording shows what its summary already carries.
    if (rec.source === 'v1') { setData({ views: rec.views || 0, comments: [], reactions: [], viewers: [], v1: true }); return; }
    authFetch(`${API}/api/recordings/${rec.id}/analytics`)
      .then(async (r) => { if (r.status === 403) { const d = await r.json().catch(() => ({})); if (d.upgradeRequired && onUpgrade) onUpgrade(d.feature || 'analytics', d.error); return null; } return r.json(); })
      .then((d) => { if (d) setData(d); }).catch(() => setData({}));
  }, [rec.id]);
  return (
    <div className={styles.modalBg} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.modalTitle}>{rec.title}</h2>
        {!data ? <p className={styles.noMatch}>Loading…</p> : (
          <>
            <div className={styles.statRow}>
              <div className={styles.stat}><div className={styles.statNum}>{data.views || 0}</div><div className={styles.statLbl}>Views</div></div>
              <div className={styles.stat}><div className={styles.statNum}>{(data.comments || []).length}</div><div className={styles.statLbl}>Comments</div></div>
              <div className={styles.stat}><div className={styles.statNum}>{(data.reactions || []).length}</div><div className={styles.statLbl}>Reactions</div></div>
            </div>
            <label className={styles.fieldLabel}>Recent viewers</label>
            {(data.viewers || []).length === 0 ? <p className={styles.dim}>No signed-in viewers yet.</p> : (
              <ul className={styles.viewerList}>{data.viewers.slice(0, 20).map((v, i) => <li key={i}>{v.name} <span className={styles.dim}>· {new Date(v.at).toLocaleDateString()}</span></li>)}</ul>
            )}
            <label className={styles.fieldLabel}>Comments</label>
            {(data.comments || []).length === 0 ? <p className={styles.dim}>No comments yet.</p> : (
              <ul className={styles.viewerList}>{data.comments.slice().reverse().slice(0, 20).map((c) => <li key={c.id}><strong>{c.name}:</strong> {c.text}</li>)}</ul>
            )}
          </>
        )}
        <div className={styles.modalActions}><button className={styles.primaryBtn} onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
