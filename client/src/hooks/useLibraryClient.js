import { useEffect, useMemo, useState } from 'react';
import API from '../api';
import { useAuth } from '../AuthContext';
import { fetchClientConfig } from '../lib/v1Upload';
import { createLibraryClient, libraryIsV1 } from '../lib/libraryApi.mjs';

// T-803: one server decision per page load (`library.path` on the authed
// client-config), then a client bound to that path. Any failure → legacy,
// exactly as the upload gates behave. `ready` flips once the decision is in.
export function useLibraryClient() {
  const { authFetch } = useAuth();
  const [useV1, setUseV1] = useState(null);
  useEffect(() => {
    let alive = true;
    fetchClientConfig({ API, authFetch }).then((cfg) => { if (alive) setUseV1(libraryIsV1(cfg)); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const client = useMemo(() => (useV1 === null ? null : createLibraryClient({ API, authFetch, useV1 })), [useV1, authFetch]);
  return { client, ready: useV1 !== null, useV1: !!useV1 };
}
