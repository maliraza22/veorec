import React, { useEffect, useState } from 'react';
import { Link2, Copy, Check, Trash2, Loader2, Lock, Plus } from 'lucide-react';
import API from '../../api';
import { useToast } from '../../components/Toast';
import styles from '../Watch.module.css';

// T-901 (docs/12 §3, docs/08 §8): managed share links for a v1 recording —
// per-link password, expiry, view cap, revocation, labels. The token is shown
// ONCE (at creation) and copied from this panel; the list never re-shows it.
// v1 recordings only: the legacy API has no managed links.
function authHeaders() { const t = localStorage.getItem('sr_token'); return t ? { Authorization: `Bearer ${t}` } : {}; }
const fmtDate = (v) => (v ? new Date(v).toLocaleDateString() : null);

export default function ShareLinks({ recordingId, canPassword = false, onUpgrade }) {
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [expires, setExpires] = useState('');
  const [maxViews, setMaxViews] = useState('');
  const [fresh, setFresh] = useState(null);      // the one response that carries the token
  const [copied, setCopied] = useState(false);
  const base = `${API}/api/v1/recordings/${encodeURIComponent(recordingId)}/share-links`;

  async function load() {
    try {
      const r = await fetch(base, { headers: authHeaders() });
      const d = await r.json().catch(() => ({}));
      if (r.ok) setItems(d.items || []); else setItems([]);
    } catch { setItems([]); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [recordingId]);

  async function create(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { label: label.trim() || undefined };
      if (password) body.password = password;
      if (expires) body.expiresAt = new Date(expires).toISOString();
      if (maxViews) body.maxViews = Number(maxViews);
      const r = await fetch(base, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const code = d.error && d.error.code;
        if (code === 'feature_locked' && onUpgrade) onUpgrade('passwordProtection', d.error.message);
        toast.error((d.error && d.error.message) || 'Could not create the link.');
        return;
      }
      setFresh(d); setItems((xs) => [d, ...(xs || [])]);
      setCreating(false); setLabel(''); setPassword(''); setExpires(''); setMaxViews('');
    } catch { toast.error('Network error — please try again.'); }
    finally { setBusy(false); }
  }
  async function revoke(id) {
    const r = await fetch(`${API}/api/v1/share-links/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() });
    if (!r.ok) { toast.error('Could not revoke the link.'); return; }
    setItems((xs) => xs.map((l) => (l.id === id ? { ...l, revokedAt: new Date().toISOString() } : l)));
    if (fresh && fresh.id === id) setFresh(null);
  }
  function copyFresh() { navigator.clipboard.writeText(fresh.url); setCopied(true); setTimeout(() => setCopied(false), 2000); }

  return (
    <div data-panel="share-links">
      <div className={styles.panelLabel} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Share links</span>
        <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setCreating((c) => !c)}><Plus size={13} /> New link</button>
      </div>
      {fresh && (
        <div className={styles.ctaForm} data-fresh-link>
          <p className={styles.blockEmpty} style={{ marginBottom: 6 }}>Copy it now — this link is shown only once.</p>
          <code className={styles.embedCode} style={{ wordBreak: 'break-all' }}>{fresh.url}</code>
          <div className={styles.ctaFormActions}>
            <button className="btn-primary" style={{ fontSize: 13 }} onClick={copyFresh}>{copied ? <><Check size={14} /> Copied!</> : <><Copy size={14} /> Copy link</>}</button>
          </div>
        </div>
      )}
      {creating && (
        <form className={styles.ctaForm} onSubmit={create} data-create-link>
          <input className={styles.ctaInput} placeholder="Label (e.g. sent to client X)" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
          <input className={styles.ctaInput} type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} title="Expires" />
          <input className={styles.ctaInput} type="number" min="1" placeholder="Max views (optional)" value={maxViews} onChange={(e) => setMaxViews(e.target.value)} />
          <input className={styles.ctaInput} type="password" placeholder={canPassword ? 'Link password (optional)' : 'Link password (Pro)'} value={password} onChange={(e) => setPassword(e.target.value)} disabled={!canPassword && !onUpgrade} />
          <div className={styles.ctaFormActions}>
            <button type="button" className={styles.ctaRemove} onClick={() => setCreating(false)}>Cancel</button>
            <button className="btn-primary" style={{ fontSize: 13 }} type="submit" disabled={busy}>{busy ? <Loader2 size={14} className={styles.spin} /> : 'Create link'}</button>
          </div>
        </form>
      )}
      {items === null ? <p className={styles.blockEmpty}>Loading…</p> : items.length === 0 ? (
        <p className={styles.blockEmpty}>No managed links yet. The plain watch URL follows the video's privacy setting.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map((l) => (
            <div key={l.id} className={styles.audRow} data-link-id={l.id} data-revoked={!!l.revokedAt} style={{ opacity: l.revokedAt ? 0.55 : 1 }}>
              <div className={styles.audText}>
                <strong style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Link2 size={13} /> {l.label || 'Untitled link'} {l.hasPassword && <Lock size={12} title="Password-protected" />}</strong>
                <span>
                  {l.revokedAt ? 'Revoked' : [
                    `${l.viewCount || 0}${l.maxViews ? ` / ${l.maxViews}` : ''} views`,
                    l.expiresAt ? `expires ${fmtDate(l.expiresAt)}` : null,
                  ].filter(Boolean).join(' · ')}
                </span>
              </div>
              {!l.revokedAt && <button className={styles.ctaRemove} title="Revoke" onClick={() => revoke(l.id)}><Trash2 size={14} /></button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
