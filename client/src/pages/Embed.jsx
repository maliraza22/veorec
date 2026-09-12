import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import API from '../api';
import VideoPlayer from '../components/VideoPlayer';
import { createWatchClient, fetchWatchConfig, watchIsV1, stateFor } from '../lib/watchApi.mjs';
import { useWatchMedia } from './watch/useWatchMedia';
import { useStatusPolling } from './watch/useStatusPolling';

// T-802 (docs/11 §7): the embed shares the watch page's data layer, states
// and player — chrome-less, no sidebar. Privacy is respected exactly like the
// watch page: public/unlisted embeds play; a gate shows a message with a link
// out to the full page (where the viewer can sign in / unlock).
function authHeaders() { const t = localStorage.getItem('sr_token'); return t ? { Authorization: `Bearer ${t}` } : {}; }

export default function Embed() {
  const { id } = useParams();
  const videoRef = useRef(null);
  const shareToken = useMemo(() => new URLSearchParams(window.location.search).get('s') || new URLSearchParams(window.location.search).get('shareToken') || null, []);
  const client = useMemo(() => createWatchClient({ API, id, authHeaders, shareToken }), [id, shareToken]);
  const [rec, setRec] = useState(null);
  const [state, setState] = useState('loading');

  useEffect(() => {
    let alive = true;
    (async () => {
      const cfg = await fetchWatchConfig({ API });
      const r = await client.load({ useV1: watchIsV1(cfg) }).catch(() => ({ gate: { state: 'error' } }));
      if (!alive) return;
      if (r.gate) { setState(r.gate.state); return; }
      setRec(r.rec); setState(stateFor(r.rec));
    })();
    return () => { alive = false; };
  }, [client]);

  useStatusPolling({ client, rec, enabled: state === 'processing', onUpdate: (next) => { setRec(next); setState(stateFor(next)); } });
  const { media, gate: mediaGate, onNeedRefresh } = useWatchMedia({ client, rec, enabled: state === 'ready' });

  const wrap = { margin: 0, background: '#000', width: '100vw', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' };
  const msg = (text) => (
    <div style={{ ...wrap, color: '#bbb', fontFamily: 'system-ui', flexDirection: 'column', gap: 10, textAlign: 'center', padding: 24 }}>
      <span>{text}</span>
      <a href={`/watch/${id}${window.location.search}`} target="_blank" rel="noopener noreferrer" style={{ color: '#8b8bff' }}>Open on VeoRec →</a>
    </div>
  );
  if (state === 'loading') return <div style={{ ...wrap, color: '#888', fontFamily: 'system-ui' }}>Loading…</div>;
  if (state === 'not_found' || state === 'error') return <div style={{ ...wrap, color: '#888', fontFamily: 'system-ui' }}>Video unavailable</div>;
  if (state === 'login_gate') return msg('Sign in to watch this video.');
  if (state === 'password_gate') return msg('This video is password-protected.');
  if (state === 'link_expired') return msg('This link is no longer valid.');
  if (state === 'failed') return msg("This video isn't available yet.");
  if (state === 'processing') return <div style={{ ...wrap, color: '#bbb', fontFamily: 'system-ui' }}>Processing your video…</div>;
  if (state === 'email_gate' || (mediaGate && mediaGate.state === 'email_gate')) return msg('Enter your email on VeoRec to watch this video.');
  if (mediaGate) return msg('This video is not available in an embed.');

  return (
    <div style={{ ...wrap, position: 'relative' }}>
      <VideoPlayer
        videoRef={videoRef}
        src={media ? media.mp4Url : null}
        hlsUrl={media ? media.hlsUrl : null}
        poster={media ? media.posterUrl : null}
        captionsUrl={media ? media.captionsUrl : null}
        segments={Array.isArray(rec.segments) && rec.segments.length ? rec.segments : null}
        trimStart={rec.trimStart}
        trimEnd={rec.trimEnd}
        recommendedSpeed={rec.recommendedSpeed}
        chapters={rec.chapters}
        branding={rec.branding}
        legacyWebm={!!(media && media.isWebm)}
        onNeedRefresh={onNeedRefresh}
        autoPlay={false}
      />
    </div>
  );
}
