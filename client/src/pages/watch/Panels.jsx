import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, RefreshCw, Lock, Mail, AlertTriangle } from 'lucide-react';
import styles from '../Watch.module.css';

// T-802 (docs/11 §1, §4): the explicit page states. Each panel is driven by
// the API payload the parent holds — none of them owns a timer.

const overlay = {
  position: 'absolute', inset: 0, zIndex: 8, borderRadius: 12, display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center', gap: 12, background: 'rgba(15,15,25,0.95)', padding: 24, textAlign: 'center',
};
const input = { padding: '10px 12px', borderRadius: 9, border: '1px solid #3a3a4c', background: '#1a1a28', color: '#fff', fontSize: 14 };

/** Human copy for the pipeline (docs/18 taxonomy → viewer/owner wording). */
export function failureCopy(code) {
  switch (code) {
    case 'probe_invalid': return 'The uploaded file could not be read as a video.';
    case 'transcode_failed': return 'Converting this video failed.';
    case 'recording_limit': return 'This recording is longer than the plan allows.';
    case 'storage_limit': return 'Your storage limit was reached while saving this recording.';
    case 'upload_expired': return 'The upload did not finish in time.';
    default: return code ? `Processing failed (${code}).` : 'Processing failed.';
  }
}

/** docs/11 §1: "Processing your video… (transcoding 64%)" from the real pipeline. */
export function progressLabel(rec, jobs) {
  if (!rec) return 'Preparing…';
  if (rec.status === 'recording' || rec.status === 'uploading') return 'Uploading…';
  const active = Array.isArray(jobs) ? jobs.find((j) => j.status === 'active' && typeof j.progress === 'number') : null;
  if (active) return `Processing your video… (${active.queue} ${Math.round(active.progress)}%)`;
  return 'Processing your video…';
}

export function ProcessingPanel({ rec, jobs, posterUrl }) {
  return (
    <div className={styles.processingPanel} style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', background: '#0f0f19', minHeight: 320, display: 'flex', alignItems: 'center', justifyContent: 'center' }} data-state="processing">
      {posterUrl && <img src={posterUrl} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: .35 }} />}
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: 24, textAlign: 'center' }}>
        <Loader2 size={40} className={styles.spin} style={{ color: '#fff' }} />
        <strong style={{ color: '#fff', fontSize: 15 }}>{progressLabel(rec, jobs)}</strong>
        <span style={{ color: '#c7c7d6', fontSize: 13, maxWidth: 340 }}>This page updates itself — the video starts as soon as it is ready.</span>
      </div>
    </div>
  );
}

export function FailedPanel({ rec, isOwner, onRetry, retrying }) {
  return (
    <div style={{ borderRadius: 12, background: '#0f0f19', minHeight: 320, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, textAlign: 'center' }} data-state="failed">
      <AlertTriangle size={36} style={{ color: '#f59e0b' }} />
      {isOwner ? (
        <>
          <strong style={{ color: '#fff', fontSize: 16 }}>{failureCopy(rec.failureCode)}</strong>
          <span style={{ color: '#c7c7d6', fontSize: 13, maxWidth: 380 }}>{rec.status === 'rejected_limit' ? 'Upgrade your plan or shorten the recording, then try again.' : 'You can run processing again from the original upload.'}</span>
          <button className="btn-primary" onClick={onRetry} disabled={retrying} style={{ marginTop: 6 }}>
            {retrying ? <><Loader2 size={15} className={styles.spin} /> Retrying…</> : <><RefreshCw size={15} /> Retry processing</>}
          </button>
        </>
      ) : (
        <>
          <strong style={{ color: '#fff', fontSize: 16 }}>This video isn't available yet.</strong>
          <span style={{ color: '#c7c7d6', fontSize: 13 }}>The owner has been notified.</span>
        </>
      )}
    </div>
  );
}

export function NotFoundPanel() {
  return (
    <div className={styles.center} data-state="not_found">
      <h2>Recording not found</h2>
      <Link to="/" className="btn-primary" style={{ marginTop: 16, display: 'inline-block' }}>← Dashboard</Link>
    </div>
  );
}

