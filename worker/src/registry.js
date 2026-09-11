// Processor registry: which job TYPES this worker process can run. A worker
// subscribes only to the BullMQ queues for which it has at least one processor,
// so a type nobody implements yet stays waiting in the transport (and is
// re-enqueued by the reconciler if the transport loses it) rather than failing.
'use strict';

const { JOB_TYPES, specFor } = require('./catalog');

function createRegistry() {
  const processors = new Map();

  /**
   * @param {string} type              a `processing_jobs.queue` value
   * @param {Function} handler         async ({ payload, job, signal, logger, deps, repositories }) → result
   * @param {{timeoutMs?: number}} [opts]
   */
  function register(type, handler, opts = {}) {
    const spec = specFor(type);
    if (typeof handler !== 'function') throw new Error(`register(${type}): handler must be a function`);
    if (processors.has(type)) throw new Error(`register(${type}): already registered`);
    processors.set(type, { type, handler, timeoutMs: opts.timeoutMs || spec.timeoutMs, queue: spec.queue });
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
