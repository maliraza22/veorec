import React, { createContext, useContext, useState, useEffect } from 'react';
import API from './api';
import { createAuthClient, isSessionToken } from './lib/authApi.mjs';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser]     = useState(null);
  const [token, setToken]   = useState(() => localStorage.getItem('sr_token'));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) { setLoading(false); return; }
    fetch(`${API}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(u => { setUser(u); setLoading(false); })
      .catch(() => { setLoading(false); });
  }, [token]);

  function login(token, user) {
    localStorage.setItem('sr_token', token);
    setToken(token);
    setUser(user);
  }

  function logout() {
    // T-1302: a v1 session token is revoked server-side (best effort); a legacy JWT simply expires.
    if (isSessionToken(token)) createAuthClient({ API, useV1: true }).logout(token).catch(() => {});
    localStorage.removeItem('sr_token');
    setToken(null);
    setUser(null);
  }

  // Authenticated fetch helper
  function authFetch(url, opts = {}) {
    return fetch(url, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
    });
  }

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout, authFetch, updateUser: setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
