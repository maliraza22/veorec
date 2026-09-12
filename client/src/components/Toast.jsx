import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';

// T-802: the alert() replacement. A tiny toast stack — no dependency, no
// blocking dialog. `useToast().error('…')` / `.info('…')` from anywhere under
// <ToastProvider>. Toasts auto-dismiss (errors stay a little longer).
const ToastContext = createContext({ show: () => {}, error: () => {}, info: () => {}, success: () => {} });

export function useToast() { return useContext(ToastContext); }

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const seq = useRef(0);
  const dismiss = useCallback((id) => setItems((xs) => xs.filter((t) => t.id !== id)), []);
  const show = useCallback((message, { kind = 'info', ttl } = {}) => {
    const id = ++seq.current;
    const text = String(message || '').trim() || 'Something went wrong.';
    setItems((xs) => [...xs.slice(-3), { id, kind, text }]);
    const ms = ttl ?? (kind === 'error' ? 6000 : 3500);
    if (ms > 0) setTimeout(() => dismiss(id), ms);
    return id;
  }, [dismiss]);
  const api = useMemo(() => ({
    show,
    error: (m, o) => show(m, { ...o, kind: 'error' }),
    info: (m, o) => show(m, { ...o, kind: 'info' }),
    success: (m, o) => show(m, { ...o, kind: 'success' }),
  }), [show]);
  const bg = { error: '#b91c1c', info: '#1f2937', success: '#15803d' };
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 1000, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 380 }}>
        {items.map((t) => (
          <div key={t.id} role={t.kind === 'error' ? 'alert' : 'status'} data-toast={t.kind}
            style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 10, color: '#fff', background: bg[t.kind] || bg.info, boxShadow: '0 8px 24px rgba(0,0,0,.25)', fontSize: 14, lineHeight: 1.35 }}>
            <span style={{ flex: 1, whiteSpace: 'pre-line' }}>{t.text}</span>
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss" style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', padding: 0, opacity: .8 }}><X size={15} /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
