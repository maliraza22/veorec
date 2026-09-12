import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import API from '../api';
import { useAuthClient } from '../hooks/useAuthClient';

// Renders the official "Continue with Google" button if a Google client ID is
// configured on the server. Verifies the credential on our backend and logs in.
export default function GoogleButton() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const authClient = useAuthClient();
  const ref = useRef(null);
  const [clientId, setClientId] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!authClient) return;
    authClient.config().then(d => setClientId(d.googleClientId)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authClient]);

  useEffect(() => {
    if (!clientId) return;
    function init() {
      if (!window.google || !ref.current) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async (resp) => {
          try {
            const data = await authClient.google(resp.credential);
            if (data.error) { setErr(data.error || 'Google sign-in failed'); return; }
            login(data.token, data.user);
            navigate('/');
          } catch { setErr('Network error'); }
        },
      });
      window.google.accounts.id.renderButton(ref.current, {
        theme: 'outline', size: 'large', width: 320, text: 'continue_with', shape: 'pill',
      });
    }
    if (window.google) { init(); return; }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true; s.onload = init;
    document.body.appendChild(s);
  }, [clientId]);

  if (!clientId) return null;
  return (
    <div style={{ marginTop: 4 }}>
      <div ref={ref} style={{ display: 'flex', justifyContent: 'center' }} />
      {err && <p style={{ color: '#e5484d', fontSize: 13, textAlign: 'center', marginTop: 8 }}>{err}</p>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '16px 0 4px', color: '#9aa1ac', fontSize: 12 }}>
        <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />or<span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
      </div>
    </div>
  );
}
