// ─────────────────────────────────────────────────────────────────────────────
// BASELINE KPI CAPTURE (T-003) — instrumentation only, no behavior change.
//
// Purpose: measure the LEGACY upload + watch pipeline so the migration
// (docs/23) can be compared against real numbers. Emits:
//   • per-event structured log lines (correlated by request_id via req.log)
//   • a periodic aggregate snapshot line (`kpi:"kpi_snapshot"`, every 15 min)
// Everything is in-memory and log-derived — counters reset on redeploy, which
// is fine because analysis sums the per-event lines (see docs/BASELINE.md).
//
// Privacy: only outcome classes, byte sizes, durations and recording ids are
// recorded — never video bytes, URLs, tokens, user identity, or request bodies.
//
// Events:
//   upload_started            {store, sizeBytes}
//   upload_finished           {outcome: success|rejected_limit|error, code,
//                              sizeBytes, durationMs, store}
//   watch_404_retry           {recordingId, attempt, sinceFirstMs}   ← client
//                             retry loop hitting Cloudinary index lag
//   watch_recovered_after_404 {recordingId, retries, waitedMs}       ← how long
//                             lag lasted before the id resolved
//   kpi_snapshot              {counters, upload:{successRatePct,…}, uptimeSec}
//
// Note on durations: `durationMs` here spans handler entry → response, i.e. the
// server→Cloudinary phase (multer has already buffered the client body when the
// handler runs). The TOTAL request duration (client transfer included) is the
// `responseTime` field on the T-002 pino-http completion line for
// url="/api/upload" — use both when comparing against the migrated pipeline.
// Watch hit/miss per-event data is likewise derivable from completion lines
// (url + status); this module only adds counters and the retry/recovery
// correlation that plain status lines cannot express.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;
const DURATION_SAMPLE_CAP = 500;    // rolling sample for p50/p95
const MISS_TTL_MS = 5 * 60 * 1000;  // a hit within 5 min of misses = "recovered"
const MISS_MAP_MAX = 500;           // bounded memory

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const i = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, i)];
}

/**
 * Create a KPI recorder bound to a pino-compatible logger. Exported for tests;
 * production code uses the singleton from initKpi().
 */
