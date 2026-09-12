// ─────────────────────────────────────────────────────────────────────────────
// T-1302 — the auth data layer (sign-up, sign-in, Google, forgot/reset, logout).
//
// ONE module knows which auth API the pages talk to. The server decides on the
// PUBLIC client-config (`GET /api/client-config/public` → `auth.path`) because
// a visitor signing in has no token yet; the pages never guess.
//
//   • path 'v1'     → /api/v1/auth/* : opaque, revocable session tokens (`vs_…`)
//                     on PostgreSQL; logout revokes the session server-side.
//   • path 'legacy' → /api/auth/*   : the 30-day JWT exactly as before (the
//                     flag is OFF by default).
//
// A session token keeps working on every legacy route through the server's
// requireAuth bridge, so the rest of the client does not change.
// ─────────────────────────────────────────────────────────────────────────────

const safeJson = async (r) => { try { return await r.json(); } catch { return null; } };

/** Only an explicit `auth.path === 'v1'` counts; anything else is legacy. */
export const authIsV1 = (cfg) => !!(cfg && cfg.auth && cfg.auth.path === 'v1');

/** A v1 session token (revocable) vs a legacy JWT. */
export const isSessionToken = (token) => typeof token === 'string' && token.startsWith('vs_');

/** The nested v1 error contract, or the legacy `{error:'text'}` → one message + code. */
export function errorOf(body, fallback = 'Something went wrong.') {
  if (body && body.error && typeof body.error === 'object') return { error: body.error.message || fallback, code: body.error.code || null, retryAfterSeconds: body.error.meta && body.error.meta.retryAfterSeconds };
  return { error: (body && typeof body.error === 'string' && body.error) || fallback, code: (body && body.code) || null };
}

/** Read the public config once per page load; any failure → legacy. */
export async function fetchAuthConfig({ API, fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(`${API}/api/client-config/public`);
    if (!r.ok) return { auth: { path: 'legacy' } };
    const body = await safeJson(r);
    return body || { auth: { path: 'legacy' } };
  } catch { return { auth: { path: 'legacy' } }; }
}

/**
 * @param {{ API: string, useV1: boolean, fetchImpl?: Function }} o
 */
export function createAuthClient({ API, useV1, fetchImpl = fetch }) {
  const base = useV1 ? `${API}/api/v1/auth` : `${API}/api/auth`;
  const json = (body, init = {}) => ({ method: 'POST', ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }, body: JSON.stringify(body) });
  const call = async (p, init) => {
    const r = await fetchImpl(`${base}${p}`, init);
    const body = await safeJson(r);
    if (!r.ok) return { ...errorOf(body), status: r.status };
    return { ...(body || {}), status: r.status };
  };
  return {
    useV1,
    path: useV1 ? 'v1' : 'legacy',
    signup: (form) => call('/signup', json(form)),
    login: (form) => call('/login', json(form)),
    google: (credential) => call('/google', json({ credential })),
    forgot: (email) => call('/forgot', json({ email })),
    reset: (form) => call('/reset', json(form)),
    config: () => call('/config', { method: 'GET' }),
    /** Revoke the session server-side (v1 only — a legacy JWT cannot be revoked). */
    async logout(token) {
      if (!useV1 || !isSessionToken(token)) return { ok: true, revoked: false };
      return call('/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    },
    sessions: (token) => call('/sessions', { method: 'GET', headers: { Authorization: `Bearer ${token}` } }),
    revokeSession: (token, id) => call(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }),
  };
}
