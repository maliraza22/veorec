import { useEffect, useRef, useState } from 'react';
import { pollDelay, PROCESSING_STATUSES } from '../../lib/watchApi.mjs';

// T-802 (docs/11 §1): while a recording is processing, poll the API at 2 s →
// 5 s backoff until it is ready or failed. The state transition is a FACT the
// server reports, never a guess from a timer. Owners also get the pipeline
// jobs (progress %) from GET /api/v1/recordings/:id/status.
export function useStatusPolling({ client, rec, onUpdate, API, authHeaders, enabled }) {
  const [jobs, setJobs] = useState(null);
  const attempt = useRef(0);
  const timer = useRef(null);
  useEffect(() => {
    clearTimeout(timer.current);
    if (!enabled || !client || !rec || !PROCESSING_STATUSES.has(rec.status)) { attempt.current = 0; return undefined; }
    let stopped = false;
    const tick = async () => {
      try {
        const next = await client.poll();
        if (stopped) return;
        if (rec.viewer && rec.viewer.isOwner && rec.source === 'v1' && API !== undefined) {
          try {
            const r = await fetch(`${API}/api/v1/recordings/${encodeURIComponent(rec.id)}/status`, { headers: authHeaders ? authHeaders() : {} });
            if (r.ok) { const d = await r.json(); if (!stopped) setJobs(Array.isArray(d.jobs) ? d.jobs : null); }
          } catch {}
        }
        if (next) onUpdate(next);
        if (next && !PROCESSING_STATUSES.has(next.status)) return;   // ready / failed → stop
      } catch {}
      attempt.current += 1;
      timer.current = setTimeout(tick, pollDelay(attempt.current));
    };
    timer.current = setTimeout(tick, pollDelay(attempt.current));
    return () => { stopped = true; clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, client, rec && rec.id, rec && rec.status]);
  return { jobs };
}
