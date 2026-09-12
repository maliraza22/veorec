// T-601 JobQueue / runner / registry / worker-app tests (run: cd worker && npm run test:queue)
//
// A–F need no infrastructure (config, catalog, errors, registry, the runner
// against an in-memory repository, the inline queue). G–H drive the BullMQ
// adapter and the worker app against a REAL Redis and SKIP LOUDLY without one;
// QUEUE_TESTS_REQUIRED=1 turns that skip into a failure.
'use strict';

const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const W = require(path.join(ROOT, 'worker', 'src', 'index.js'));
const { QUEUES: SCHEMA_QUEUES } = require(path.join(ROOT, 'db', 'src', 'schema', 'jobs.js'));
const IORedis = require(path.join(ROOT, 'worker', 'node_modules', 'ioredis'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.QUEUE_TESTS_REQUIRED === '1';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6380';
const RUN = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silent = W.silentLogger();

// In-memory processing_jobs with the repository's exact lifecycle semantics.
function fakeRepos() {
  const rows = new Map();
  let n = 0;
  const jobs = {
    async enqueue({ queue, dedupeKey, recordingId = null, payload = {}, maxAttempts = 3 }) {
      for (const r of rows.values()) if (r.dedupeKey === dedupeKey) return { job: r, created: false };
      const row = { id: `job_${RUN}${(n += 1)}`, queue, dedupeKey, recordingId, payload, maxAttempts, status: 'queued', attempts: 0, lastError: null, result: null, enqueuedAt: null, startedAt: null, finishedAt: null, createdAt: new Date() };
      rows.set(row.id, row); return { job: row, created: true };
    },
    async getSystem(id) { return rows.get(id) || null; },
    async listUnenqueuedSystem() { return Array.from(rows.values()).filter((r) => r.status === 'queued' && !r.enqueuedAt); },
    async listStaleQueuedSystem({ before }) { return Array.from(rows.values()).filter((r) => r.status === 'queued' && r.enqueuedAt && r.enqueuedAt <= before); },
    async listStaleActiveSystem({ before }) { return Array.from(rows.values()).filter((r) => r.status === 'active' && r.startedAt && r.startedAt <= before); },
    async markEnqueuedSystem(id) { const r = rows.get(id); r.enqueuedAt = new Date(); return r; },
    async markActiveSystem(id) { const r = rows.get(id); if (!r) throw new Error('not found'); r.status = 'active'; r.startedAt = new Date(); r.attempts += 1; return { ...r }; },
    async markCompletedSystem(id, result) { const r = rows.get(id); r.status = 'completed'; r.result = result; r.finishedAt = new Date(); r.lastError = null; return r; },
    async markFailedSystem(id, error, reason, { terminal = false } = {}) { const r = rows.get(id); r.status = terminal ? 'failed' : 'queued'; r.lastError = String(error).slice(0, 4000); r.finishedAt = terminal ? new Date() : null; return r; },
    async requeueSystem(id, reason, { resetAttempts = false, fromStatuses = ['failed', 'active'] } = {}) { const r = rows.get(id); if (!r || !fromStatuses.includes(r.status)) return null; Object.assign(r, { status: 'queued', enqueuedAt: null, startedAt: null, finishedAt: null }); if (resetAttempts) r.attempts = 0; return r; },
  };
  return { repositories: () => ({ jobs }), rows, jobs };
}

(async () => {
  console.log('T-601 JobQueue / runner / worker-app tests');

  // ── A. Configuration ───────────────────────────────────────────────────────
  console.log('\nA. Configuration');
  {
    const c = W.loadWorkerConfig({}, { appEnv: 'local' });
    ok(c.redisUrl === 'redis://127.0.0.1:6380' && c.prefix === 'veorec' && c.inline === false, 'local defaults: docker-compose Redis port, veorec prefix, inline off');
    ok(c.outboxIntervalMs === 500 && c.reconcileIntervalMs === 60000 && c.reconcileMinAgeMs === 300000 && c.stalledIntervalMs === 60000, 'docs/10 §2 cadences: 500 ms relay, 60 s stalled check');
    let threw = null; try { W.loadWorkerConfig({}, { appEnv: 'production' }); } catch (e) { threw = e; }
    ok(threw && threw.code === 'worker_config_error' && /REDIS_URL is required/.test(threw.message), 'production has NO Redis default — fails fast');
    threw = null; try { W.loadWorkerConfig({ REDIS_URL: 'http://x' }, { appEnv: 'local' }); } catch (e) { threw = e; }
    ok(threw && /redis:\/\//.test(threw.message), 'a non-redis URL is refused');
    threw = null; try { W.loadWorkerConfig({ APP_ENV: 'prod' }); } catch (e) { threw = e; }
    ok(threw && /APP_ENV must be one of/.test(threw.message), 'an unknown APP_ENV is refused');
    for (const v of ['TRUE', '1', 'yes', ' true']) ok(W.loadWorkerConfig({ QUEUE_INLINE: v }, { appEnv: 'test' }).inline === false, `QUEUE_INLINE=${JSON.stringify(v)} does not enable inline mode`);
    ok(W.loadWorkerConfig({ QUEUE_INLINE: 'true' }, { appEnv: 'test' }).inline === true, 'only the literal "true" enables inline mode');
    threw = null; try { W.loadWorkerConfig({ OUTBOX_INTERVAL_MS: '1e3' }, { appEnv: 'test' }); } catch (e) { threw = e; }
    ok(threw && /plain non-negative integer/.test(threw.message), 'numeric settings accept plain decimal integers only');
    ok(W.loadWorkerConfig({ WORKER_CONCURRENCY: '0' }, { appEnv: 'test' }).concurrency === 2, 'a value under the minimum falls back to the default');
    ok(W.redactRedisUrl('redis://user:s3cret@host:6380/0') === 'redis://user:[REDACTED]@host:6380/0', 'the password never reaches a log line');
    ok(W.redactRedisUrl('nonsense') === '[invalid-url]', 'an unparsable URL is not echoed');
  }

  // ── B. Catalog ─────────────────────────────────────────────────────────────
  console.log('\nB. Catalog');
  {
    const types = Object.keys(W.JOB_TYPES);
    ok(SCHEMA_QUEUES.every((t) => types.includes(t)) && types.every((t) => SCHEMA_QUEUES.includes(t)), 'the catalog and the processing_jobs CHECK constraint list exactly the same job types');
    ok(types.every((t) => W.QUEUES.includes(W.JOB_TYPES[t].queue)), 'every type routes to one of the docs/10 §2 BullMQ queues');
    ok(W.JOB_TYPES.probe.attempts === 5 && W.JOB_TYPES.transcode.attempts === 3 && W.JOB_TYPES.translate.attempts === 2 && W.JOB_TYPES.email.attempts === 5, 'retry budgets follow docs/10 §3');
    ok(W.JOB_TYPES.transcribe.queue === 'stt' && W.QUEUE_CONCURRENCY.stt === 1, 'stt is its own queue with concurrency 1');
    ok(W.JOB_TYPES.usage_sync.queue === 'maintenance' && W.JOB_TYPES.upload_expiry.queue === 'maintenance', 'maintenance jobs share the maintenance queue');
    let threw = null; try { W.specFor('noop'); } catch (e) { threw = e; }
    ok(threw && threw.code === 'unknown_job_type' && threw.retryable === false, 'an unknown type is a terminal error');
    const lo = W.backoffMs(1, () => 0), hi = W.backoffMs(1, () => 0.999999);
    ok(lo === 0 && hi >= 4999 && hi < 5000, 'attempt 1: full jitter over [0, 5 s)');
    ok(W.backoffMs(2, () => 0.999999) < 15000 && W.backoffMs(2, () => 0.999999) >= 14999, 'attempt 2: ceiling 5 s × 3');
    ok(W.backoffMs(3, () => 0.999999) < 45000 && W.backoffMs(3, () => 0.999999) >= 44999, 'attempt 3: ceiling 45 s');
    ok(W.backoffMs(20, () => 0.999999) < 3600000, 'the ceiling is capped at one hour');
    ok(W.backoffMs(undefined, () => 0.5) === 2500 && W.backoffMs(0, () => 0.5) === 2500, 'a missing/zero attempt counts as the first');
    const samples = new Set(); for (let i = 0; i < 50; i += 1) samples.add(W.backoffMs(1)); ok(samples.size > 10, 'real jitter is random');
  }

  // ── C. Errors ──────────────────────────────────────────────────────────────
  console.log('\nC. Error model (docs/18 §6)');
  {
    const t = new W.TransientError('rate_limited', 'slow down'), d = new W.TerminalError('corrupt_input', 'bad file', { stderrTail: 'x'.repeat(5000) });
    ok(t.retryable === true && !W.isTerminal(t) && t.name === 'TransientError', 'TransientError retries');
    ok(d.retryable === false && W.isTerminal(d) && d.stderrTail.length === 2048, 'TerminalError does not retry; the stderr tail is capped at 2 KB');
    ok(!W.isTerminal(new Error('boom')) && !W.isTerminal(null), 'an unknown exception is transient');
    const txt = W.formatError(d);
    ok(txt.startsWith('corrupt_input: bad file') && /stderr tail/.test(txt) && txt.length <= 4000, 'last_error = code: message + stderr tail, ≤ 4000 chars');
    ok(W.formatError(new Error('plain')) === 'plain' && W.formatError(null) === 'unknown error', 'plain errors and nulls format safely');
    const e = new W.JobError('x', 'y'); ok(e.retryable === true, 'JobError defaults to retryable');
  }

  // ── D. Registry ────────────────────────────────────────────────────────────
  console.log('\nD. Processor registry');
  {
    const reg = W.createRegistry();
    let threw = null; try { reg.register('noop', async () => {}); } catch (e) { threw = e; }
    ok(threw && threw.code === 'unknown_job_type', 'only catalog types can be registered');
    threw = null; try { reg.register('probe', 'nope'); } catch (e) { threw = e; }
    ok(threw && /handler must be a function/.test(threw.message), 'a handler must be a function');
    const off = reg.register('probe', async () => 1, { timeoutMs: 123 });
    reg.register('transcribe', async () => 2);
    threw = null; try { reg.register('probe', async () => 3); } catch (e) { threw = e; }
    ok(threw && /already registered/.test(threw.message), 'double registration is refused');
    ok(reg.get('probe').timeoutMs === 123 && reg.get('transcribe').timeoutMs === W.JOB_TYPES.transcribe.timeoutMs, 'a timeout override wins; otherwise the catalog timeout');
    ok(reg.queues().sort().join() === 'media,stt' && reg.types().join() === 'probe,transcribe', 'queues() is derived from the registered types');
    ok(reg.missing().includes('transcode') && !reg.missing().includes('probe'), 'missing() lists the catalog types without a processor');
    off(); ok(!reg.has('probe') && reg.queues().join() === 'stt', 'unregistering removes the type and its queue');
    const shipped = W.createDefaultRegistry({ logger: silent });
    ok(shipped.types().sort().join() === 'ai_chapters,ai_summary,ai_title,audio_extract,captions,cleanup,hls,probe,render,silence_detect,thumbnail,transcode,transcribe,translate,upload_expiry,usage_sync' && shipped.queues().sort().join() === 'ai,maintenance,media,render,stt', 'the shipped registry carries the T-602 maintenance, T-603 stt/ai, T-701–T-705 media and T-1202/T-1204 editing processors');
    const bare = W.createDefaultRegistry({ logger: silent, maintenance: false, stt: false, media: false, editing: false });
    ok(bare.types().length === 0 && bare.queues().length === 0, 'maintenance:false yields the empty T-601 registry');
  }

  // ── E. Runner against an in-memory repository ──────────────────────────────
  console.log('\nE. Job runner: row lifecycle and failure classification');
  {
    const { repositories, rows, jobs } = fakeRepos();
    const reg = W.createRegistry();
    const calls = [];
    reg.register('probe', async ({ payload, job, signal, logger, deps }) => { calls.push({ payload, id: job.id, attempt: job.attempts, hasSignal: signal instanceof AbortSignal, hasLogger: !!logger, deps }); return { probed: payload.storageKey }; });
    let failMode = 'transient';
    reg.register('transcode', async () => {
      if (failMode === 'transient') throw new W.TransientError('ffmpeg_exit', 'exit 1', { stderrTail: 'tail' });
      if (failMode === 'terminal') throw new W.TerminalError('corrupt_input', 'bad');
      if (failMode === 'plain') throw new Error('plain boom');
      return 'ok';
    });
    let aborted = false;
    reg.register('thumbnail', async ({ signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }); }), { timeoutMs: 40 });
    const lines = [];
    const cap = { info: (o, m) => lines.push({ level: 'info', o, m }), warn: (o, m) => lines.push({ level: 'warn', o, m }), error: (o, m) => lines.push({ level: 'error', o, m }), debug() {}, child(b) { return { ...cap, bindings: b, child: (b2) => cap.child({ ...b, ...b2 }) }; } };
    const runner = W.createJobRunner({ repositories, registry: reg, logger: cap, deps: { storage: 'S' } });

    const miss = await runner.runJob({ id: 'job_missing', type: 'probe', payload: {} });
    ok(miss.skipped === 'missing_row' && calls.length === 0, 'a transport delivery with no row is ignored, never run');

    const { job: p } = await jobs.enqueue({ queue: 'probe', dedupeKey: `probe:${RUN}`, recordingId: 'rec_1', payload: { storageKey: 'sources/x' } });
    const r = await runner.runJob({ id: p.id, type: 'probe', payload: { storageKey: 'TRANSPORT-COPY' } });
    const row = rows.get(p.id);
    ok(r.probed === 'sources/x' && calls[0].payload.storageKey === 'sources/x', 'the ROW payload is authoritative over the transport copy');
    ok(row.status === 'completed' && row.attempts === 1 && row.startedAt && row.finishedAt && row.result.probed === 'sources/x' && row.lastError === null, 'success: queued → active → completed with started/finished/result');
    ok(calls[0].hasSignal && calls[0].hasLogger && calls[0].deps.storage === 'S' && calls[0].attempt === 1, 'a processor receives signal, logger, deps and the active row');
    const started = lines.find((l) => l.m === 'job started'), done = lines.find((l) => l.m === 'job completed');
    ok(started && done && typeof done.o.duration_ms === 'number' && done.o.attempt === 1, 'start/finish lines carry attempt and duration (docs/19 §2)');
    const again = await runner.runJob({ id: p.id, type: 'probe', payload: {} });
    ok(again.skipped === 'completed' && calls.length === 1 && row.attempts === 1, 'a re-delivery of a completed job is skipped — idempotent, no second run');

    const { job: t } = await jobs.enqueue({ queue: 'transcode', dedupeKey: `transcode:${RUN}`, maxAttempts: 3 });
    let thrown = null; try { await runner.runJob({ id: t.id, type: 'transcode', payload: {} }); } catch (e) { thrown = e; }
    let trow = rows.get(t.id);
    ok(thrown && !thrown.unrecoverable && trow.status === 'queued' && trow.attempts === 1 && /ffmpeg_exit: exit 1/.test(trow.lastError) && /stderr tail/.test(trow.lastError), 'transient failure: status stays queued, last_error recorded, transport told to retry');
    failMode = 'plain';
    thrown = null; try { await runner.runJob({ id: t.id, type: 'transcode', payload: {} }); } catch (e) { thrown = e; }
    ok(thrown && !thrown.unrecoverable && rows.get(t.id).attempts === 2 && rows.get(t.id).lastError === 'plain boom', 'an unclassified exception is transient too');
    thrown = null; try { await runner.runJob({ id: t.id, type: 'transcode', payload: {} }); } catch (e) { thrown = e; }
    trow = rows.get(t.id);
    ok(thrown && thrown.unrecoverable === true && trow.status === 'failed' && trow.attempts === 3 && trow.finishedAt, 'the last allowed attempt failing is terminal: status failed, transport told not to retry');
    ok(lines.some((l) => l.level === 'error' && l.m === 'job failed (terminal)') && lines.some((l) => l.level === 'warn' && /will retry/.test(l.m)), 'terminal failures log at error, retried ones at warn');

    failMode = 'terminal';
    const { job: t2 } = await jobs.enqueue({ queue: 'transcode', dedupeKey: `transcode2:${RUN}`, maxAttempts: 3 });
    thrown = null; try { await runner.runJob({ id: t2.id, type: 'transcode', payload: {} }); } catch (e) { thrown = e; }
    ok(thrown && thrown.unrecoverable && rows.get(t2.id).status === 'failed' && rows.get(t2.id).attempts === 1 && rows.get(t2.id).lastError === 'corrupt_input: bad', 'a TerminalError fails fast on the first attempt');

    const { job: t3 } = await jobs.enqueue({ queue: 'transcode', dedupeKey: `transcode3:${RUN}`, maxAttempts: 2 });
    rows.get(t3.id).attempts = 2;   // two stalled re-runs already counted
    failMode = 'ok';
    thrown = null; try { await runner.runJob({ id: t3.id, type: 'transcode', payload: {} }); } catch (e) { thrown = e; }
    ok(thrown && thrown.unrecoverable && rows.get(t3.id).status === 'failed' && /attempts exhausted/.test(rows.get(t3.id).lastError), 'runs beyond max_attempts (stalled re-deliveries) fail without running the processor');

    const { job: th } = await jobs.enqueue({ queue: 'thumbnail', dedupeKey: `thumb:${RUN}` });
    thrown = null; try { await runner.runJob({ id: th.id, type: 'thumbnail', payload: {} }); } catch (e) { thrown = e; }
    ok(thrown && thrown.code === 'job_timeout' && aborted && rows.get(th.id).status === 'queued' && /job_timeout/.test(rows.get(th.id).lastError), 'a timeout aborts the processor via its signal and counts as a transient failure');

    const { job: np } = await jobs.enqueue({ queue: 'hls', dedupeKey: `hls:${RUN}` });
    thrown = null; try { await runner.runJob({ id: np.id, type: 'hls', payload: {} }); } catch (e) { thrown = e; }
    ok(thrown && thrown.code === 'no_processor' && thrown.defer === true && thrown.deferMs === 5000 && !thrown.unrecoverable, 'a type without a processor here is DEFERRED back to the transport (rolling deploys), never failed');
    ok(rows.get(np.id).status === 'queued' && rows.get(np.id).attempts === 0 && rows.get(np.id).lastError === null, 'the row is untouched — no attempt consumed');

    const { job: st } = await jobs.enqueue({ queue: 'probe', dedupeKey: `stalled:${RUN}` });
    await jobs.markActiveSystem(st.id);
    await runner.onTransportFailed({ id: st.id, type: 'probe', error: new Error('job stalled more than allowable limit') });
    ok(rows.get(st.id).status === 'failed' && /stalled/.test(rows.get(st.id).lastError), 'a job the transport gave up on (stalled limit) is marked failed');
    const { job: st2 } = await jobs.enqueue({ queue: 'probe', dedupeKey: `stalled2:${RUN}` });
    await jobs.markActiveSystem(st2.id);
    await runner.onTransportFailed({ id: st2.id, type: 'probe', error: new Error('some other failure') });
    ok(rows.get(st2.id).status === 'active', 'other transport failure events do not touch the row (the runner already recorded them)');
    await runner.onTransportFailed({ id: null });
    ok(true, 'a failure event without an id is ignored');

    let sig = null;
    reg.register('hls', async ({ signal }) => new Promise((_, rej) => { sig = signal; signal.addEventListener('abort', () => rej(new Error('shutdown'))); }));
    const pr = runner.runJob({ id: np.id, type: 'hls', payload: {} }).catch((e) => e);
    await sleep(10);
    ok(runner.inflightCount() === 1, 'an in-flight job is tracked');
    runner.abortAll('shutdown');
    const res = await pr;
    ok(sig.aborted && res instanceof Error && runner.inflightCount() === 0, 'abortAll() fires every in-flight signal (graceful shutdown deadline)');
  }

  // ── F. Inline queue ────────────────────────────────────────────────────────
  console.log('\nF. Inline JobQueue (QUEUE_INLINE)');
  {
    const q = W.createInlineJobQueue({ logger: silent });
    W.assertJobQueue(q);
    let threw = null; try { W.assertJobQueue({ enqueue() {} }); } catch (e) { threw = e; }
    ok(threw && threw.code === 'invalid_job_queue', 'assertJobQueue rejects an incomplete implementation');
    const seen = [];
    let fails = 2;
    q.subscribe('media', async (job) => { seen.push(`${job.type}:${job.attemptsMade}`); if (job.type === 'transcode' && fails-- > 0) throw new Error('again'); if (job.type === 'thumbnail') { const e = new Error('fatal'); e.unrecoverable = true; throw e; } });
    const a = await q.enqueue({ id: 'job_i1', type: 'probe', payload: {} });
    const b = await q.enqueue({ id: 'job_i1', type: 'probe', payload: {} });
    ok(a.created && !b.created && (await q.has('job_i1')), 'a duplicate enqueue while pending is a no-op; has() is true while pending');
    await q.enqueue({ id: 'job_i2', type: 'transcode', payload: {}, attempts: 3 });
    await q.enqueue({ id: 'job_i3', type: 'thumbnail', payload: {} });
    await q.enqueue({ id: 'job_i4', type: 'transcribe', payload: {} });   // stt: nobody subscribed
    await q.drain();
    ok(seen.join(' ') === 'probe:0 transcode:0 transcode:1 transcode:2 thumbnail:0', 'jobs run in order; transient failures retry immediately up to attempts; unrecoverable stops');
    ok(!(await q.has('job_i1')) && q.runs.filter((r) => r.id === 'job_i2').map((r) => r.outcome).join() === 'failed,failed,completed', 'the run log records each attempt and outcome');
    ok(q.runs.find((r) => r.id === 'job_i3').outcome === 'unrecoverable', 'an unrecoverable rejection is recorded as such');
    threw = null; try { await q.enqueue({ id: 'job_x', type: 'nope' }); } catch (e) { threw = e; }
    ok(threw && threw.code === 'unknown_job_type', 'an unknown type is refused at enqueue');
    await q.close();
    threw = null; try { await q.enqueue({ id: 'job_y', type: 'probe' }); } catch (e) { threw = e; }
    ok(threw && /closed/.test(threw.message), 'a closed queue refuses work');
  }

  // ── G/H. Real Redis ────────────────────────────────────────────────────────
  let redisUp = false;
  try { const c = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 1500, lazyConnect: true }); await c.connect(); redisUp = (await c.ping()) === 'PONG'; await c.quit(); } catch {}
  if (!redisUp) {
    console.log(`\n  SKIPPED G–H — no Redis at ${REDIS_URL}`);
    if (REQUIRED) { fail += 1; console.log('  FAIL: QUEUE_TESTS_REQUIRED=1 but Redis is unavailable'); }
  } else {
    console.log('\nG. BullMQ adapter against real Redis');
    const prefix = `t601q${RUN}`;
    const q = W.createBullJobQueue({ redisUrl: REDIS_URL, prefix, logger: silent, backoff: () => 20, stalledIntervalMs: 500, lockDurationMs: 1000 });
    W.assertJobQueue(q);
    try {
      const a = await q.enqueue({ id: 'job_g1', type: 'probe', payload: { a: 1 }, attempts: 3 });
      const b = await q.enqueue({ id: 'job_g1', type: 'probe', payload: { a: 2 } });
      ok(a.created === true && b.created === false && a.jobId === 'job_g1', 'enqueue is idempotent on the row id (transport dedupe)');
      ok((await q.has('job_g1', 'probe')) === true && (await q.has('job_none', 'probe')) === false, 'has() reflects the transport');
      let threw = null; try { await q.enqueue({ id: 'job_g2', type: 'noop' }); } catch (e) { threw = e; }
      ok(threw && threw.code === 'unknown_job_type', 'an unknown type is refused before touching Redis');
      threw = null; try { await q.enqueue({ type: 'probe' }); } catch (e) { threw = e; }
      ok(threw && /id is required/.test(threw.message), 'an id is required');

      const seen = [];
      const failed = [];
      const sub = q.subscribe('media', async (job) => {
        seen.push(`${job.type}:${job.id}:${job.attemptsMade}`);
        if (job.id === 'job_g3' && job.attemptsMade === 0) throw new Error('transient once');
        if (job.id === 'job_g4') { const e = new Error('fatal'); e.unrecoverable = true; throw e; }
        return { ok: true };
      }, { concurrency: 2, onFailed: (f) => failed.push(f) });
      await sub.ready();
      await q.enqueue({ id: 'job_g3', type: 'transcode', payload: {}, attempts: 3 });
      await q.enqueue({ id: 'job_g4', type: 'thumbnail', payload: {}, attempts: 3 });
      for (let i = 0; i < 80 && seen.length < 4; i += 1) await sleep(50);
      ok(seen.includes('probe:job_g1:0'), 'a waiting job is delivered to the subscribed consumer');
      ok(seen.includes('transcode:job_g3:0') && seen.includes('transcode:job_g3:1'), 'a rejected job is retried by the transport with the injected backoff');
      ok(seen.filter((s) => s.startsWith('thumbnail')).length === 1 && failed.some((f) => f.id === 'job_g4'), 'an unrecoverable rejection is NOT retried and surfaces on onFailed');
      await sleep(100);
      ok((await q.has('job_g1', 'probe')) === false && (await q.has('job_g4', 'thumbnail')) === false, 'completed and failed jobs are removed from Redis (the row keeps the truth)');
      await sub.close();
    } finally {
      await q.obliterate();
      await q.close();
    }

    console.log('\nH. Worker app: subscriptions and graceful shutdown');
    {
      const { repositories, rows, jobs } = fakeRepos();
      const mk = () => W.createBullJobQueue({ redisUrl: REDIS_URL, prefix: `t601h${RUN}`, logger: silent, stalledIntervalMs: 500, lockDurationMs: 1000 });
      const config = W.loadWorkerConfig({ REDIS_URL, QUEUE_PREFIX: `t601h${RUN}`, OUTBOX_INTERVAL_MS: '100', RECONCILE_INTERVAL_MS: '600000', WORKER_SHUTDOWN_TIMEOUT_MS: '5000' }, { appEnv: 'test' });
      const reg = W.createRegistry();
      let release = null;
      reg.register('probe', async ({ signal }) => new Promise((resolve, reject) => { release = () => resolve({ done: true }); signal.addEventListener('abort', () => reject(new Error('aborted'))); }));
      const q1 = mk();
      const app = W.createWorkerApp({ config, logger: silent, repositories, jobQueue: q1, registry: reg });
      await app.start();
      const st = app.status();
      ok(st.state === 'running' && st.queues.join() === 'media' && st.relay.running === true, 'start() subscribes ONLY the queues with processors and starts the relay');
      const { job: p } = await jobs.enqueue({ queue: 'probe', dedupeKey: `h1:${RUN}` });
      for (let i = 0; i < 60 && !release; i += 1) await sleep(50);
      ok(!!release && rows.get(p.id).status === 'active' && rows.get(p.id).enqueuedAt, 'the relay handed the row to the transport and the consumer started it (row active)');
      const stopping = app.stop({ timeoutMs: 5000 });
      await sleep(150);
      ok(rows.get(p.id).status === 'active', 'stop() waits for the in-flight job instead of killing it');
      release();
      const r = await stopping;
      ok(r.timedOut === false && rows.get(p.id).status === 'completed' && app.status().state === 'stopped', 'graceful stop: the job finished, the row is completed, no timeout');

      // Past the deadline: abort.
      const reg2 = W.createRegistry();
      let sig = null;
      reg2.register('probe', async ({ signal }) => new Promise((_, reject) => { sig = signal; signal.addEventListener('abort', () => reject(new Error('aborted'))); }));
      const q2 = mk();
      const app2 = W.createWorkerApp({ config, logger: silent, repositories, jobQueue: q2, registry: reg2 });
      await app2.start();
      const { job: p2 } = await jobs.enqueue({ queue: 'probe', dedupeKey: `h2:${RUN}` });
      for (let i = 0; i < 60 && !sig; i += 1) await sleep(50);
      const r2 = await app2.stop({ timeoutMs: 100 });
      ok(r2.timedOut === true && sig && sig.aborted, 'past the shutdown deadline the remaining job is aborted through its signal');
      await sleep(100);
      ok(rows.get(p2.id).status === 'queued' && /aborted/.test(rows.get(p2.id).lastError), 'an aborted job is recorded as a transient failure — it runs again after restart');
      const q3 = mk(); await q3.obliterate(); await q3.close();

      const cr = W.createChildRegistry();
      const fakeChild = { killed: null, listeners: {}, once(ev, fn) { this.listeners[ev] = fn; }, kill(s) { this.killed = s; } };
      cr.register(fakeChild);
      ok(cr.size() === 1 && cr.killAll() === 1 && fakeChild.killed === 'SIGKILL' && cr.size() === 0, 'child processes registered by processors are SIGKILLed on forced shutdown');
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
