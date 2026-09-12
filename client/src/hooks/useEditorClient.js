import { useEffect, useMemo, useState } from 'react';
import API from '../api';
import { useAuth } from '../AuthContext';
import { fetchClientConfig } from '../lib/v1Upload';
import { createEditorClient, editorIsV1 } from '../lib/editorApi.mjs';

// T-1201: one server decision per page load (`editor.path` on the authed
// client-config), then a client bound to that path. Any failure → legacy,
// exactly as the other gates behave. `ready` flips once the decision is in.
export function useEditorClient() {
  const { authFetch } = useAuth();
  const [useV1, setUseV1] = useState(null);
  useEffect(() => {
    let alive = true;
    fetchClientConfig({ API, authFetch }).then((cfg) => { if (alive) setUseV1(editorIsV1(cfg)); }).catch(() => { if (alive) setUseV1(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const client = useMemo(() => (useV1 === null ? null : createEditorClient({ API, authFetch, useV1 })), [useV1, authFetch]);
  return { client, ready: useV1 !== null, useV1: !!useV1 };
}