export function LoadingPanel() {
  return (
    <div className={styles.center} data-state="loading">
      <Loader2 size={34} className={styles.spin} style={{ color: '#5b5bf6' }} />
      <p style={{ marginTop: 14, color: '#9090a0' }}>Preparing your video…</p>
    </div>
  );
}

export function LoginGate({ title }) {
  return (
    <div className={styles.center} data-state="login_gate">
      <h2><Lock size={22} style={{ verticalAlign: -3 }} /> Sign in to watch</h2>
      <p style={{ color: '#9090a0', margin: '10px 0 20px' }}>{title ? `“${title}” is` : 'This video is'} restricted to signed-in users.</p>
      <Link to={`/login?next=${encodeURIComponent(typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/')}`} className="btn-primary">Sign in</Link>
    </div>
  );
}

export function LinkExpiredPanel() {
  return (
    <div className={styles.center} data-state="link_expired">
      <h2>This link is no longer valid</h2>
      <p style={{ color: '#9090a0', margin: '10px 0 20px' }}>It may have expired, been revoked, or reached its view limit. Ask the owner for a new link.</p>
      <Link to="/" className="btn-primary">← Home</Link>
    </div>
  );
}

export function ErrorPanel({ message, onRetry }) {
  return (
    <div className={styles.center} data-state="error">
      <h2>Something went wrong</h2>
      <p style={{ color: '#9090a0', margin: '10px 0 20px' }}>{message || 'Please try again.'}</p>
      {onRetry && <button className="btn-primary" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function PasswordGate({ title, onUnlock, error, busy }) {
  const [pw, setPw] = useState('');
  return (
    <div className={styles.center} data-state="password_gate">
      <h2><Lock size={22} style={{ verticalAlign: -3 }} /> Password required</h2>
      <p style={{ color: '#9090a0', margin: '10px 0 16px' }}>“{title}” is password-protected.</p>
      <form onSubmit={(e) => { e.preventDefault(); onUnlock(pw); }} style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 260 }}>
        <input type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="Enter password" autoFocus aria-label="Password" />
        {error && <span role="alert" style={{ color: '#ef4444', fontSize: 13 }}>{error}</span>}
        <button className="btn-primary" type="submit" disabled={busy}>{busy ? 'Checking…' : 'Unlock'}</button>
      </form>
    </div>
  );
}

/** The lead gate sits over the player area (docs/12 §6: the SERVER enforces it on /media). */
export function EmailGate({ author, onSubmit, busy, error }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  return (
    <div style={overlay} data-state="email_gate">
      <Mail size={28} style={{ color: '#fff' }} />
      <strong style={{ color: '#fff', fontSize: 17 }}>Enter your email to watch</strong>
      <span style={{ color: '#c7c7d6', fontSize: 13, maxWidth: 340 }}>{author ? `${author} ` : 'The owner '}asks for your email before viewing.</span>
      <form onSubmit={(e) => { e.preventDefault(); if (valid) onSubmit({ email: email.trim(), name: name.trim() }); }} style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 300 }}>
        <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Your name (optional)" style={input} />
        <input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@email.com" autoFocus style={input} aria-label="Email" />
        {error && <span role="alert" style={{ color: '#f87171', fontSize: 13 }}>{error}</span>}
        <button className="btn-primary" type="submit" disabled={busy || !valid} style={{ padding: 11 }}>{busy ? 'Unlocking…' : 'Watch video'}</button>
      </form>
    </div>
  );
}

/** Playback error UI (docs/11 §5) — shown INSIDE the player area. */
export function PlaybackErrorPanel({ kind, onRetry }) {
  const copy = kind === 'removed' ? 'This video was removed.'
    : kind === 'network' ? 'Connection lost — retrying…'
      : kind === 'decode' ? 'This video could not be decoded in your browser.'
        : kind === 'unsupported' ? 'Your browser cannot play this format.'
          : 'Playback failed.';
  return (
    <div style={{ ...overlay, zIndex: 7, background: 'rgba(15,15,25,0.9)' }} data-state="playback_error" data-kind={kind}>
      <AlertTriangle size={30} style={{ color: '#f59e0b' }} />
      <strong style={{ color: '#fff', fontSize: 15 }}>{copy}</strong>
      {onRetry && kind !== 'removed' && <button className="btn-primary" onClick={onRetry}><RefreshCw size={15} /> Try again</button>}
    </div>
  );
}