function createKpi(logger, { snapshotIntervalMs = SNAPSHOT_INTERVAL_MS } = {}) {
  const startedAt = Date.now();
  const counters = {
    uploadStarted: 0,
    uploadSuccess: 0,
    uploadRejectedLimit: 0,   // plan/policy rejections (403) — not reliability failures
    uploadError: 0,           // real failures (Cloudinary/server/too-large)
    watchHit: 0,
    watchMiss: 0,
    watch404Retry: 0,
    watchRecovered: 0,
    unhandledError: 0,
  };
  const durations = [];       // successful-upload handler durations (ms)
  const misses = new Map();   // recordingId -> { count, firstAt, lastAt }

  const logOf = (req) => (req && req.log) || logger;

  function sweepMisses(now) {
    if (misses.size <= MISS_MAP_MAX) return;
    for (const [id, m] of misses) {
      if (now - m.lastAt > MISS_TTL_MS) misses.delete(id);
      if (misses.size <= MISS_MAP_MAX) break;
    }
    // Still over cap (burst of distinct ids): drop oldest insertions.
    while (misses.size > MISS_MAP_MAX) misses.delete(misses.keys().next().value);
  }

  // ── Uploads ────────────────────────────────────────────────────────────────
  function uploadStarted(req, meta = {}) {
    counters.uploadStarted++;
    if (req) req._kpiUpload = { t0: Date.now(), done: false, store: meta.store || null };
    logOf(req).info({ kpi: 'upload_started', store: meta.store || null, sizeBytes: meta.sizeBytes ?? null }, 'kpi: upload started');
  }

  /** outcome: 'success' | 'rejected_limit' | 'error' */
  function uploadFinished(req, outcome, meta = {}) {
    const mark = req && req._kpiUpload;
    if (mark && mark.done) return;              // double-count guard
    if (mark) mark.done = true;
    // Failure before the handler ran (e.g. multer size limit): count the attempt here.
    if (!mark) counters.uploadStarted++;

    if (outcome === 'success') counters.uploadSuccess++;
    else if (outcome === 'rejected_limit') counters.uploadRejectedLimit++;
    else counters.uploadError++;

    const durationMs = mark ? Date.now() - mark.t0 : null;
    if (durationMs != null && outcome === 'success') {
      durations.push(durationMs);
      if (durations.length > DURATION_SAMPLE_CAP) durations.shift();
    }
    logOf(req).info({
      kpi: 'upload_finished',
      outcome,
      code: meta.code || null,
      sizeBytes: meta.sizeBytes ?? null,
      durationMs,
      store: (mark && mark.store) || meta.store || null,
    }, `kpi: upload ${outcome}`);
  }

  // ── Watch page (Cloudinary index-lag detector) ─────────────────────────────
  function watchMiss(req, recordingId) {
    counters.watchMiss++;
    const now = Date.now();
    sweepMisses(now);
    const m = misses.get(recordingId) || { count: 0, firstAt: now, lastAt: now };
    m.count++; m.lastAt = now;
    misses.set(recordingId, m);
    if (m.count > 1) {
      counters.watch404Retry++;
      logOf(req).info({ kpi: 'watch_404_retry', recordingId, attempt: m.count, sinceFirstMs: now - m.firstAt }, 'kpi: watch 404 retry');
    }
  }

  function watchHit(req, recordingId) {
    counters.watchHit++;
    const m = misses.get(recordingId);
    if (m && Date.now() - m.lastAt <= MISS_TTL_MS) {
      counters.watchRecovered++;
      logOf(req).info({ kpi: 'watch_recovered_after_404', recordingId, retries: m.count, waitedMs: Date.now() - m.firstAt }, 'kpi: watch recovered after 404s');
    }
    misses.delete(recordingId);
  }

  // ── Unhandled request errors (called from the error middleware) ────────────
  function requestError(req, err) {
    const isUpload = String((req && (req.originalUrl || req.url)) || '').split('?')[0] === '/api/upload';
    const tooLarge = err && err.code === 'LIMIT_FILE_SIZE';
    if (!tooLarge) counters.unhandledError++;
    if (isUpload) uploadFinished(req, 'error', { code: tooLarge ? 'file_too_large' : 'unhandled' });
  }

  // ── Aggregate snapshot ─────────────────────────────────────────────────────
  function snapshot() {
    const sorted = [...durations].sort((a, b) => a - b);
    const decided = counters.uploadSuccess + counters.uploadError;
    const withPolicy = decided + counters.uploadRejectedLimit;
    logger.info({
      kpi: 'kpi_snapshot',
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      counters: { ...counters },
      upload: {
        successRatePct: decided ? +((counters.uploadSuccess / decided) * 100).toFixed(2) : null,          // reliability (policy rejections excluded)
        acceptRatePct: withPolicy ? +((counters.uploadSuccess / withPolicy) * 100).toFixed(2) : null,     // funnel incl. plan rejections
        inFlightOrLost: counters.uploadStarted - withPolicy,                                              // started but never finished (crash/hang signal)
        durationMsP50: percentile(sorted, 50),
        durationMsP95: percentile(sorted, 95),
        durationSamples: sorted.length,
      },
    }, 'kpi: snapshot');
    return counters;
  }

  let interval = null;
  if (snapshotIntervalMs > 0) {
    interval = setInterval(snapshot, snapshotIntervalMs);
    if (interval.unref) interval.unref();
  }

  return {
    uploadStarted, uploadFinished, watchMiss, watchHit, requestError, snapshot,
    _counters: counters,                       // test introspection only
    _stop() { if (interval) clearInterval(interval); },
  };
}

// Singleton wiring for index.js.
let instance = null;
function initKpi(logger) {
  if (!instance) instance = createKpi(logger);
  return instance;
}

module.exports = { initKpi, createKpi };
