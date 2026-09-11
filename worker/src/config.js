// Worker/queue configuration (T-601, docs/10 §2, §7).
//
// Same posture as @veorec/db and @veorec/storage: local and test get a
// development default; staging and production get NO default and fail fast,
// so a deployed worker can never silently talk to a developer's Redis.
'use strict';

const APP_ENVS = ['local', 'test', 'staging', 'production'];
const LOCAL_REDIS = 'redis://127.0.0.1:6380';

class WorkerConfigError extends Error {
  constructor(message) { super(message); this.name = 'WorkerConfigError'; this.code = 'worker_config_error'; }
}

function int(value, fallback, { min = 0 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^[0-9]{1,9}$/.test(String(value))) throw new WorkerConfigError(`expected a plain non-negative integer, got "${value}"`);
  const n = Number(value);
  return n < min ? fallback : n;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{appEnv?: string}} [overrides]
 */
function loadWorkerConfig(env = process.env, overrides = {}) {
  const appEnv = String(overrides.appEnv || env.APP_ENV || 'local').toLowerCase();
  if (!APP_ENVS.includes(appEnv)) throw new WorkerConfigError(`APP_ENV must be one of ${APP_ENVS.join(' | ')} (got "${appEnv}")`);
  const deployed = appEnv === 'staging' || appEnv === 'production';

  const redisUrl = env.REDIS_URL || (deployed ? null : LOCAL_REDIS);
  if (!redisUrl) throw new WorkerConfigError(`REDIS_URL is required when APP_ENV=${appEnv} (no default outside local/test)`);
  if (!/^rediss?:\/\//.test(redisUrl)) throw new WorkerConfigError('REDIS_URL must be a redis:// or rediss:// connection string');

  return {
    appEnv,
    redisUrl,
    // Key namespace; tests use a unique prefix per run so they can obliterate it.
    prefix: env.QUEUE_PREFIX || 'veorec',
    // docs/10 §7: QUEUE_INLINE=true runs jobs synchronously in-process through
    // the same JobQueue interface. Only the literal "true" enables it.
    inline: env.QUEUE_INLINE === 'true',
    // Outbox relay cadence (docs/10 §2: "small loop, 500ms") and the reconciler
    // that re-enqueues rows the transport lost (docs/10 §1).
    outboxIntervalMs: int(env.OUTBOX_INTERVAL_MS, 500, { min: 50 }),
    outboxBatch: int(env.OUTBOX_BATCH, 100, { min: 1 }),
    reconcileIntervalMs: int(env.RECONCILE_INTERVAL_MS, 60000, { min: 500 }),
    reconcileMinAgeMs: int(env.RECONCILE_MIN_AGE_MS, 300000, { min: 1000 }),
    // Graceful shutdown: stop taking jobs, finish the current ones ≤ timeout.
    shutdownTimeoutMs: int(env.WORKER_SHUTDOWN_TIMEOUT_MS, 30000, { min: 0 }),
    // BullMQ stalled detection (docs/10 §2: 60 s) and lock duration.
    stalledIntervalMs: int(env.WORKER_STALLED_INTERVAL_MS, 60000, { min: 100 }),
    lockDurationMs: int(env.WORKER_LOCK_DURATION_MS, 30000, { min: 500 }),
    concurrency: int(env.WORKER_CONCURRENCY, 2, { min: 1 }),
    // A delivery this worker has no processor for goes back to the transport
    // after this delay (rolling deploys with mixed worker versions).
    deferMs: int(env.WORKER_DEFER_MS, 5000, { min: 50 }),
  };
}

/** For logs: never print the password part of a Redis URL. */
function redactRedisUrl(url) {
  try { new URL(url); } catch { return '[invalid-url]'; }
  // Textual replacement: URL.password= would percent-encode the placeholder.
  return String(url).replace(/\/\/([^:@/]*):([^@/]*)@/, '//$1:[REDACTED]@');
}

module.exports = { loadWorkerConfig, redactRedisUrl, WorkerConfigError, LOCAL_REDIS, APP_ENVS };
