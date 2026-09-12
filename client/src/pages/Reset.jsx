import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import API from '../api';
import { useAuthClient } from '../hooks/useAuthClient';
import styles from './Auth.module.css';

export default function Reset() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const authClient = useAuthClient();
  const [params] = useSearchParams();
  const token = params.get('token');
  const email = params.get('email');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const data = await authClient.reset({ email, token, password });
      if (data.error) { setError(data.error || 'Could not reset password'); return; }
      login(data.token, data.user);
      navigate('/');
    } catch { setError('Network error'); } finally { setLoading(false); }
  }

  const invalid = !token || !email;

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logo}><span className={styles.dot} />VeoRec</div>
        <h1 className={styles.title}>Set a new password</h1>
        <p className={styles.sub}>{email ? `For ${email}` : 'Reset your account password'}</p>

        {invalid ? (
          <>
            <div className={styles.error}>This reset link is invalid or incomplete. Please request a new one.</div>
            <p className={styles.footer}><Link to="/forgot">Request a new link</Link></p>
          </>
        ) : (
          <form onSubmit={submit} className={styles.form}>
            {error && <div className={styles.error}>{error}</div>}
            <label className={styles.label}>New password</label>
            <input type="password" required placeholder="Min 6 characters" className={styles.input}
              value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
            <button type="submit" className={styles.btn} disabled={loading}>
              {loading ? 'Saving…' : 'Reset password'}
            </button>
            <p className={styles.footer}><Link to="/login">← Back to sign in</Link></p>
          </form>
        )}
      </div>
    </div>
  );
}
