import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import API from '../api';
import { useAuthClient } from '../hooks/useAuthClient';
import styles from './Auth.module.css';

export default function Forgot() {
  const authClient = useAuthClient();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [emailEnabled, setEmailEnabled] = useState(null); // null = unknown until /config loads

  useEffect(() => {
    if (!authClient) return;
    authClient.config()
      .then((d) => setEmailEnabled(!!d.emailEnabled))
      .catch(() => setEmailEnabled(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authClient]);

  async function submit(e) {
    e.preventDefault();
    setLoading(true);
    try {
      const r = await authClient.forgot(email);
      if (!r.error) setSent(true);
    } catch { /* keep the form so the user can retry */ } finally { setLoading(false); }
  }

  // Reset-by-email isn't wired up yet (no mail provider). Be honest instead of
  // showing a "link is on its way" message for an email that will never arrive.
  if (emailEnabled === false) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.logo}><span className={styles.dot} />VeoRec</div>
          <h1 className={styles.title}>Reset password</h1>
          <div style={{ background: '#fff6e6', border: '1px solid #f3d99b', color: '#8a5a00', borderRadius: 8, padding: '12px 14px', fontSize: 14, lineHeight: 1.5 }}>
            Password reset by email isn’t available just yet. If you signed up with{' '}
            <strong>Google</strong>, head back and use <strong>Continue with Google</strong>.
            Otherwise, <Link to="/contact">contact support</Link> and we’ll help you back in.
          </div>
          <p className={styles.footer}><Link to="/login">← Back to sign in</Link></p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logo}><span className={styles.dot} />VeoRec</div>
        <h1 className={styles.title}>Reset password</h1>
        <p className={styles.sub}>We’ll email you a link to set a new password.</p>

        {sent ? (
          <>
            <div className={styles.ok || ''} style={{ background: '#e7f7ef', border: '1px solid #b6e6cf', color: '#14794e', borderRadius: 8, padding: '12px 14px', fontSize: 14 }}>
              If an account exists for <strong>{email}</strong>, a reset link is on its way. Check your inbox (and spam).
            </div>
            <p className={styles.footer}><Link to="/login">← Back to sign in</Link></p>
          </>
        ) : (
          <form onSubmit={submit} className={styles.form}>
            <label className={styles.label}>Email</label>
            <input type="email" required placeholder="you@example.com" className={styles.input}
              value={email} onChange={e => setEmail(e.target.value)} />
            <button type="submit" className={styles.btn} disabled={loading}>
              {loading ? 'Sending…' : 'Send reset link'}
            </button>
            <p className={styles.footer}><Link to="/login">← Back to sign in</Link></p>
          </form>
        )}
      </div>
    </div>
  );
}
