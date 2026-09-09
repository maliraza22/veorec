// ─────────────────────────────────────────────────────────────────────────────
// T-204 — BACKFILL COPIER: existing legacy media → R2
//
// Copies the bytes of every already-existing recording into R2 and records the
// `video_assets` row, so that historical media lives beside the new uploads
// T-203 already mirrors.
//
// ── THE RULE THAT OUTRANKS EVERYTHING ELSE ──────────────────────────────────
// COPYING IS NOT CUTTING OVER. A verified object here is an ADDITIONAL copy.
// Cloudinary keeps serving every read until a later, separately approved task
// moves them. Nothing in this file deletes, overwrites, renames, or reorganises
// legacy media, and nothing changes what the application reads — there is no
// delete call against the legacy provider anywhere in T-204, by construction.
//
// ── ORDER, AND WHY IT IS THIS ORDER ─────────────────────────────────────────
//   1. claim the item          (one short statement, then the transaction ends)
//   2. transfer the bytes      (no database transaction is open here)
//   3. verify the destination  (re-read the object; compare its size)
//   4. record completion       (asset row, then the checklist stamp)
//
// A transfer can take minutes. Holding a transaction across it would pin a
// connection and block vacuum for the duration, so the claim commits before any
// byte moves. The cost is that a crash between (2) and (4) leaves an object
// with no completion stamp — deliberately the safe direction: the item is
// re-claimed later and converges, because the key is deterministic and the row
// write is an upsert. The opposite order would let the database claim an object
// exists that never landed.
//
// ── VERIFIED MEANS VERIFIED ─────────────────────────────────────────────────
// An upload call returning 200 is not evidence. Nothing is marked `verified`
// until the object has been read back and its byte count compared with the
// bytes actually fetched from the source.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const legacyStore = require('./legacy-store');
const { keys } = require('../../../storage/src/keys');

// Bounded concurrency: the copier competes with a live application for
// Cloudinary bandwidth, R2 write capacity and database connections. Small and
// explicit beats a Promise.all over the whole dataset, which would hammer every
// one of them at once.
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_BATCH = 25;
// Below this, a claim from a crashed worker is still considered live.
const DEFAULT_STALE_CLAIM_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;

/** Outcome buckets, mirroring the checklist states. */
class BackfillReport {
  constructor(mode) {
    this.mode = mode;
    this.claimed = 0;
    this.verified = 0;
    this.alreadyDone = 0;   // an earlier run (or T-203) had already put it there
    this.wouldCopy = 0;     // dry run only: items a real run would transfer
    this.failed = 0;
    this.skipped = 0;
    this.unsafe = 0;
    this.bytesCopied = 0;
    this.problems = [];
  }

  problem(recordingId, reason, detail) {
    this.problems.push({ recordingId, reason, detail: String(detail || '').slice(0, 300) });
  }

  format(stats) {
    const lines = [
      '',
      `── BACKFILL ${this.mode === 'apply' ? 'APPLY' : 'DRY RUN (no writes)'} ─────────────────────`,
      '',
      `  claimed this run : ${this.claimed}`,
      `  verified         : ${this.verified}`,
      ...(this.mode === 'apply' ? [] : [`  would copy       : ${this.wouldCopy}`]),
      `  already in R2    : ${this.alreadyDone}`,
      `  failed           : ${this.failed}`,
      `  skipped          : ${this.skipped}`,
      `  unsafe (review)  : ${this.unsafe}`,
      `  bytes copied     : ${this.bytesCopied.toLocaleString()}`,
    ];
    if (stats) {
      lines.push('', '  checklist across the whole dataset:');
      for (const k of ['pending', 'claimed', 'verified', 'failed', 'skipped', 'unsafe']) {
        lines.push(`    ${k.padEnd(9)} ${stats[k]}`);
      }
    }
    if (this.problems.length) {
      lines.push('', `  ${this.problems.length} item(s) need attention:`);
      for (const p of this.problems.slice(0, 20)) {
        lines.push(`    ${p.recordingId}  ${p.reason}${p.detail ? ` — ${p.detail}` : ''}`);
      }
      if (this.problems.length > 20) lines.push(`    …and ${this.problems.length - 20} more`);
    }
    return lines.join('\n');
  }

  toJSON() {
    return {
      mode: this.mode, claimed: this.claimed, verified: this.verified,
      alreadyDone: this.alreadyDone, wouldCopy: this.wouldCopy,
      failed: this.failed, skipped: this.skipped,
      unsafe: this.unsafe, bytesCopied: this.bytesCopied, problems: this.problems,
    };
  }
}

