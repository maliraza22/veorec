import React from 'react';
import { Loader2, RefreshCw, AlertTriangle, Check } from 'lucide-react';
import styles from '../Watch.module.css';

// T-1103 (docs/15 §7): the owner's "AI status" strip — the transcript and each
// AI job with its real state, the taxonomy message on failure and a retry
// affordance where a retry can help. Rendered only when there is something to
// say (work in flight or a failure); driven by the status payload, no timers.
const row = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 9, background: '#16161f', border: '1px solid #26263a', fontSize: 13 };
const label = { fontWeight: 700, color: '#e6e6ef', minWidth: 78 };
const msg = { color: '#a9a9bd', flex: 1 };
const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: '#5b5bf6', color: '#fff', border: 'none', borderRadius: 8, padding: '5px 10px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' };

function Icon({ state }) {
  if (state === 'queued' || state === 'running') return <Loader2 size={15} className={styles.spin} style={{ color: '#8a8aff' }} />;
  if (state === 'failed') return <AlertTriangle size={15} style={{ color: '#f87171' }} />;
  return <Check size={15} style={{ color: '#4ade80' }} />;
}

function stateText(state, progress) {
  if (state === 'queued') return 'Waiting for a worker…';
  if (state === 'running') return progress != null ? `Working… ${Math.round(progress)}%` : 'Working…';
  if (state === 'done') return 'Done';
  return null;
}

export function AiStatusPanel({ summary, onRetry, retrying = {} }) {
  if (!summary || !summary.show) return null;
  const t = summary.transcript;
  const items = [];
  if (t.state !== 'none' && (t.state === 'failed' || t.state === 'queued' || t.state === 'running')) {
    items.push({ kind: 'transcribe', label: 'Transcript', state: t.state, message: t.message, retryable: t.retryable, progress: null });
  }
  for (const i of summary.items) if (i.state !== 'done') items.push(i);
  if (!items.length) return null;
  return (
    <div data-testid="ai-status" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 14 }}>
      <div className={styles.panelLabel}>AI status</div>
      {items.map((i) => (
        <div key={i.kind} style={row} data-kind={i.kind} data-state={i.state}>
          <Icon state={i.state} />
          <span style={label}>{i.label}</span>
          <span style={msg}>{i.state === 'failed' ? (i.message || 'Failed.') : stateText(i.state, i.progress)}</span>
          {i.state === 'failed' && i.retryable && onRetry && (
            <button style={btn} onClick={() => onRetry(i.kind)} disabled={!!retrying[i.kind]}>
              {retrying[i.kind] ? <Loader2 size={13} className={styles.spin} /> : <RefreshCw size={13} />} Retry
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export default AiStatusPanel;
