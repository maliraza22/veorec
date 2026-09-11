// JobQueue that runs jobs in-process, synchronously after enqueue (docs/10 §7,
// QUEUE_INLINE=true). Same interface, same runner, no Redis — for API
// integration tests and for a developer who wants processing without a second
// process. Retries happen immediately (no backoff), up to `attempts`, and a
// rejection flagged `unrecoverable` stops them, mirroring the BullMQ adapter.
'use strict';

const { specFor } = require('../catalog');
const { silentLogger } = require('../logger');

function createInlineJobQueue({ logger = silentLogger() } = {}) {
  const handlers = new Map();          // bull queue name → handler
  const pending = new Map();           // job id → promise
  const runs = [];                     // observability for tests: [{id, type, attempt, outcome}]
  let closed = false;

  async function execute(id, type, payload, attempts) {
    const spec = specFor(type);
    const handler = handlers.get(spec.queue);
    if (!handler) return;              // stays "held" until someone subscribes (has() → true)
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await handler({ id, type, payload, attemptsMade: attempt });
        runs.push({ id, type, attempt, outcome: 'completed' });
        return;
      } catch (err) {
        const outcome = err && err.defer ? 'deferred' : err && err.unrecoverable ? 'unrecoverable' : 'failed';
        runs.push({ id, type, attempt, outcome, error: err && err.message });
        // Deferred = "not here": inline has nowhere else to send it, so it is
        // simply left for the reconciler/relay of a real worker.
        if (err && (err.unrecoverable || err.defer)) return;
        if (attempt + 1 >= attempts) return;
      }
    }
  }

  async function enqueue({ id, type, payload = {}, attempts }) {
    if (closed) throw new Error('inline queue closed');
    if (!id || typeof id !== 'string') throw new Error('enqueue: id is required');
    const spec = specFor(type);
    if (pending.has(id)) return { jobId: id, created: false };
    const p = new Promise((resolve) => setImmediate(resolve))
      .then(() => execute(id, type, payload, attempts || spec.attempts))
      .catch((err) => logger.warn({ err: { message: err.message }, job_id: id }, 'inline job crashed'))
      .finally(() => pending.delete(id));
    pending.set(id, p);
    return { jobId: id, created: true };
  }

  async function has(id) { return pending.has(id); }

  function subscribe(queueName, handler, { onFailed } = {}) {
    handlers.set(queueName, async (job) => {
      try { return await handler(job); } catch (err) { if (onFailed) await onFailed({ id: job.id, type: job.type, error: err }); throw err; }
    });
    return { queue: queueName, ready: async () => {}, close: async () => { handlers.delete(queueName); } };
  }

  /** Await every job handed over so far (tests). */
  async function drain() { while (pending.size) await Promise.all(Array.from(pending.values())); }

  async function close() { closed = true; await drain(); handlers.clear(); }
  async function obliterate() { pending.clear(); runs.length = 0; }

  return { kind: 'inline', enqueue, has, subscribe, drain, close, obliterate, runs };
}

module.exports = { createInlineJobQueue };
