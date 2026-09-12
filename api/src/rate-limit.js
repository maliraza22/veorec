// Rate limiting (docs/08 §1, docs/17 §5) — fixed windows, shared through Redis (T-1304).
//
//   createRateLimiter({ max, windowMs, keyOf, name, store, policy })
//     • store = createRedisRateStore(...)  → ONE budget across every API
//       instance (an atomic INCR + PEXPIRE + PTTL script per hit)
//     • store = null                       → the per-process memory window
//       (exact on a single instance — local development and tests)
//     • policy 'open'   (engagement, watch): Redis trouble ⇒ the request is
//       allowed and the limiter reports `degraded`
//       policy 'closed' (auth, uploads, AI): Redis trouble ⇒ the per-process
//       fallback window still denies over-threshold callers
//   Keyed by caller (IP or user); answers 429 + Retry-After in the nested
//   error contract. Legacy `server/ratelimit.js` is untouched (its auth routes
//   move to v1 with T-1302).
'use strict';

const { ApiError } = require('./errors');

const silent = { warn() {}, info() {}, error() {} };

/** Per-process fixed windows. `now` is injectable so tests can move time. */
function createMemoryRateStore({ now = () => Date.now() } = {}) {
  const buckets = new Map();   // key → { start, count, windowMs }
  let sweepAt = 0;
  function sweep(t, windowMs) {
    if (t < sweepAt) return;
    sweepAt = t + windowMs;
    for (const [k, b] of buckets) if (t - b.start >= b.windowMs) buckets.delete(k);
  }
  return {
    kind: 'memory',
    async incr(key, windowMs) {
      const t = now();
      sweep(t, windowMs);
      let b = buckets.get(key);
      if (!b || t - b.start >= b.windowMs) { b = { start: t, count: 0, windowMs }; buckets.set(key, b); }
      b.count += 1;
      return { count: b.count, ttlMs: Math.max(1, b.start + b.windowMs - t) };
    },
    reset() { buckets.clear(); },
    size() { return buckets.size; },
    async close() {},
  };
}

// INCR the window counter; the first hit sets the window's expiry; a key that
// somehow lost its TTL gets one so a budget can never stick forever.
const INCR_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local t = redis.call('PTTL', KEYS[1])
if t < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) t = tonumber(ARGV[1]) end
return {c, t}
`;

/**
 * The shared store. Pass an ioredis client or a `redisUrl` (the client is
 * created here with a short timeout and NO offline queue, so an unreachable
 * Redis fails fast and the limiter's policy decides).
 */
function createRedisRateStore({ redis = null, redisUrl = null, prefix = 'veorec:rl:', logger = silent } = {}) {
  let client = redis;
  let owned = false;
  if (!client) {
    if (!redisUrl) throw new Error('createRedisRateStore: redis client or redisUrl required');
    const IORedis = require('ioredis');
    client = new IORedis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2000, lazyConnect: false });
    client.on('error', (e) => logger.warn({ err: e && e.message }, 'rate-limit: redis error'));
    owned = true;
  }
  // Without an offline queue the first hits would fail while the socket is
  // still connecting; wait (briefly) for readiness once, then never again.
  const ready = new Promise((resolve) => {
    if (client.status === 'ready') return resolve(true);
    const t = setTimeout(() => resolve(false), 2500);
    if (t.unref) t.unref();
    client.once('ready', () => { clearTimeout(t); resolve(true); });
  });
  return {
    kind: 'redis',
    async incr(key, windowMs) {
      if (client.status !== 'ready') await ready;
      const r = await client.eval(INCR_SCRIPT, 1, prefix + key, String(Math.max(1, Math.floor(windowMs))));
      return { count: Number(r[0]), ttlMs: Math.max(1, Number(r[1])) };
    },
    async reset(pattern = '*') {
      const keys = await client.keys(prefix + pattern);
      if (keys.length) await client.del(...keys);
    },
    async close() { if (owned) { try { await client.quit(); } catch { /* closing */ } } },
    client,
  };
}

/**
 * @param {object} o
 * @param {number} o.max                 hits per window
 * @param {number} o.windowMs
 * @param {(req) => string} o.keyOf      caller key (ipOf, or the user id)
 * @param {string} [o.name]              error code + key namespace (default rate_limited)
 * @param {string} [o.scope]             extra namespace when several limiters share a name and a store
 * @param {() => number} [o.now]
 * @param {object|null} [o.store]        createRedisRateStore(...) — null = memory
 * @param {'open'|'closed'} [o.policy]   behaviour when the store errors (docs/17 §5)
 * @param {object} [o.logger]
 */
function createRateLimiter({ max, windowMs, keyOf, name = 'rate_limited', scope = null, now = () => Date.now(), store = null, policy = 'open', logger = silent }) {
  if (!(max > 0) || !(windowMs > 0)) throw new Error('createRateLimiter: max and windowMs are required');
  if (typeof keyOf !== 'function') throw new Error('createRateLimiter: keyOf(req) is required');
  const memory = createMemoryRateStore({ now });
  const ns = scope ? `${name}:${scope}:` : `${name}:`;
  let warnedAt = 0;

  async function hit(key) {
    const k = ns + String(key);
    let r, degraded = false;
    if (store) {
      try { r = await store.incr(k, windowMs); }
      catch (e) {
        degraded = true;
        const t = now();
        if (t - warnedAt > 60000) { warnedAt = t; logger.warn({ err: e && e.message, policy, limiter: name }, 'rate-limit: shared store unavailable'); }
        if (policy === 'closed') r = await memory.incr(k, windowMs);
        else return { allowed: true, remaining: max, retryAfterSec: 0, degraded: true };
      }
    } else r = await memory.incr(k, windowMs);
    const retryAfterSec = Math.max(1, Math.ceil(r.ttlMs / 1000));
    return { allowed: r.count <= max, remaining: Math.max(0, max - r.count), retryAfterSec, degraded };
  }

  function middleware(req, res, next) {
    Promise.resolve(hit(keyOf(req))).then((r) => {
      if (r.allowed) return next();
      res.set('Retry-After', String(r.retryAfterSec));
      return next(new ApiError(429, name, 'Too many attempts. Please try again shortly.', { meta: { retryAfterSeconds: r.retryAfterSec } }));
    }).catch(next);
  }

  return { hit, middleware, reset: () => memory.reset(), size: () => memory.size(), kind: store ? store.kind : 'memory', policy };
}

/** Caller IP the way the legacy server reads it (first X-Forwarded-For hop, else socket). */
function ipOf(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.socket?.remoteAddress || 'unknown';
}

/** The authenticated caller (PostgreSQL id after the identity bridge, else the legacy id). */
function userOf(req) {
  return req.pgUserId || req.userId || ipOf(req);
}

module.exports = { createRateLimiter, createMemoryRateStore, createRedisRateStore, ipOf, userOf, INCR_SCRIPT };
