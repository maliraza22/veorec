import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  PlaySquare, Folder, BarChart3, Search, Plus, ChevronDown,
  User, HelpCircle, LogOut, CreditCard, Sparkles, Video, Upload, Loader2,
} from 'lucide-react';
import { useAuth } from '../AuthContext';
import { useBilling } from '../hooks/useBilling';
import { DualMeters } from './StorageMeter';
import NotificationsBell from './NotificationsBell';
import API from '../api';
import s from './AppShell.module.css';

// Shared app chrome: sidebar (Library / Folders / Analytics + storage + upgrade)
// and the top header (search, Record Video dropdown, avatar menu). Used by the
// Library, Folders and Analytics pages so the navigation stays consistent.
export default function AppShell({ active = 'library', search, onSearch, headerRight, children }) {
  const { user, logout, token } = useAuth();
  const { usage, isPaid, plan } = useBilling();
  const navigate = useNavigate();
  const [recordOpen, setRecordOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [uploadErr, setUploadErr] = useState('');
  const recordRef = useRef(null);
  const menuRef = useRef(null);
  const fileRef = useRef(null);

  // Chrome Web Store listing for the VeoRec recorder extension.
  const EXT_STORE_URL = 'https://chromewebstore.google.com/detail/veorec-%E2%80%94-screen-recorder/alhloekclmpekfklpdnddbikgiddjnkh';
  // bridge.js (the extension's content script) stamps this on <html> when installed.
  function extInstalled() { return typeof document !== 'undefined' && !!document.documentElement.getAttribute('data-veorec-ext'); }

  function onRecord() {
    setRecordOpen(false);
    if (extInstalled()) {
      window.postMessage({ source: 'veorec-web', type: 'START_RECORDING' }, '*');
      setStarting(true);
      setTimeout(() => setStarting(false), 4000);
    } else {
      setInstallOpen(true);
    }
  }

  function pickUpload() { setRecordOpen(false); setUploadErr(''); fileRef.current?.click(); }
  async function onFileChosen(e) {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    // Read duration client-side so the server can validate against the plan.
    let duration = 0;
    try {
      duration = await new Promise((resolve) => {
        const v = document.createElement('video'); v.preload = 'metadata';
        v.onloadedmetadata = () => { resolve(Math.round(isFinite(v.duration) ? v.duration : 0)); try { URL.revokeObjectURL(v.src); } catch {} };
        v.onerror = () => resolve(0);
        v.src = URL.createObjectURL(file);
      });
    } catch {}
    setUploading(true); setUploadPct(0); setUploadErr('');
    const form = new FormData();
    form.append('video', file, file.name);
    form.append('title', (file.name.replace(/\.[^.]+$/, '') || 'Uploaded video').slice(0, 100));
    form.append('duration', String(duration));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API}/api/upload`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) setUploadPct(Math.round((ev.loaded / ev.total) * 100)); };
    xhr.onload = () => {
      let d = {}; try { d = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && d.id) { setUploading(false); navigate(`/watch/${d.id}`); }
      else { setUploadErr(d.error || (xhr.status === 403 ? 'This exceeds your plan limit.' : 'Upload failed.')); setUploadPct(100); }
    };
    xhr.onerror = () => { setUploadErr('Network error during upload.'); };
    xhr.send(form);
  }

  useEffect(() => {
    function onDoc(e) {
      if (recordRef.current && !recordRef.current.contains(e.target)) setRecordOpen(false);
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Focus search on Cmd/Ctrl+K
  const searchRef = useRef(null);
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchRef.current?.focus(); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const NAV = [
    { id: 'library', label: 'Library', Icon: PlaySquare, to: '/' },
    { id: 'folders', label: 'Folders', Icon: Folder, to: '/folders' },
    { id: 'analytics', label: 'Analytics', Icon: BarChart3, to: '/analytics' },
  ];

  return (
    <div className={s.shell}>
      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      <aside className={s.sidebar}>
        <Link to="/" className={s.brand}><img src="/logo.png" className={s.brandImg} alt="" />VeoRec</Link>

        <nav className={s.nav}>
          {NAV.map((n) => (
            <Link key={n.id} to={n.to} className={active === n.id ? s.navActive : s.navItem}>
              <n.Icon size={18} /> {n.label}
            </Link>
          ))}
        </nav>

        <div className={s.sidebarFoot}>
          {/* T-307: BOTH meters, always (docs/16 §4.6) — either limit alone can
              block the next recording, so neither is ever hidden behind the other. */}
          {usage && (
            <div className={s.storageBox} data-testid="sidebar-quota">
              <DualMeters usage={usage} isPaid={isPaid} showUpgradeHint={false} />
            </div>
          )}
          <Link to="/billing" className={s.navItem}><CreditCard size={18} /> Billing &amp; plan</Link>
          {!isPaid && (
            <div className={s.upgradeCard}>
              <div className={s.upgradeHead}><Sparkles size={16} color="#5b5bf6" /> Upgrade to Pro</div>
              <p>Unlock unlimited recordings and advanced features.</p>
              <Link to="/pricing" className={s.upgradeBtn}>Upgrade to Pro</Link>
            </div>
          )}
        </div>
      </aside>

      {/* ── Main ────────────────────────────────────────────────────────────── */}
      <div className={s.main}>
        <header className={s.header}>
          <div className={s.searchWrap}>
            <Search size={17} className={s.searchIcon} />
            <input
              ref={searchRef}
              className={s.search}
              value={search ?? ''}
              onChange={(e) => onSearch?.(e.target.value)}
              placeholder="Search recordings…"
              disabled={!onSearch}
            />
            <span className={s.kbd}>⌘K</span>
          </div>

          <div className={s.headerRight}>
            {headerRight}
            <NotificationsBell />
            <div className={s.recordWrap} ref={recordRef}>
              <button className={s.recordBtn} onClick={onRecord}>
                <Plus size={17} /> Record Video
              </button>
              <button className={s.recordChevron} onClick={() => setRecordOpen((o) => !o)}><ChevronDown size={16} /></button>
              {recordOpen && (
                <div className={s.dropdown} style={{ right: 0, minWidth: 220 }}>
                  <button className={s.dropItem} onClick={pickUpload}><Upload size={16} /> Upload a video</button>
                </div>
              )}
              <input ref={fileRef} type="file" accept="video/*" style={{ display: 'none' }} onChange={onFileChosen} />
            </div>

            <div className={s.avatarWrap} ref={menuRef}>
              <button className={s.avatarBtn} onClick={() => setMenuOpen((o) => !o)}>
                <span className={s.avatar}>{(user?.name || '?').charAt(0).toUpperCase()}</span>
                <ChevronDown size={15} color="#9090a0" />
              </button>
              {menuOpen && (
                <div className={s.dropdown} style={{ right: 0, minWidth: 200 }}>
                  <div className={s.dropUser}><strong>{user?.name}</strong><small>{user?.email}</small></div>
                  <Link className={s.dropItem} to="/account"><User size={16} /> My account</Link>
                  <Link className={s.dropItem} to="/contact"><HelpCircle size={16} /> Help &amp; support</Link>
                  {user?.isAdmin && <Link className={s.dropItem} to="/admin"><BarChart3 size={16} /> Admin panel</Link>}
                  <div className={s.dropDivider} />
                  <button className={`${s.dropItem} ${s.dropDanger}`} onClick={logout}><LogOut size={16} /> Log out</button>
                </div>
              )}
            </div>
          </div>
        </header>

        <div className={s.content}>{children}</div>
      </div>

      {/* Extension not detected → prompt to install */}
      {installOpen && (
        <div className={s.modalBg} onClick={() => setInstallOpen(false)}>
          <div className={s.modal} onClick={(e) => e.stopPropagation()} style={{ textAlign: 'center' }}>
            <div className={s.modalIcon}><Video size={26} color="#5b5bf6" /></div>
            <h2 className={s.modalTitle}>Add the VeoRec recorder</h2>
            <p className={s.modalText}>
              To record your screen, add the free <strong>VeoRec</strong> extension to Chrome.
              It takes a few seconds — then come back and hit Record.
            </p>
            <a className={s.primaryBtn} href={EXT_STORE_URL} target="_blank" rel="noopener noreferrer"
              onClick={() => setInstallOpen(false)} style={{ display: 'inline-block', textDecoration: 'none' }}>
              Add to Chrome — it’s free
            </a>
            <button className={s.linkBtn} style={{ marginTop: 12, background: 'none', border: 'none', color: '#6b6b80', cursor: 'pointer', fontSize: 13 }}
              onClick={() => { if (extInstalled()) { setInstallOpen(false); onRecord(); } else { window.location.reload(); } }}>
              Already installed it? Reload
            </button>
          </div>
        </div>
      )}

      {/* Recording is being launched in the extension */}
      {starting && (
        <div className={s.modalBg} onClick={() => setStarting(false)}>
          <div className={s.modal} onClick={(e) => e.stopPropagation()} style={{ textAlign: 'center' }}>
            <div className={s.modalIcon}><Video size={26} color="#5b5bf6" /></div>
            <h2 className={s.modalTitle}>Starting VeoRec…</h2>
            <p className={s.modalText}>
              Choose the screen, window or tab to share in the popup. Your video appears here automatically when you finish.
            </p>
            <button className={s.primaryBtn} onClick={() => setStarting(false)}>Got it</button>
          </div>
        </div>
      )}

      {/* Upload progress modal */}
      {uploading && (
        <div className={s.modalBg}>
          <div className={s.modal} style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
            <div className={s.modalIcon}>
              {uploadErr ? <Upload size={26} color="#ef4444" /> : <Loader2 size={26} color="#5b5bf6" className={s.spin} />}
            </div>
            <h2 className={s.modalTitle}>{uploadErr ? 'Upload failed' : 'Uploading your video…'}</h2>
            {uploadErr ? (
              <p className={s.modalText}>{uploadErr}</p>
            ) : (
              <>
                <div style={{ height: 8, background: '#ececf5', borderRadius: 999, overflow: 'hidden', margin: '8px 0 10px' }}>
                  <div style={{ height: '100%', width: `${uploadPct}%`, background: '#5b5bf6', borderRadius: 999, transition: 'width .2s' }} />
                </div>
                <p className={s.modalText}>{uploadPct}% — keep this tab open.</p>
              </>
            )}
            {uploadErr && <button className={s.primaryBtn} onClick={() => { setUploading(false); setUploadErr(''); }}>Close</button>}
          </div>
        </div>
      )}
    </div>
  );
}
