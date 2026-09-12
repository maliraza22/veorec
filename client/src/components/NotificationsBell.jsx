import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, MessageSquare, Eye, Smile, Loader2 } from 'lucide-react';
import { useLibraryClient } from '../hooks/useLibraryClient';
import s from './NotificationsBell.module.css';

function timeAgo(ts) {
  if (!ts) return '';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60); if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60); if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24); if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7); if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

// Activity type → icon + verb + accent. Keeps the feed scannable at a glance.
const TYPE = {
  comment:  { Icon: MessageSquare, verb: 'commented on', color: '#5b5bf6' },
  reaction: { Icon: Smile,         verb: 'reacted to',   color: '#f59e0b' },
  view:     { Icon: Eye,           verb: 'viewed',        color: '#10b981' },
};

// T-803: the feed comes from the library data layer — PostgreSQL (query-derived,
// docs/13 §6) when the server says `library.path === 'v1'`, the legacy JSON
// scan otherwise. The rendering is unchanged: the two APIs answer the same shape.
export default function NotificationsBell() {
  const { client, ready } = useLibraryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const ref = useRef(null);

  async function load() {
    if (!client) return;
    setLoading(true);
    try {
      const d = await client.notifications();
      if (d) { setItems(d.items); setUnread(d.unread); }
    } catch {}
    setLoading(false);
  }

  // Initial fetch + lightweight poll so the badge stays fresh.
  useEffect(() => {
    if (!ready) return undefined;
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, client]);

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      await load();
      if (unread > 0 && client) {
        try { await client.markNotificationsRead(); } catch {}
        setUnread(0);
      }
    }
  }

  return (
    <div className={s.wrap} ref={ref}>
      <button className={s.bellBtn} onClick={toggle} aria-label="Notifications">
        <Bell size={19} />
        {unread > 0 && <span className={s.badge}>{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <div className={s.panel}>
          <div className={s.panelHead}>
            <span>Notifications</span>
            {items.length > 0 && <span className={s.count}>{items.length}</span>}
          </div>

          <div className={s.list}>
            {loading && !items.length ? (
              <div className={s.empty}><Loader2 size={18} className={s.spin} /></div>
            ) : items.length === 0 ? (
              <div className={s.empty}>
                <Bell size={24} color="#c7c7d1" />
                <p>No activity yet</p>
                <small>Views, comments and reactions on your videos show up here.</small>
              </div>
            ) : items.map((it, i) => {
              const cfg = TYPE[it.type] || TYPE.view;
              const isNew = i < unread;
              return (
                <button
                  key={i}
                  className={`${s.item} ${isNew ? s.itemNew : ''}`}
                  onClick={() => { setOpen(false); navigate(`/watch/${it.videoId}`); }}
                >
                  <span className={s.avatar} style={{ background: cfg.color }}>
                    {(it.name || '?').charAt(0).toUpperCase()}
                    <span className={s.typeBadge} style={{ color: cfg.color }}><cfg.Icon size={11} /></span>
                  </span>
                  <span className={s.body}>
                    <span className={s.text}>
                      <strong>{it.name}</strong> {cfg.verb} <strong>{it.videoTitle}</strong>
                      {it.type === 'reaction' && <span className={s.emoji}> {it.emoji}</span>}
                    </span>
                    {it.type === 'comment' && it.text ? (
                      <span className={s.snippet}>&ldquo;{it.text}&rdquo;</span>
                    ) : null}
                    <span className={s.time}>{timeAgo(it.at)}</span>
                  </span>
                  {isNew && <span className={s.dot} />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
