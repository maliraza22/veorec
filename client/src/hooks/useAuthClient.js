import { useEffect, useMemo, useState } from 'react';
import API from '../api';
import { createAuthClient, fetchAuthConfig, authIsV1 } from '../lib/authApi.mjs';

// T-1302: the sign-in pages bind to the server's PUBLIC auth decision once per
// page load (`auth.path` on /api/client-config/public), then use a client bound
// to that path. Until the decision is in (and on any failure) the client is the
// legacy one — exactly the behaviour production already has.
let cached = null;
export function useAuthClient() {
  const [useV1, setUseV1] = useState(() => (cached === null ? null : cached));
  useEffect(() => {
    let alive = true;
    if (cached !== null) { setUseV1(cached); return undefined; }
    fetchAuthConfig({ API }).then((cfg) => { cached = authIsV1(cfg); if (alive) setUseV1(cached); }).catch(() => { if (alive) setUseV1(false); });
    return () => { alive = false; };
  }, []);
  return useMemo(() => createAuthClient({ API, useV1: !!useV1 }), [useV1]);
}

/** Tests / sign-out: forget the cached decision. */
export function resetAuthClientCache() { cached = null; }
