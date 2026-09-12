// Fixed-window rate limiter (docs/08 §1) — per-process interim.
//
// docs/08 §1 puts rate limits in Redis (shared across API instances); the v1
// API is still mounted on the single legacy process, so a per-process window
// is exact today and becomes a per-instance floor once there are several —
// the Redis-backed limiter is Phase 9/10 work. Keyed by caller (IP or user),
// answers 429 with Retry-After in the nested error contract.
'use strict';

const { ApiError } = require('./errors');

function createRateLimiter({ max, windowMs, keyOf, name = 'rate_limited', now = () => Date.now() }) {
  if (!(max > 0) || !(windowMs > 0)) throw new Error('createRateLimiter: max and windowMs are required');
  const buckets = new Map();   // key → { start, count }
  let sweepAt = 0;
  function sweep(t) {
    if (t < sweepAt) return;
    sweepAt = t + windowMs;
    for (const [k, b] of buckets) if (t - b.start >= windowMs) buckets.delete(k);
  }
  function hit(key) {
    const t = now();
    sweep(t);
    let b = buckets.get(key);
    if (!b || t - b.start >= windowMs) { b = { start: t, count: 0 }; buckets.set(key, b); }
    b.count += 1;
    return { allowed: b.count <= max, remaining: Math.max(0, max - b.count), retryAfterSec: Math.ceil((b.start + windowMs - t) / 1000) };
  }
  function middleware(req, res, next) {
    const r = hit(keyOf(req));
    if (r.allowed) return next();
    res.set('Retry-After', String(r.retryAfterSec));
    return next(new ApiError(429, name, 'Too many attempts. Please try again shortly.', { meta: { retryAfterSeconds: r.retryAfterSec } }));
  }
  return { hit, middleware, reset: () => buckets.clear(), size: () => buckets.size };
}

/** Caller IP the way the legacy server reads it (first X-Forwarded-For hop, else socket). */
function ipOf(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.socket?.remoteAddress || 'unknown';
}

module.exports = { createRateLimiter, ipOf };
