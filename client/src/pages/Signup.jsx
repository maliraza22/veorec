import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import API from '../api';
import GoogleButton from '../components/GoogleButton';
import { useAuthClient } from '../hooks/useAuthClient';
import styles from './Auth.module.css';

export default function Signup() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const authClient = useAuthClient();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const data = await authClient.signup(form);
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
        <h1 className={styles.title}>Create account</h1>
        <p className={styles.sub}>Start recording and sharing in seconds</p>

        {error && <div className={styles.error}>{error}</div>}

        <GoogleButton />

        <form onSubmit={submit} className={styles.form}>
          <label className={styles.label}>Name</label>
          <input
            type="text" required placeholder="Your name"
            value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            className={styles.input}
          />
          <label className={styles.label}>Email</label>
          <input
            type="email" required placeholder="you@example.com"
            value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            className={styles.input}
          />
          <label className={styles.label}>Password</label>
          <input
            type="password" required placeholder="Min 6 characters"
            value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
            className={styles.input}
          />
          <button type="submit" className={styles.btn} disabled={loading}>
            {loading ? 'Creating account…' : 'Create Account'}
          </button>
        </form>

        <p className={styles.footer}>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
        <p className={styles.legal}>
          By signing up you agree to our <Link to="/terms">Terms</Link>, <Link to="/privacy">Privacy</Link> &amp; <Link to="/refund">Refund</Link> policies.
        </p>
      </div>
    </div>
  );
}
