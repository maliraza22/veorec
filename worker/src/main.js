#!/usr/bin/env node
// Worker entry point (docs/02 §2.2 apps/worker; `npm run worker`).
//
//   APP_ENV, DATABASE_URL[_TEST], REDIS_URL, STORAGE_* (optional until a
//   processor needs storage), QUEUE_INLINE, WORKER_*, OUTBOX_*, RECONCILE_*.
//
// One process runs the outbox relay and every processor registered in
// ./processors. Exit 0 after a graceful SIGTERM/SIGINT shutdown, 1 on a fatal
// startup error or an uncaught exception (docs/19: crash semantics unchanged).
'use strict';

const path = require('path');
const { loadWorkerConfig, redactRedisUrl } = require('./config');
const { createLogger } = require('./logger');
const { createBullJobQueue } = require('./queue/bullmq');
const { createInlineJobQueue } = require('./queue/inline');
const { createWorkerApp } = require('./app');
const { createDefaultRegistry } = require('./processors');

const DB_DIR = path.join(__dirname, '..', '..', 'db', 'src');
const STORAGE_DIR = path.join(__dirname, '..', '..', 'storage', 'src');

async function main() {
  const logger = createLogger();
  const config = loadWorkerConfig();
  const { loadEnv, createPool, createClient, createRepositories, withTransaction } = require(path.join(DB_DIR, 'index.js'));
  const env = loadEnv({ appEnv: config.appEnv });
  const pool = createPool({ env, max: Number(process.env.WORKER_DB_POOL_MAX || 8) });
  const db = createClient(pool);
  const repositories = () => createRepositories(db);
  const tx = (fn) => withTransaction(fn, db);

  let storage = null;
  try {
    storage = require(path.join(STORAGE_DIR, 'index.js')).createStorageProvider({ appEnv: config.appEnv });
  } catch (e) {
    logger.warn({ err: { message: e.message } }, 'no storage provider configured — processors that need storage will fail their jobs');
  }

  const jobQueue = config.inline
    ? createInlineJobQueue({ logger })
    : createBullJobQueue({ redisUrl: config.redisUrl, prefix: config.prefix, logger, stalledIntervalMs: config.stalledIntervalMs, lockDurationMs: config.lockDurationMs });
  const registry = createDefaultRegistry({ logger });
  const app = createWorkerApp({ config, logger, repositories, withTransaction: tx, storage, jobQueue, registry });

  logger.info({ app_env: config.appEnv, redis: config.inline ? 'inline' : redactRedisUrl(config.redisUrl), prefix: config.prefix }, 'worker booting');
  await app.start();

  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutdown signal received');
    try { await app.stop(); } catch (e) { logger.error({ err: { message: e.message } }, 'shutdown error'); }
    try { await pool.end(); } catch { /* closing */ }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => { logger.fatal({ err: { message: err && err.message } }, 'unhandled rejection'); process.exit(1); });
  process.on('uncaughtException', (err) => { logger.fatal({ err: { message: err && err.message } }, 'uncaught exception'); process.exit(1); });
  return app;
}

if (require.main === module) {
  main().catch((e) => { process.stderr.write(`worker failed to start: ${e && e.message}\n`); process.exit(1); });
}

module.exports = { main };
