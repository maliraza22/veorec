// T-1304 rate limits → Redis (run: cd api && npm run test:rate-limit)
//
// A. the per-process memory window (exact, time-injected): limit, Retry-After,
//    window roll-over, separate names/scopes, reset. B. the SHARED Redis store
//    on a real Redis: two limiter instances (two API processes) spend ONE
//    budget; the window expires (PEXPIRE); different scopes are different
//    budgets; a key without a TTL is healed. C. failure policy: a broken store
//    → 'open' allows and reports degraded, 'closed' still denies over the
//    threshold from the per-process fallback. D. HTTP: 429 in the nested
//    error contract with Retry-After. E. wiring: uploads (10/h·user) and AI
//    triggers (10/h·user) are limited per user, closed-fail; watch/engagement
//    take the shared store; the server builds ONE store from REDIS_URL.
//
// The Redis sections SKIP LOUDLY without Redis; RATE_LIMIT_TESTS_REQUIRED=1
// makes that a failure.
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const API_DIR = path.join(ROOT, 'api');
const express = require(path.join(API_DIR, 'node_modules', 'express'));
const { createRateLimiter, createMemoryRateStore, createRedisRateStore, ipOf, userOf } = require(path.join(API_DIR, 'src', 'rate-limit.js'));
const { errorHandler } = require(path.join(API_DIR, 'src', 'errors.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.RATE_LIMIT_TESTS_REQUIRED === '1';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6380';
const RUN = crypto.randomBytes(3).toString('hex');
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('T-1304 rate limit tests');

  console.log('\nA. Memory window');
  let t = 1_000_000;
  const now = () => t;
  const lim = createRateLimiter({ max: 3, windowMs: 10_000, keyOf: (r) => r.key, now, name: 'rate_limited' });
  const hits = [];
  for (let i = 0; i < 5; i += 1) hits.push(await lim.hit('a'));
  ok(hits.slice(0, 3).every((h) => h.allowed) && !hits[3].allowed && !hits[4].allowed && hits[3].retryAfterSec === 10 && hits[2].remaining === 0 && lim.kind === 'memory', '3 allowed then denied with Retry-After = the window remainder');
  t += 4000;
  ok(!(await lim.hit('a')).allowed && (await lim.hit('a')).retryAfterSec === 6, 'still denied inside the window; Retry-After counts down');
  ok((await lim.hit('b')).allowed, 'another caller has its own budget');
  t += 6001;
  ok((await lim.hit('a')).allowed, 'the window rolls over');
  const other = createRateLimiter({ max: 1, windowMs: 10_000, keyOf: (r) => r.key, now, name: 'rate_limited', scope: 'other' });
  ok((await other.hit('a')).allowed && !(await other.hit('a')).allowed && (await lim.hit('a')).allowed, 'a different scope is a different budget');
  lim.reset();
  ok(lim.size() === 0 && (await lim.hit('a')).remaining === 2, 'reset clears the per-process windows');
  let threw = null; try { createRateLimiter({ max: 0, windowMs: 1, keyOf: () => 'x' }); } catch (e) { threw = e; }
  ok(threw && /max and windowMs/.test(threw.message), 'max/windowMs are required');
  ok(ipOf({ headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' } }) === '1.2.3.4' && ipOf({ headers: {}, ip: '9.9.9.9' }) === '9.9.9.9' && userOf({ headers: {}, pgUserId: 'usr_1', userId: 'legacy' }) === 'usr_1' && userOf({ headers: {}, userId: 'legacy' }) === 'legacy' && userOf({ headers: {}, ip: '2.2.2.2' }) === '2.2.2.2', 'ipOf takes the first forwarded hop; userOf prefers the PostgreSQL id, then the legacy id, then the IP');

  console.log('\nC. Failure policy');
  const broken = { kind: 'redis', async incr() { throw new Error('ECONNREFUSED'); } };
  const open = createRateLimiter({ max: 1, windowMs: 60_000, keyOf: (r) => r.key, now, store: broken, policy: 'open', logger: silent });
  const closed = createRateLimiter({ max: 1, windowMs: 60_000, keyOf: (r) => r.key, now, store: broken, policy: 'closed', logger: silent });
  const o1 = await open.hit('a'), o2 = await open.hit('a');
  ok(o1.allowed && o2.allowed && o2.degraded === true, "'open' allows every request while the store is down and reports degraded (engagement/watch)");
  const c1 = await closed.hit('a'), c2 = await closed.hit('a');
  ok(c1.allowed && !c2.allowed && c2.degraded === true && c2.retryAfterSec >= 1, "'closed' falls back to the per-process window and still denies over the threshold (auth/uploads/AI)");
  const warnings = [];
  const warnLim = createRateLimiter({ max: 1, windowMs: 60_000, keyOf: (r) => r.key, now, store: broken, policy: 'open', logger: { warn: (o) => warnings.push(o) } });
  await warnLim.hit('a'); await warnLim.hit('a');
  ok(warnings.length === 1 && warnings[0].policy === 'open', 'the outage is logged once per minute, not per request');

  console.log('\nD. HTTP contract');
  const app = express();
  const web = createRateLimiter({ max: 2, windowMs: 60_000, keyOf: ipOf, name: 'rate_limited' });
  app.get('/x', web.middleware, (req, res) => res.json({ ok: true }));
  app.use(errorHandler(silent));
  const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const rs = [];
  for (let i = 0; i < 3; i += 1) rs.push(await fetch(`${base}/x`, { headers: { 'x-forwarded-for': '203.0.113.5' } }));
  const body = await rs[2].json();
  ok(rs[0].status === 200 && rs[1].status === 200 && rs[2].status === 429 && body.error.code === 'rate_limited' && body.error.meta.retryAfterSeconds >= 1 && Number(rs[2].headers.get('retry-after')) >= 1, '429 in the nested error contract with Retry-After');
  ok((await fetch(`${base}/x`, { headers: { 'x-forwarded-for': '203.0.113.6' } })).status === 200, 'another IP is unaffected');
  server.close();

  console.log('\nB. Shared Redis store');
  let redisUp = false;
  try { const IORedis = require(path.join(API_DIR, 'node_modules', 'ioredis')); const c = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 1500, lazyConnect: true }); await c.connect(); redisUp = (await c.ping()) === 'PONG'; await c.quit(); } catch {}
  if (!redisUp) {
    console.log(`  SKIPPED B — no Redis at ${REDIS_URL}`);
    if (REQUIRED) { fail += 1; console.log('  FAIL: RATE_LIMIT_TESTS_REQUIRED=1 but Redis is unavailable'); }
  } else {
    const store = createRedisRateStore({ redisUrl: REDIS_URL, prefix: `t1304:${RUN}:`, logger: silent });
    try {
      const a = createRateLimiter({ max: 3, windowMs: 60_000, keyOf: (r) => r.key, store, scope: 'shared' });
      const b = createRateLimiter({ max: 3, windowMs: 60_000, keyOf: (r) => r.key, store, scope: 'shared' });
      const h = [await a.hit('ip1'), await b.hit('ip1'), await a.hit('ip1'), await b.hit('ip1')];
      ok(h.every((x) => !x.degraded) && h[0].allowed && h[1].allowed && h[2].allowed && !h[3].allowed && h[3].retryAfterSec >= 59 && a.kind === 'redis', `two limiter instances (two API processes) spend ONE budget [${JSON.stringify(h)}]`);
      ok((await b.hit('ip2')).allowed, 'another caller is unaffected');
      const c = createRateLimiter({ max: 3, windowMs: 60_000, keyOf: (r) => r.key, store, scope: 'elsewhere' });
      ok((await c.hit('ip1')).allowed, 'a different scope is a different budget on the same store');
      const short = createRateLimiter({ max: 1, windowMs: 300, keyOf: (r) => r.key, store, scope: 'short' });
      ok((await short.hit('x')).allowed && !(await short.hit('x')).allowed, 'a short window denies the second hit');
      await sleep(400);
      ok((await short.hit('x')).allowed, 'and expires through PEXPIRE');
      await store.client.set(`t1304:${RUN}:rate_limited:heal:k`, '5');
      const healed = await store.incr('rate_limited:heal:k', 5000);
      ok(healed.count === 6 && (await store.client.pttl(`t1304:${RUN}:rate_limited:heal:k`)) > 0, 'a key that lost its TTL is given one (a budget can never stick forever)');
      const keys = await store.client.keys(`t1304:${RUN}:*`);
      ok(keys.every((k) => k.startsWith(`t1304:${RUN}:rate_limited:`)), 'keys live under the prefix + limiter name');
      await store.reset();
      ok((await store.client.keys(`t1304:${RUN}:*`)).length === 0, 'reset clears the store\'s keys');
    } finally { await store.close(); }
  }

  console.log('\nE. Wiring');
  const uploads = fs.readFileSync(path.join(API_DIR, 'src', 'uploads.router.js'), 'utf8');
  const ai = fs.readFileSync(path.join(API_DIR, 'src', 'ai.router.js'), 'utf8');
  const watch = fs.readFileSync(path.join(API_DIR, 'src', 'watch.router.js'), 'utf8');
  const eng = fs.readFileSync(path.join(API_DIR, 'src', 'engagement.router.js'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  ok(/max: 10, windowMs: 60 \* 60 \* 1000, \.\.\.\(rateLimits\.sessions \|\| \{\}\), keyOf: userOf, name: 'rate_limited', scope: 'upload_sessions', store: rateStore, policy: 'closed'/.test(uploads) && /router\.post\('\/uploads', sessionLimiter\.middleware/.test(uploads), 'upload-session creation: 10/h per user, closed-fail, on the shared store');
  ok(/max: 10, windowMs: 60 \* 60 \* 1000, \.\.\.\(rateLimits\.ai \|\| \{\}\), keyOf: userOf, name: 'rate_limited', scope: 'ai_triggers', store: rateStore, policy: 'closed'/.test(ai) && /'\/recordings\/:id\/transcribe', '\/recordings\/:id\/transcript\/translate', '\/recordings\/:id\/title\/auto', '\/recordings\/:id\/summary', '\/recordings\/:id\/chapters', '\/recordings\/:id\/reprocess'\], aiLimiter\.middleware/.test(ai), 'AI triggers: 10/h per user, closed-fail; reads are not limited');
  ok(/store: rateStore, scope: 'watch', policy: 'open'/.test(watch) && /store: rateStore, scope: 'unlock', policy: 'closed'/.test(watch) && /store: rateStore, scope: 'view', policy: 'open'/.test(eng) && /store: rateStore, scope: 'engage', policy: 'open'/.test(eng), 'watch/engagement limits share the store; unlock (a password guess) closed-fails, the rest open-fail');
  ok(/createRedisRateStore\(\{ redisUrl: process\.env\.REDIS_URL/.test(serverSrc) && (serverSrc.match(/\n\s+rateStore,\n/g) || []).length === 4, 'the server builds ONE store from REDIS_URL and hands it to the four limited routers');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
