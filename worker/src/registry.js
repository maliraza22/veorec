// Processor registry: which job TYPES this worker process can run. A worker
// subscribes only to the BullMQ queues for which it has at least one processor,
// so a type nobody implements yet stays waiting in the transport (and is
// re-enqueued by the reconciler if the transport loses it) rather than failing.
'use strict';

const { JOB_TYPES, TYPE_CONCURRENCY, specFor } = require('./catalog');

function createRegistry() {
  const processors = new Map();

  /**
   * @param {string} type              a `processing_jobs.queue` value
   * @param {Function} handler         async ({ payload, job, signal, logger, deps, repositories }) → result
   * @param {{timeoutMs?: number, onSettled?: Function}} [opts]
   *        onSettled({ status:'completed'|'failed', job, result, error, repositories, deps, logger })
   *        runs AFTER the row is marked — the place for aggregates that must
   *        not see the calling job as still active.
   */
  function register(type, handler, opts = {}) {
    const spec = specFor(type);
    if (typeof handler !== 'function') throw new Error(`register(${type}): handler must be a function`);
    if (processors.has(type)) throw new Error(`register(${type}): already registered`);
    if (opts.onSettled !== undefined && typeof opts.onSettled !== 'function') throw new Error(`register(${type}): onSettled must be a function`);
    processors.set(type, {
      type, handler, timeoutMs: opts.timeoutMs || spec.timeoutMs, queue: spec.queue, onSettled: opts.onSettled || null,
      // docs/09 §9: CPU-bound types are serialised per process by the runner.
      concurrency: opts.concurrency || TYPE_CONCURRENCY[type] || null,
    });
    return () => processors.delete(type);
  }

  const get = (type) => processors.get(type) || null;
  const has = (type) => processors.has(type);
  const types = () => Array.from(processors.keys());
  const queues = () => Array.from(new Set(Array.from(processors.values()).map((p) => p.queue)));
  const missing = () => Object.keys(JOB_TYPES).filter((t) => !processors.has(t));

  return { register, get, has, types, queues, missing };
}

module.exports = { createRegistry };
