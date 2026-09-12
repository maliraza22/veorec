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
const { createPlanResolver } = require('./plan-limits');
const { createRateGate } = require('./stt/rate-gate');
const { createTranscriber } = require('./stt/transcription');
const { createAi } = require('./stt/ai');
const { resolveBinaries } = require('./media/exec');
const { createProber } = require('./media/probe');
const { createTranscoder } = require('./media/transcode');

const DB_DIR = path.join(__dirname, '..', '..', 'db', 'src');
const STORAGE_DIR = path.join(__dirname, '..', '..', 'storage', 'src');
// The ONE plan catalog (server/plans.js: limitsFor honours QUOTA_ENFORCEMENT_V2).
const PLANS_PATH = path.join(__dirname, '..', '..', 'server', 'plans.js');

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
  // T-602: plan limits for the storage-verification report, from the one catalog.
  let resolveLimits = null;
  try { resolveLimits = createPlanResolver({ plans: require(PLANS_PATH) }); }
  catch (e) { logger.warn({ err: { message: e.message } }, 'plan catalog unavailable — storage verification will be skipped'); }
  // T-603: STT/LLM providers from env; ffmpeg/ffprobe from FFMPEG_BIN/FFPROBE_BIN,
  // else PATH, else the static binaries when installed (local dev/test only —
  // the worker image ships system ffmpeg, docs/02 §2.2). One Groq budget shared
  // by every worker through Redis (docs/10 §3 limiter).
  const bins = resolveBinaries();
  const sttConfig = { ffmpegBin: bins.ffmpegBin, ffprobeBin: bins.ffprobeBin };
  const rateGate = createRateGate({ redis: config.inline ? null : jobQueue.connection, max: Number(process.env.GROQ_RPM_BUDGET || 18) });
  const transcriber = createTranscriber({ config: sttConfig, rateGate, logger });
  const ai = createAi({ rateGate, logger });
  // T-701: the prober (ffprobe facts) for media.probe; the same binaries feed T-702+.
  const prober = createProber({ ffprobeBin: bins.ffprobeBin, ffmpegBin: bins.ffmpegBin, logger });
  // T-702: the transcoder (MP4 + faststart, verified by the prober) and the
  // canonical key builders for derived outputs.
  const transcoder = createTranscoder({ ffmpegBin: bins.ffmpegBin, prober, logger });
  let keys = null;
  try { keys = require(path.join(STORAGE_DIR, 'index.js')).keys; } catch { /* no storage package → media jobs fail transiently */ }
  logger.info({ stt_configured: transcriber.isConfigured(), whisper_model: transcriber.hasWhisperModel(), llm_configured: ai.isLLMConfigured(), rate_gate: rateGate.kind, ffmpeg: bins.ffmpegBin, ffprobe: bins.ffprobeBin }, 'stt/ai/media providers');
  const app = createWorkerApp({ config, logger, repositories, withTransaction: tx, storage, jobQueue, registry, deps: { resolveLimits, transcriber, ai, rateGate, prober, transcoder, keys } });

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
