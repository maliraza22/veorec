import { useCallback, useEffect, useRef, useState } from 'react';
import { refreshDelay, shouldRefresh } from '../../lib/watchApi.mjs';

// T-802 (docs/11 §2): media URL resolution + refresh.
//
//   • `/media` is requested once the recording is READY (and the viewer has
//     cleared every gate); the URLs it returns expire, so a timer re-requests
//     them 60 s before `expiresAt` and the player swaps `src` seamlessly.
//   • The player also asks for a refresh on a 403-shaped failure (one automatic
//     retry — docs/11 §5); a second failure surfaces the error UI.
//   • A gate answered by `/media` (email_required, password_required, login,
//     link_expired) is reported back so the page can show it — the SERVER is
//     the enforcement point, the page merely renders its decision.
export function useWatchMedia({ client, rec, enabled }) {
  const [media, setMedia] = useState(null);
  const [gate, setGate] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef(null);
  const refreshes = useRef(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; clearTimeout(timer.current); }, []);

  const load = useCallback(async ({ reason = 'initial' } = {}) => {
    if (!client || !rec) return null;
    clearTimeout(timer.current);
    setLoading(true);
    try {
      const r = await client.media({ rec });
      if (!alive.current) return null;
      if (r.gate) { setGate(r.gate); setMedia(null); return null; }
      setGate(null); setError(null);
      setMedia(r.media);
      if (reason === 'refresh' || reason === 'expired') refreshes.current += 1;
      // Schedule the next refresh before the signatures expire (signed URLs only).
      if (r.media && r.media.expiresAt) {
        timer.current = setTimeout(() => { load({ reason: 'refresh' }).catch(() => {}); }, refreshDelay(r.media.expiresAt));
      }
      return r.media;
    } catch (e) {
      if (alive.current) setError(e);
      return null;
    } finally { if (alive.current) setLoading(false); }
  }, [client, rec]);

  useEffect(() => {
    if (!enabled) { clearTimeout(timer.current); return undefined; }
    load({ reason: 'initial' }).catch(() => {});
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, client, rec && rec.id, rec && rec.status]);

  /** The player hit a 403/network-shaped failure: refresh once if the URLs are stale-ish. */
  const onNeedRefresh = useCallback((kind) => {
    if (!media) return;
    if (kind === 'expired' || shouldRefresh(media.expiresAt) || kind === 'network' || kind === 'other') load({ reason: 'expired' }).catch(() => {});
  }, [media, load]);

  return { media, gate, error, loading, reload: load, onNeedRefresh, refreshes: refreshes.current };
}
