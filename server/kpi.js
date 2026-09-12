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
    // T-105 PostgreSQL dual-write mirror. `dualWriteFailure` doubles as the
    // "records needing reconciliation" signal for this process (each failure
    // also appends a durable line to dual-write-failures.jsonl).
    dualWriteAttempt: 0,
    dualWriteSuccess: 0,
    dualWriteFailure: 0,
    dualWriteRetryable: 0,
    // T-203 R2 upload mirror. `r2MirrorFailure` is the "uploads whose bytes are
    // not yet in R2" signal for this process; each failure also appends a
    // durable line to r2-mirror-failures.jsonl for reconciliation.
    r2MirrorAttempt: 0,
    r2MirrorSuccess: 0,
    r2MirrorFailure: 0,
    // T-304 cutover telemetry. The v1 counters are the numerator and
    // denominator of the acceptance criterion, so they are kept separate from
    // the legacy ones rather than pooled.
    uploadV1Attempt: 0,
    uploadV1Success: 0,
    uploadV1Failure: 0,
    uploadLegacyAttempt: 0,
    uploadLegacySuccess: 0,
    uploadLegacyFailure: 0,
    // A take that started toward v1 and finished on legacy. Counted in BOTH
    // uploadV1Failure and uploadLegacyAttempt: it is a v1 failure that the user
    // never saw, and hiding it would let the v1 success rate look perfect
    // precisely because the failures were rescued.
    uploadV1Fallback: 0,
    // Users selected by bucket whose PostgreSQL mirror is missing. Its own
    // counter so a known, fixable population is never invisible.
    rolloutAccountNotMigrated: 0,
    rolloutV1Selected: 0,
    rolloutLegacySelected: 0,
    // T-305 web single-PUT uploads. Kept SEPARATE from the pooled v1 counters
    // above so the extension's T-304 acceptance number is not moved by a
    // different client with a different risk profile. (They are also counted in
    // the pooled v1 counters, so the overall v1 rate stays a true total.)
    uploadV1SingleAttempt: 0,
    uploadV1SingleSuccess: 0,
    uploadV1SingleFailure: 0,
    webUploadV1Selected: 0,
    webUploadLegacySelected: 0,
    webUploadAccountNotMigrated: 0,
    // T-802: the watch page gate (per deployment; read by anonymous viewers).
    watchV1Selected: 0,
    watchLegacySelected: 0,
    // T-1302: the auth gate (per deployment; read by visitors on the public config).
    authV1Selected: 0,
    authLegacySelected: 0,
    // T-803: the library gate (dashboard / folders / notifications).
    libraryV1Selected: 0,
    libraryLegacySelected: 0,
    libraryAccountNotMigrated: 0,
    // T-1201: the editor gate (edit sessions / renders / silence removal).
    editorV1Selected: 0,
    editorLegacySelected: 0,
    editorAccountNotMigrated: 0,
    // T-305 deprecation signal: each use of the legacy memory-multer
    // POST /api/recordings/:id/replace. This number is what decides whether
    // Phase 14 may remove the route — zero over a full observation window.
    legacyReplaceUsed: 0,
    // T-1205: the legacy Cloudinary editing routes (trim / compose / stitch /
    // remove-silences) still in use. Their v1 replacements are the edit
    // sessions + render jobs (docs/14); removal is Phase 14, gated on zero.
    legacyTrimUsed: 0,
    legacyComposeUsed: 0,
    legacyStitchUsed: 0,
    legacySilenceUsed: 0,
    // T-403 recovery effectiveness (docs/19 §7): uploads the client tagged as a
    // RESUMED crashed take. successes / attempts is the KPI; the client-side
    // denominator (crash-interrupted sessions found at launch) is not visible
    // to the server and is reported by the extension's recovery card.
    recoveryAttempt: 0,
    recoverySuccess: 0,
    recoveryFailure: 0,
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
    // 'legacy' | 'v1'. Recorded on the attempt AND re-stated on the result, so
    // a take that changes path mid-flight is still attributed correctly.
    const uploadPath = meta.path === 'v1' ? 'v1' : 'legacy';
    // 'single' (T-305 web) | 'multipart' (T-303 extension) | null (legacy).
    const uploadMode = uploadPath === 'v1' ? (meta.mode === 'single' ? 'single' : 'multipart') : null;
    if (uploadPath === 'v1') counters.uploadV1Attempt++; else counters.uploadLegacyAttempt++;
    if (uploadMode === 'single') counters.uploadV1SingleAttempt++;
    const recovery = meta.recovery === true;
    if (recovery) counters.recoveryAttempt++;
    if (req) req._kpiUpload = { t0: Date.now(), done: false, store: meta.store || null, path: uploadPath, mode: uploadMode, recovery };
    logOf(req).info({
      kpi: 'upload_started', store: meta.store || null, sizeBytes: meta.sizeBytes ?? null,
      upload_path: uploadPath, upload_mode: uploadMode, fallback_from: meta.fallbackFrom || null,
      recovery,
    }, 'kpi: upload started');
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
    // The path is re-stated HERE, where the result is actually known — a take
    // that began toward v1 and finished on legacy must not be recorded as a v1
    // success just because that is how it started.
    const uploadPath = meta.path || (mark && mark.path) || 'legacy';
    const fallbackFrom = meta.fallbackFrom || null;
    const uploadMode = uploadPath === 'v1'
      ? ((meta.mode || (mark && mark.mode)) === 'single' ? 'single' : 'multipart') : null;
    const recovery = meta.recovery === true || !!(mark && mark.recovery);
    if (recovery) { if (outcome === 'success') counters.recoverySuccess++; else counters.recoveryFailure++; }
    if (uploadPath === 'v1') {
      if (outcome === 'success') counters.uploadV1Success++; else counters.uploadV1Failure++;
      if (uploadMode === 'single') {
        if (outcome === 'success') counters.uploadV1SingleSuccess++; else counters.uploadV1SingleFailure++;
      }
    } else {
      if (outcome === 'success') counters.uploadLegacySuccess++; else counters.uploadLegacyFailure++;
      // Landing on legacy after starting on v1 is a v1 FAILURE the user was
      // rescued from. Counting it keeps the v1 success rate honest.
      if (fallbackFrom === 'v1') {
        counters.uploadV1Fallback++;
        counters.uploadV1Failure++;
      }
    }

    logOf(req).info({
      kpi: 'upload_finished',
      outcome,
      code: meta.code || null,
      sizeBytes: meta.sizeBytes ?? null,
      durationMs,
      store: (mark && mark.store) || meta.store || null,
      upload_path: uploadPath,
      upload_mode: uploadMode,
      fallback_from: fallbackFrom,
      recovery,
    }, `kpi: upload ${outcome}`);
  }

  /**
   * One rollout decision, recorded where it is made. Deliberately carries NO
   * user identifier: the bucket and the reason are what an operator needs, and
   * the identity is neither needed nor safe to keep here.
   */
  function rolloutDecision(req, decision) {
    if (decision.decision === 'v1_rollout') counters.rolloutV1Selected++;
    else counters.rolloutLegacySelected++;
    if (decision.decision === 'account_not_migrated') counters.rolloutAccountNotMigrated++;
    logOf(req).info({
      kpi: 'rollout_decision',
      upload_path: decision.path,
      decision: decision.decision,
      bucket: decision.bucket,
      percent: decision.percent,
    }, `kpi: rollout ${decision.decision}`);
  }

  /**
   * T-305: one WEB upload gate decision. Its own line and its own counters —
   * never mixed into the extension rollout numbers, which have their own
   * acceptance criterion. No user identifier, no bucket (there is none).
   */
  function webUploadDecision(req, decision) {
    if (decision.path === 'v1') counters.webUploadV1Selected++;
    else counters.webUploadLegacySelected++;
    if (decision.decision === 'account_not_migrated') counters.webUploadAccountNotMigrated++;
    logOf(req).info({
      kpi: 'web_upload_decision',
      upload_path: decision.path,
      decision: decision.decision,
    }, `kpi: web upload ${decision.decision}`);
  }

  /**
   * T-802: one line per public client-config lookup for the watch page gate.
   * No user identifier (the route is anonymous by design).
   */
  function watchDecision(req, decision) {
    if (decision.path === 'v1') counters.watchV1Selected++;
    else counters.watchLegacySelected++;
    logOf(req).info({
      kpi: 'watch_decision',
      watch_path: decision.path,
      decision: decision.decision,
    }, `kpi: watch page ${decision.decision}`);
  }

  /** T-1201: one line per authed client-config lookup for the editor gate. */
  function editorDecision(req, decision) {
    if (decision.path === 'v1') counters.editorV1Selected++;
    else counters.editorLegacySelected++;
    if (decision.decision === 'account_not_migrated') counters.editorAccountNotMigrated++;
    logOf(req).info({
      kpi: 'editor_decision',
      editor_path: decision.path,
      decision: decision.decision,
    }, `kpi: editor ${decision.decision}`);
  }

  /** T-1302: one line per public client-config lookup for the auth gate. */
  function authDecision(req, decision) {
    if (decision.path === 'v1') counters.authV1Selected++;
    else counters.authLegacySelected++;
    logOf(req).info({ kpi: 'auth_decision', auth_path: decision.path, decision: decision.decision }, `kpi: auth ${decision.decision}`);
  }

  /** T-803: one line per authed client-config lookup for the library gate. */
  function libraryDecision(req, decision) {
    if (decision.path === 'v1') counters.libraryV1Selected++;
    else counters.libraryLegacySelected++;
    if (decision.decision === 'account_not_migrated') counters.libraryAccountNotMigrated++;
    logOf(req).info({
      kpi: 'library_decision',
      library_path: decision.path,
      decision: decision.decision,
    }, `kpi: library ${decision.decision}`);
  }

  /**
   * T-305: the legacy memory-multer replace route was used. DEPRECATED, not
   * removed — this counter and this line are how remaining traffic is
   * measured, and Phase 14 may delete the route only once they stay at zero
   * over a full observation window. Only sizes and the mode are recorded.
   */
  /**
   * T-1205: a legacy Cloudinary editing route was used (trim / compose /
   * stitch / remove-silences). DEPRECATED, not removed — aliasing them onto
   * edit sessions is impossible while an account may be unmirrored, so the
   * routes stay byte-identical for the legacy path and every use is measured.
   * Phase 14 may delete them only once these counters stay at zero over a
   * full observation window. Only the mode and clip count are recorded.
   */
  const LEGACY_EDITING = {
    trim: { counter: 'legacyTrimUsed', route: 'POST /api/recordings/:id/trim', replacement: 'v1 edit session → render (docs/08 §11)' },
    compose: { counter: 'legacyComposeUsed', route: 'POST /api/recordings/:id/compose', replacement: 'v1 edit session → render (docs/08 §11)' },
    stitch: { counter: 'legacyStitchUsed', route: 'POST /api/recordings/stitch', replacement: 'POST /api/v1/recordings/stitch (docs/08 §11)' },
    silence: { counter: 'legacySilenceUsed', route: 'POST /api/recordings/:id/remove-silences', replacement: 'v1 silence_detect job (docs/08 §11)' },
  };
  function legacyEditingUsed(req, { route, mode = null, clips = null } = {}) {
    const spec = LEGACY_EDITING[route];
    if (!spec) return;
    counters[spec.counter]++;
    logOf(req).warn({
      kpi: 'deprecated_editing_used',
      deprecated: true,
      route: spec.route,
      replacement: spec.replacement,
      removal: 'Phase 14',
      mode, clips,
    }, `kpi: deprecated ${spec.route} used`);
  }

  function legacyReplaceUsed(req, meta = {}) {
    counters.legacyReplaceUsed++;
    logOf(req).warn({
      kpi: 'deprecated_replace_used',
      deprecated: true,
      route: 'POST /api/recordings/:id/replace',
      replacement: 'v1 single-PUT upload (docs/06 §12)',
      removal: 'Phase 14',
      sizeBytes: meta.sizeBytes ?? null,
      mode: meta.mode || null,
    }, 'kpi: DEPRECATED memory-multer replace route used');
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
      dualWrite: {
        attempts: counters.dualWriteAttempt,
        successRatePct: counters.dualWriteAttempt
          ? +((counters.dualWriteSuccess / counters.dualWriteAttempt) * 100).toFixed(2) : null,
        failures: counters.dualWriteFailure,
        retryableFailures: counters.dualWriteRetryable,
        reconciliationPending: counters.dualWriteFailure,   // journaled for repair
      },
      // T-304 acceptance. successRatePct is exactly the number the ≥99%
      // criterion is measured against, and its denominator INCLUDES fallbacks,
      // so rescuing a failure onto legacy cannot inflate it.
      cutover: {
        rolloutPercent: Number(process.env.V1_UPLOAD_ROLLOUT_PERCENT || 0) || 0,
        v1Attempts: counters.uploadV1Attempt,
        v1Successes: counters.uploadV1Success,
        v1Failures: counters.uploadV1Failure,
        v1Fallbacks: counters.uploadV1Fallback,
        v1SuccessRatePct: counters.uploadV1Attempt
          ? +((counters.uploadV1Success / counters.uploadV1Attempt) * 100).toFixed(2) : null,
        legacyAttempts: counters.uploadLegacyAttempt,
        legacySuccesses: counters.uploadLegacySuccess,
        legacyFailures: counters.uploadLegacyFailure,
        accountNotMigrated: counters.rolloutAccountNotMigrated,
        // T-305: the web single-PUT slice of the v1 numbers above, reported
        // separately so the extension gate is not judged on web traffic.
        web: {
          enabled: process.env.V1_WEB_UPLOAD === 'true',
          singleAttempts: counters.uploadV1SingleAttempt,
          singleSuccesses: counters.uploadV1SingleSuccess,
          singleFailures: counters.uploadV1SingleFailure,
          singleSuccessRatePct: counters.uploadV1SingleAttempt
            ? +((counters.uploadV1SingleSuccess / counters.uploadV1SingleAttempt) * 100).toFixed(2) : null,
          accountNotMigrated: counters.webUploadAccountNotMigrated,
        },
        // T-802: the watch page gate — how many config lookups were told v1 vs legacy.
        watchPage: {
          enabled: process.env.V1_WATCH_PAGE === 'true' && process.env.V1_UPLOAD_API === 'true',
          v1Selected: counters.watchV1Selected,
          legacySelected: counters.watchLegacySelected,
        },
        // T-1302: the auth gate.
        auth: {
          enabled: process.env.V1_AUTH === 'true' && process.env.V1_UPLOAD_API === 'true',
          v1Selected: counters.authV1Selected,
          legacySelected: counters.authLegacySelected,
        },
        // T-803: the library gate.
        library: {
          enabled: process.env.V1_LIBRARY === 'true' && process.env.V1_UPLOAD_API === 'true',
          v1Selected: counters.libraryV1Selected,
          legacySelected: counters.libraryLegacySelected,
          accountNotMigrated: counters.libraryAccountNotMigrated,
        },
        // T-1201: the editor gate.
        editor: {
          enabled: process.env.V1_EDITOR === 'true' && process.env.V1_UPLOAD_API === 'true',
          v1Selected: counters.editorV1Selected,
          legacySelected: counters.editorLegacySelected,
          accountNotMigrated: counters.editorAccountNotMigrated,
        },
      },
      // T-305: deprecated routes still in use. Phase 14 removal is gated on
      // these staying at zero.
      deprecations: {
        legacyReplaceUsed: counters.legacyReplaceUsed,
        // T-1205: the legacy editing routes (the Phase 14 gate for docs/14's legacy handlers).
        legacyTrimUsed: counters.legacyTrimUsed,
        legacyComposeUsed: counters.legacyComposeUsed,
        legacyStitchUsed: counters.legacyStitchUsed,
        legacySilenceUsed: counters.legacySilenceUsed,
      },
      // T-403: recovery effectiveness (docs/19 §7 — target ≥ 90%).
      recovery: {
        attempts: counters.recoveryAttempt,
        successes: counters.recoverySuccess,
        failures: counters.recoveryFailure,
        effectivenessPct: counters.recoveryAttempt
          ? +((counters.recoverySuccess / counters.recoveryAttempt) * 100).toFixed(2) : null,
      },
      r2Mirror: {
        attempts: counters.r2MirrorAttempt,
        // The acceptance criterion for T-203 is "100% of new uploads mirrored",
        // so this ratio is the number that decides it.
        mirroredRatePct: counters.r2MirrorAttempt
          ? +((counters.r2MirrorSuccess / counters.r2MirrorAttempt) * 100).toFixed(2) : null,
        failures: counters.r2MirrorFailure,
        reconciliationPending: counters.r2MirrorFailure,
      },
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
    uploadStarted, uploadFinished, rolloutDecision, webUploadDecision, watchDecision, authDecision, libraryDecision, editorDecision, legacyReplaceUsed, legacyEditingUsed,
    watchMiss, watchHit, requestError, snapshot,
    counters,                                  // mutated by the dual-write mirror
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
