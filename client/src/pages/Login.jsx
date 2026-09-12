import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import API from '../api';
import GoogleButton from '../components/GoogleButton';
import { useAuthClient } from '../hooks/useAuthClient';
import styles from './Auth.module.css';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const authClient = useAuthClient();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const data = await authClient.login(form);
      if (data.error) { setError(data.error); return; }
      login(data.token, data.user);
      navigate('/');
    } catch {
      setError('Network error — is the server running?');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logo}><span className={styles.dot} />VeoRec</div>
        <h1 className={styles.title}>Welcome back</h1>
        <p className={styles.sub}>Sign in to your account</p>

        {error && <div className={styles.error}>{error}</div>}

        <GoogleButton />

        <form onSubmit={submit} className={styles.form}>
          <label className={styles.label}>Email</label>
          <input
            type="email" required placeholder="you@example.com"
            value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            className={styles.input}
          />
          <div className={styles.labelRow}>
            <label className={styles.label}>Password</label>
            <Link to="/forgot" className={styles.forgot}>Forgot password?</Link>
          </div>
          <input
            type="password" required placeholder="••••••••"
            value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
            className={styles.input}
          />
          <button type="submit" className={styles.btn} disabled={loading}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <p className={styles.footer}>
          Don't have an account? <Link to="/signup">Sign up</Link>
        </p>
        <p className={styles.legal}>
          <Link to="/terms">Terms</Link> · <Link to="/privacy">Privacy</Link> · <Link to="/refund">Refunds</Link>
        </p>
      </div>
    </div>
  );
}