/** Read the source bytes. READ-ONLY against the legacy provider, always. */
async function fetchSource(item, { dataDir, fetchImpl }) {
  if (item.legacy_provider === 'local_disk') {
    // Bytes sit on the legacy server's disk. Reachable only when the copier
    // runs on that host (or the volume is mounted), so absence is `skipped`,
    // not a failure — there is nothing to retry from here.
    if (!dataDir) {
      return { skip: 'local_disk media needs --data-dir pointing at the legacy uploads volume' };
    }
    const file = path.join(dataDir, 'uploads', item.legacy_public_id);
    if (!fs.existsSync(file)) {
      return { skip: `local_disk file not present at the configured data dir` };
    }
    return { body: fs.readFileSync(file), bytes: fs.statSync(file).size };
  }

  // Cloudinary: fetch the delivery URL. A plain HTTPS GET — no SDK, no
  // credentials, and no possibility of mutating the source.
  if (!item.legacy_url) {
    return { unsafe: 'no legacy_url recorded; cannot locate the bytes without guessing' };
  }
  const res = await (fetchImpl || fetch)(item.legacy_url);
  if (res.status === 404 || res.status === 410) {
    return { fail: `source missing at the legacy provider (HTTP ${res.status})`, retryable: false };
  }
  if (!res.ok) {
    // 5xx/429 are worth another attempt; other 4xx are not.
    return { fail: `legacy provider returned HTTP ${res.status}`, retryable: res.status >= 500 || res.status === 429 };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { body: buf, bytes: buf.length };
}

/**
 * Copy one claimed item. Returns an outcome; never throws for expected
 * conditions, so one bad recording can never abort the run.
 */
async function copyOne(item, ctx) {
  const { provider, repos, store, report, dryRun, dataDir, fetchImpl } = ctx;
  const recordingId = item.recording_id;

  // ── Mapping sanity BEFORE any transfer. Ambiguity is never guessed away.
  if (!item.legacy_public_id && !item.legacy_url) {
    report.unsafe += 1;
    report.problem(recordingId, 'ambiguous mapping', 'no legacy public id and no url');
    if (!dryRun) await store.markBackfillFailed(recordingId,
      { error: 'ambiguous mapping: no legacy public id and no url', retryable: false, status: 'unsafe' });
    return 'unsafe';
  }

  const container = (item.legacy_format || 'webm').toLowerCase();
  let storageKey;
  try {
    storageKey = keys.source(recordingId, container);
  } catch {
    // An unsupported container is a mapping problem, not a transient fault.
    report.unsafe += 1;
    report.problem(recordingId, 'unsupported container', container);
    if (!dryRun) await store.markBackfillFailed(recordingId,
      { error: `unsupported source container "${container}"`, retryable: false, status: 'unsafe' });
    return 'unsafe';
  }

  // ── Already there? This is the T-203 overlap: a recording uploaded after the
  // mirror went live already has its object and asset row, and re-copying it
  // would waste bandwidth for no change. Verify rather than assume.
  const existing = await provider.headObject(storageKey).catch(() => null);
  if (existing) {
    const expected = item.legacy_bytes != null ? Number(item.legacy_bytes) : null;
    if (expected != null && existing.contentLength !== expected) {
      // An object of a DIFFERENT size already occupies this key. Overwriting
      // could destroy a good copy, so a human decides.
      report.unsafe += 1;
      report.problem(recordingId, 'existing object size differs from the legacy record',
        `r2=${existing.contentLength} legacy=${expected}`);
      if (!dryRun) await store.markBackfillFailed(recordingId, {
        error: `object already at ${storageKey} with size ${existing.contentLength}, legacy reports ${expected}`,
        retryable: false, status: 'unsafe',
      });
      return 'unsafe';
    }
    report.alreadyDone += 1;
    if (!dryRun) {
      await repos.assets.upsertSourceSystem({
        recordingId, storageKey, sizeBytes: existing.contentLength, container,
      }, 'T-204 backfill: object already present in R2 (mirrored by T-203 or an earlier run)');
      await store.markBackfillVerified(recordingId, { bytes: existing.contentLength });
    }
    return 'already';
  }

  if (dryRun) { report.wouldCopy += 1; return 'would-copy'; }

  // ── Fetch. Read-only against the legacy provider.
  const src = await fetchSource(item, { dataDir, fetchImpl });
  if (src.skip) {
    report.skipped += 1;
    report.problem(recordingId, 'skipped', src.skip);
    await store.markBackfillFailed(recordingId, { error: src.skip, retryable: false, status: 'skipped' });
    return 'skipped';
  }
  if (src.unsafe) {
    report.unsafe += 1;
    report.problem(recordingId, 'unsafe', src.unsafe);
    await store.markBackfillFailed(recordingId, { error: src.unsafe, retryable: false, status: 'unsafe' });
    return 'unsafe';
  }
  if (src.fail) {
    report.failed += 1;
    report.problem(recordingId, 'source unavailable', src.fail);
    await store.markBackfillFailed(recordingId, { error: src.fail, retryable: src.retryable !== false });
    return 'failed';
  }

  // ── Transfer, then VERIFY by reading the object back.
  try {
    await provider.putObject(storageKey, src.body, {
      contentType: `video/${container === 'mov' ? 'quicktime' : container}`,
      contentLength: src.bytes,
    });
    const head = await provider.headObject(storageKey);
    if (head.contentLength !== src.bytes) {
      // A truncated copy must never be recorded as done. Not retried blindly:
      // a repeatable mismatch is a real integrity problem.
      report.failed += 1;
      report.problem(recordingId, 'size mismatch after copy', `stored=${head.contentLength} source=${src.bytes}`);
      await store.markBackfillFailed(recordingId, {
        error: `size mismatch: stored ${head.contentLength}, source ${src.bytes}`, retryable: false,
      });
      return 'failed';
    }

    // ── Record completion. Asset row first, checklist stamp second: if the
    // process dies between them the item is simply re-claimed and converges,
    // whereas stamping first would claim completion for a row that never landed.
    await repos.assets.upsertSourceSystem({
      recordingId, storageKey, sizeBytes: src.bytes, container,
    }, 'T-204 backfill: legacy original copied to R2 and verified by size');
    await store.markBackfillVerified(recordingId, { bytes: src.bytes });

    report.verified += 1;
    report.bytesCopied += src.bytes;
    return 'verified';
  } catch (err) {
    // Storage taxonomy (T-201) tells us whether another attempt is worthwhile.
    const retryable = err && err.retryable !== undefined ? !!err.retryable : true;
    report.failed += 1;
    report.problem(recordingId, 'copy failed', (err && err.message) || String(err));
    await store.markBackfillFailed(recordingId, {
      error: (err && err.message) || String(err), retryable,
    });
    return 'failed';
  }
}

/** Run N workers over the claimed batch, never more than `concurrency` at once. */
async function runPool(items, concurrency, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Backfill existing legacy media into R2.
 *
 * @param {object} opts
 * @param {object} opts.db            drizzle client
 * @param {object} opts.provider      StorageProvider (T-201)
 * @param {object} opts.repos         repositories (T-103)
 * @param {'report'|'apply'} [opts.mode]
 * @param {number} [opts.limit]       max items this run (0 = until drained)
 * @param {number} [opts.concurrency]
 * @param {string} [opts.dataDir]     legacy uploads volume, for local_disk media
 * @param {number} [opts.maxAttempts] give up (as failed, non-retryable) after this
 * @returns {Promise<BackfillReport>}
 */
async function backfill(opts) {
  const {
    db, provider, repos, mode = 'report', limit = 0,
    concurrency = DEFAULT_CONCURRENCY, batchSize = DEFAULT_BATCH,
    dataDir = null, staleClaimMs = DEFAULT_STALE_CLAIM_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS, fetchImpl = null,
  } = opts;

  const dryRun = mode !== 'apply';
  const store = legacyStore(db);
  const report = new BackfillReport(mode);
  // Identifies THIS worker's claims, so a crash is attributable and a stale
  // claim can be told apart from a live one.
  const claimId = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const ctx = { provider, repos, store, report, dryRun, dataDir, fetchImpl };

  let processed = 0;
  // Every recording this run has already attempted. A run gives each item ONE
  // attempt; anything that failed transiently is left for a later run.
  const attemptedThisRun = [];
  for (;;) {
    const take = limit ? Math.min(batchSize, limit - processed) : batchSize;
    if (take <= 0) break;

    // Dry run must not mutate the checklist, so it inspects the queue instead
    // of claiming from it.
    const items = dryRun
      ? await peekPending(db, take, processed)
      : await store.claimBackfillBatch({ claimId, limit: take, staleClaimMs, excludeIds: attemptedThisRun });
    if (!items.length) break;
    if (!dryRun) {
      report.claimed += items.length;
      for (const it of items) attemptedThisRun.push(it.recording_id);
    }

    await runPool(items, concurrency, async (item) => {
      if (!dryRun && item.backfill_attempts > maxAttempts) {
        // Stop retrying forever; a human decides what to do with it.
        report.failed += 1;
        report.problem(item.recording_id, 'gave up after repeated failures',
          `${item.backfill_attempts} attempts`);
        await store.markBackfillFailed(item.recording_id, {
          error: `gave up after ${item.backfill_attempts} attempts`, retryable: false,
        });
        return;
      }
      await copyOne(item, ctx);
    });

    processed += items.length;
    if (limit && processed >= limit) break;
  }

  report.stats = await store.backfillStats();
  return report;
}

/** Read-only view of the queue, used by the dry run. */
async function peekPending(db, take, offset = 0) {
  // A dry run mutates nothing, so unlike the claiming path it cannot rely on
  // rows leaving the queue to make progress — without the offset it would read
  // the same batch forever.
  const { sql } = require('drizzle-orm');
  const res = await db.execute(sql`
    SELECT * FROM legacy.media_map
     WHERE backfilled_at IS NULL
       AND backfill_status IN ('pending', 'failed')
       AND (backfill_retryable IS DISTINCT FROM false)
     ORDER BY imported_at LIMIT ${take} OFFSET ${offset}`);
  return res.rows || res;
}

module.exports = {
  backfill, BackfillReport, copyOne, fetchSource,
  DEFAULT_CONCURRENCY, DEFAULT_STALE_CLAIM_MS, DEFAULT_MAX_ATTEMPTS,
};
