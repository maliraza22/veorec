import React from 'react';
import { Link } from 'react-router-dom';
import s from './Paywall.module.css';
import { meterRatio, MSG_NEAR_LIMIT } from '../lib/quotaMeters';

// T-307 — the DUAL meters of docs/16 §4.6: Storage and Videos are separate,
// each with its own bar and its own "x / y" reading, never merged into one
// percentage, because either limit alone can block the next recording.
// `usage` is the normalized shape from lib/quotaMeters (useBilling().usage).

function Bar({ ratio }) {
  const pct = Math.round(ratio * 100);
  const fillCls = pct >= 95 ? s.fillDanger : pct >= 80 ? s.fillWarn : s.fill;
  return (
    <div className={s.track}>
      <div className={`${s.fill} ${fillCls}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function StorageMeter({ usage, isPaid, showUpgradeHint = true }) {
  if (!usage || !usage.storage) return null;
  const ratio = meterRatio(usage.storage.usedBytes, usage.storage.limitBytes);
  return (
    <div className={s.meter} data-meter="storage">
      <div className={s.meterHead}>
        <span className={s.meterLabel}>Storage</span>
        <span className={s.meterValue}>{usage.storage.display}</span>
      </div>
      <Bar ratio={ratio} />
      {showUpgradeHint && !isPaid && ratio >= 0.8 && (
        <p className={s.meterHint}>{MSG_NEAR_LIMIT} <Link to="/pricing">Upgrade to Pro</Link></p>
      )}
    </div>
  );
}

export function VideosMeter({ usage, isPaid, showUpgradeHint = true }) {
  if (!usage || !usage.videos) return null;
  const { count, max } = usage.videos;
  const ratio = max == null ? 0 : meterRatio(count, max);
  return (
    <div className={s.meter} data-meter="videos">
      <div className={s.meterHead}>
        <span className={s.meterLabel}>Videos</span>
        <span className={s.meterValue}>{usage.videos.display}</span>
      </div>
      {max != null && <Bar ratio={ratio} />}
      {showUpgradeHint && !isPaid && max != null && count >= max - 5 && (
        <p className={s.meterHint}>{MSG_NEAR_LIMIT} <Link to="/pricing">Upgrade to Pro</Link></p>
      )}
    </div>
  );
}

/** Both meters, stacked — the only way they are meant to appear together. */
export function DualMeters({ usage, isPaid, showUpgradeHint = true }) {
  if (!usage) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} data-meters="dual">
      <StorageMeter usage={usage} isPaid={isPaid} showUpgradeHint={showUpgradeHint} />
      <VideosMeter usage={usage} isPaid={isPaid} showUpgradeHint={showUpgradeHint} />
    </div>
  );
}
