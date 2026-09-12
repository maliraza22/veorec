// Shared Groq call budget (docs/15 §2, docs/10 §3): Groq's 20 RPM is a
// per-account budget, so N workers must share ONE window. A fixed window
// counter in Redis (INCR + EXPIRE) admits at most `max` calls per `windowMs`
// across every worker; without Redis (inline mode, unit tests) an in-memory
// window gives the same semantics for one process.
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {import('ioredis').Redis} [o.redis]
 * @param {string} [o.key]
 * @param {number} [o.max]        calls per window (default 18 — headroom under 20 RPM)
 * @param {number} [o.windowMs]
 * @param {() => number} [o.now]
 * @param {(ms:number)=>Promise} [o.wait]
 */
function createRateGate({ redis = null, key = 'veorec:groq:rpm', max = 18, windowMs = 60000, now = () => Date.now(), wait = sleep } = {}) {
  let localCount = 0, localWindowStart = 0;
  const stats = { admitted: 0, waited: 0, waitedMs: 0 };

  async function tryAcquireLocal() {
    const t = now();
    if (t - localWindowStart >= windowMs) { localWindowStart = t; localCount = 0; }
    if (localCount < max) { localCount += 1; return { ok: true }; }
    return { ok: false, retryMs: Math.max(50, windowMs - (t - localWindowStart)) };
  }

  async function tryAcquireRedis() {
    const bucket = Math.floor(now() / windowMs);
    const k = `${key}:${bucket}`;
    const n = await redis.incr(k);
    if (n === 1) await redis.pexpire(k, windowMs + 1000);
    if (n <= max) return { ok: true };
    return { ok: false, retryMs: Math.max(50, windowMs - (now() % windowMs)) };
  }

  /** Resolves when a call may be made; rejects only if the signal aborts. */
  async function acquire({ signal } = {}) {
    for (;;) {
      if (signal && signal.aborted) { const e = new Error('aborted'); e.code = 'aborted'; throw e; }
      const r = redis ? await tryAcquireRedis() : await tryAcquireLocal();
      if (r.ok) { stats.admitted += 1; return; }
      stats.waited += 1; stats.waitedMs += r.retryMs;
      await wait(r.retryMs);
    }
  }

  return { acquire, stats, max, windowMs, kind: redis ? 'redis' : 'memory' };
}

module.exports = { createRateGate };
