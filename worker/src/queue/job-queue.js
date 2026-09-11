// JobQueue — the ONLY queue abstraction (docs/10 §2, docs/02 §10.4).
//
// PostgreSQL `processing_jobs` is the record; the queue is transport. Every
// implementation carries the same contract so BullMQ can be swapped (pg-boss,
// BullMQ's own PostgreSQL backend, an in-process inline queue for tests)
// without touching the outbox relay, the runner or any processor.
//
//   enqueue({ id, type, payload, attempts }) → Promise<{ jobId, created }>
//       Hands a committed `processing_jobs` row to the transport. `id` is the
//       row id (`job_…`) and doubles as the transport job id, so the same row
//       can never be carried twice: a second enqueue of the same id is a no-op
//       that resolves `created:false`.
//   has(id, type) → Promise<boolean>
//       True while the transport still holds the job (waiting, delayed,
//       active, …). False once it is gone — the reconciler's signal.
//   subscribe(queueName, handler, { concurrency, onFailed }) → { close(force), ready() }
//       Consume a BullMQ-level queue (docs/10 §2 names: media, render, stt,
//       ai, maintenance, email). `handler({ id, type, payload, attemptsMade })`
//       resolves on success; a rejection whose `unrecoverable` flag is set is
//       not retried; any other rejection is retried with the catalog backoff.
//   close() → Promise            release connections
//   obliterate() → Promise       tests only: drop every key under the prefix
//
// A transport job id can never contain ':' (BullMQ), which is why the ROW ID
// and not the dedupe key is the transport id — the two are 1:1 anyway
// (`dedupe_key` is UNIQUE on the table).
'use strict';

const REQUIRED = ['enqueue', 'has', 'subscribe', 'close'];

function assertJobQueue(q) {
  for (const m of REQUIRED) {
    if (!q || typeof q[m] !== 'function') {
      const err = new Error(`JobQueue implementation is missing ${m}()`);
      err.code = 'invalid_job_queue';
      throw err;
    }
  }
  return q;
}

module.exports = { assertJobQueue, REQUIRED };
