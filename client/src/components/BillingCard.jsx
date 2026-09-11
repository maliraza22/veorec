import React from 'react';
import s from './Paywall.module.css';
import StorageMeter, { VideosMeter } from './StorageMeter';
import UsageMeter from './UsageMeter';

// Usage-at-a-glance card: storage, videos, recording minutes vs plan limits.
// T-307: Storage and Videos are the two quota meters of docs/16 §4.6, each
// against its own limit ("4.2 GB / 5 GB", "38 / 50") — never one blended
// percentage. The recording-length line is a plan fact, not a quota meter.
export default function BillingCard({ usage, plan, isPaid }) {
  if (!usage || !plan) return null;
  return (
    <div className={s.scard}>
      <div className={s.scardHead}>
        <span className={s.scardTitle}>Usage</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }} data-testid="billing-quota">
        <StorageMeter usage={usage} isPaid={isPaid} />
        <VideosMeter usage={usage} isPaid={isPaid} />
        <UsageMeter
          label="Recording length limit"
          used={plan.recordingLimitMinutes}
          limit={null}
          formatValue={(v) => `${v} min`}
        />
      </div>
    </div>
  );
}
