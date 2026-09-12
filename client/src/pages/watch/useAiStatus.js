import { useCallback, useEffect, useRef, useState } from 'react';
import { summarizeAiStatus, aiPollDelay } from '../../lib/aiStatus.mjs';

// T-1103 (docs/15 §7): the OWNER's view of the AI work on a v1 recording.
// One read of GET /api/v1/recordings/:id/status on load, then polling only
// while something is queued/running (or while the page has a trigger in
// flight). The state is a FACT the server reports, never a guess from a timer.
export function useAiStatus({ API, authHeaders, rec, enabled, busyHint = false }) {
  const [status, setStatus] = useState(null);
  const attempt = useRef(0);
  const timer = useRef(null);
  const alive = useRef(true);
  const id = rec && rec.id;

  const refresh = useCallback(async () => {
    if (!enabled || !id) return null;
    try {
      const r = await fetch(`${API}/api/v1/recordings/${encodeURIComponent(id)}/status`, { headers: authHeaders ? authHeaders() : {} });
      if (!r.ok) return null;
      const d = await r.json();
      if (alive.current) setStatus(d);
      return d;
    } catch { return null; }
  }, [API, authHeaders, id, enabled]);

  useEffect(() => {
    alive.current = true;
    clearTimeout(timer.current);
    if (!enabled || !id) { setStatus(null); return undefined; }
    let stopped = false;
    const tick = async () => {
      const d = await refresh();
      if (stopped) return;
      const s = summarizeAiStatus(d);
      if (!s.busy && !busyHint) { attempt.current = 0; return; }
      attempt.current += 1;
      timer.current = setTimeout(tick, aiPollDelay(attempt.current));
    };
    tick();
    return () => { stopped = true; alive.current = false; clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, id, busyHint, refresh]);

  return { status, summary: summarizeAiStatus(status), refresh };
}
