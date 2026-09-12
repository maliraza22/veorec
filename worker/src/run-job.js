// The job runner: one place turns a transport delivery into the row lifecycle
// of docs/10 §4 — queued → active → completed | failed — and classifies
// failures per docs/18 §6. Every processor runs through it, whatever the
// transport (BullMQ, inline), so the row is always the truth:
//
//   • the row is read first; a job whose row is already completed/cancelled is
//     skipped ("check before do", docs/10 §1 — a stalled re-delivery of a job
//     that finished is a no-op, never a second run);
//   • `attempts` counts RUNS (a stalled re-run counts), so a job can never run
//     more than `max_attempts` times whatever the transport believes;
//   • a processor gets an AbortSignal that fires on timeout and on shutdown,
//     so an ffmpeg child can be killed rather than orphaned;
//   • a terminal failure (TerminalError, or attempts exhausted) sets
//     status='failed' and tells the transport not to retry (`unrecoverable`);
//     anything else keeps status='queued' with last_error and lets the
//     transport back off and retry.
'use strict';

const { specFor } = require('./catalog');
const { TransientError, DeferredError, isTerminal, formatError } = require('./errors');
const { silentLogger } = require('./logger');

const REASON = 'T-601 worker: processing_jobs lifecycle (queued → active → completed | failed)';

function createJobRunner({ repositories, registry, logger = silentLogger(), deps = {}, now = () => Date.now(), deferMs = 5000 }) {
  if (typeof repositories !== 'function') throw new Error('createJobRunner: repositories() is required');
  if (!registry) throw new Error('createJobRunner: registry is required');

  const inflight = new Map();   // job id → AbortController (shutdown aborts them)

  // Post-settlement hook (registry opts.onSettled): runs after the row is
  // marked completed/failed, never throws into the lifecycle.
  async function settle(proc, ctx) {
    if (!proc || !proc.onSettled) return;
    try { await proc.onSettled(ctx); }
    catch (e) { ctx.logger.warn({ err: { message: e && e.message } }, 'onSettled hook failed'); }
  }

  async function runJob({ id, type, payload, attemptsMade }) {
    const repos = repositories();
    specFor(type);
    const row = await repos.jobs.getSystem(id, REASON);
    const base = logger.child ? logger.child({ job_id: id, queue: type }) : logger;
    if (!row) {
      base.warn({ transport_attempt: attemptsMade }, 'job has no processing_jobs row — transport-only delivery ignored');
      return { skipped: 'missing_row' };
    }
    const jobLogger = row.recordingId && base.child ? base.child({ recording_id: row.recordingId }) : base;
    if (row.status === 'completed' || row.status === 'cancelled') {
      jobLogger.info({ status: row.status }, 'job already settled — delivery skipped (idempotent)');
      return { skipped: row.status };
    }
    const proc = registry.get(type);
    if (!proc) {
      // Not this worker's job (a rolling deploy: an older worker shares the
      // queue). The row is untouched and NO attempt is consumed; the delivery
      // goes back to the transport for a worker that has the processor.
      jobLogger.warn({ defer_ms: deferMs }, 'no processor registered for this job type — delivery deferred');
      throw new DeferredError('no_processor', `no processor for "${type}" in this worker`, { deferMs });
    }

    const active = await repos.jobs.markActiveSystem(id, REASON);
    if (active.attempts > active.maxAttempts) {
      await repos.jobs.markFailedSystem(id, `attempts exhausted (${active.attempts} runs > max ${active.maxAttempts})`, REASON, { terminal: true });
      jobLogger.error({ attempts: active.attempts, max_attempts: active.maxAttempts }, 'job failed (terminal): attempts exhausted');
      const err = new Error('attempts exhausted'); err.unrecoverable = true; throw err;
    }

    const started = now();
    const ac = new AbortController();
    inflight.set(id, ac);
    let timer = null;
    const timeoutMs = proc.timeoutMs;
    jobLogger.info({ attempt: active.attempts, max_attempts: active.maxAttempts, timeout_ms: timeoutMs }, 'job started');
    try {
      const result = await Promise.race([
        proc.handler({ payload: active.payload || payload || {}, job: active, signal: ac.signal, logger: jobLogger, deps, repositories }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            ac.abort();
            reject(new TransientError('job_timeout', `job exceeded its ${timeoutMs} ms timeout`));
          }, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      inflight.delete(id);
      await repos.jobs.markCompletedSystem(id, result === undefined ? null : result, REASON);
      jobLogger.info({ attempt: active.attempts, duration_ms: now() - started }, 'job completed');
      await settle(proc, { status: 'completed', job: active, result, repositories, deps, logger: jobLogger });
      return result;
    } catch (err) {
      clearTimeout(timer);
      inflight.delete(id);
      const terminal = isTerminal(err) || active.attempts >= active.maxAttempts;
      await repos.jobs.markFailedSystem(id, formatError(err), REASON, { terminal });
      const fields = { attempt: active.attempts, max_attempts: active.maxAttempts, duration_ms: now() - started, code: err && err.code, err: { message: err && err.message }, terminal };
      if (terminal) jobLogger.error(fields, 'job failed (terminal)');
      else jobLogger.warn(fields, 'job failed — will retry with backoff');
      if (terminal) await settle(proc, { status: 'failed', job: active, error: err, repositories, deps, logger: jobLogger });
      if (terminal) { const e = new Error(err && err.message ? err.message : 'job failed'); e.unrecoverable = true; e.cause = err; throw e; }
      throw err;
    }
  }

  /** Stalled beyond the transport's limit (BullMQ maxStalledCount): the row must not stay `active`. */
  async function onTransportFailed({ id, type, error }) {
    if (!id) return;
    const repos = repositories();
    const row = await repos.jobs.getSystem(id, REASON);
    if (!row || row.status !== 'active') return;
    const msg = error && error.message ? error.message : 'transport failure';
    if (!/stalled/i.test(msg)) return;
    await repos.jobs.markFailedSystem(id, `stalled: ${msg}`, REASON, { terminal: true });
    logger.error({ job_id: id, queue: type, err: { message: msg } }, 'job failed (terminal): stalled beyond the allowed limit');
  }

  /** Shutdown: abort every processor still running (docs/10 §2 graceful shutdown). */
  function abortAll(reason = 'shutdown') {
    for (const [id, ac] of inflight) { try { ac.abort(reason); } catch { /* ignore */ } inflight.delete(id); }
  }

  return { runJob, onTransportFailed, abortAll, inflightCount: () => inflight.size, REASON };
}

module.exports = { createJobRunner, REASON };
