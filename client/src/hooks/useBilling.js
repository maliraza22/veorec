import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../AuthContext';
import API from '../api';
import { normalizeUsage, assessQuota } from '../lib/quotaMeters';

// Central hook for everything monetization on the client. It NEVER decides access
// (the server does) — it only fetches the trusted summary so the UI can render
// the right state: meters, badges, locked features, upgrade prompts.
//
// T-307: `usage` is the normalized DUAL-meter shape (lib/quotaMeters): the v1
// GET /api/v1/me/usage body when the v1 stack serves this account (the same
// live aggregates the quota guard evaluates), else the legacy summary + plan.
// The raw legacy body stays available as `usage.legacy` for older consumers.
export function useBilling() {
  const { token } = useAuth();
  const [entitlements, setEntitlements] = useState(null);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);

  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

  const refresh = useCallback(async () => {
    if (!token) { setLoading(false); return; }
    setLoading(true);
    try {
      const safe = (p) => p.catch(() => null);
      const [eRes, uRes, vRes, veRes] = await Promise.all([
        safe(fetch(`${API}/api/me/entitlements`, { headers: authHeaders })),
        safe(fetch(`${API}/api/me/usage`, { headers: authHeaders })),
        safe(fetch(`${API}/api/v1/me/usage`, { headers: authHeaders })),
        safe(fetch(`${API}/api/v1/me/entitlements`, { headers: authHeaders })),
      ]);
      // T-1303: the PostgreSQL-resolved entitlement wins when the v1 stack
      // serves this account (same shape); 404/503/anything else → legacy.
      const legacyEnt = eRes && eRes.ok ? await eRes.json() : null;
      const v1Ent = veRes && veRes.ok ? await veRes.json().catch(() => null) : null;
      const ent = v1Ent && v1Ent.plan ? { ...v1Ent, resolvedBy: 'v1' } : legacyEnt;
      const legacy = uRes && uRes.ok ? await uRes.json() : null;
      // 404 (v1 not mounted), 503 account_not_migrated, anything else → legacy.
      const v1 = vRes && vRes.ok ? await vRes.json().catch(() => null) : null;
      setEntitlements(ent);
      const meters = normalizeUsage({ v1, legacy, plan: ent && ent.plan });
      setUsage(meters ? { ...meters, legacy, quota: assessQuota(meters) } : null);
    } catch { /* leave nulls */ } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { refresh(); }, [refresh]);

  // Capability check for UI gating. Mirrors server flags; server still enforces.
  const can = useCallback((featureKey) => {
    const f = entitlements?.plan?.features;
    return !!(f && f[featureKey]);
  }, [entitlements]);

  // Report a paywall impression (conversion analytics).
  const reportUpgradeIntent = useCallback((featureRequested, meta = {}) => {
    if (!token) return;
    fetch(`${API}/api/events/upgrade-intent`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureRequested, meta }),
    }).catch(() => {});
  }, [token]);

  return {
    loading,
    entitlements,
    usage,
    plan: entitlements?.plan || null,
    planSlug: entitlements?.planSlug || 'free',
    isPaid: !!entitlements?.isPaid,
    subscription: entitlements?.subscription || null,
    can,
    refresh,
    reportUpgradeIntent,
  };
}
