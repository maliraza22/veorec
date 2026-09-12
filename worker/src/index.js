// @veorec/worker — public surface (T-601).
//
// JobQueue implementations (BullMQ over Redis; inline for QUEUE_INLINE), the
// transactional outbox relay + reconciler, the job runner, the processor
// registry, the worker app and its configuration. PostgreSQL only through
// @veorec/db repositories, object storage only through @veorec/storage.
'use strict';

const catalog = require('./catalog');
const errors = require('./errors');
const { loadWorkerConfig, redactRedisUrl, WorkerConfigError } = require('./config');
const { createLogger, silentLogger } = require('./logger');
const { assertJobQueue } = require('./queue/job-queue');
const { createBullJobQueue } = require('./queue/bullmq');
const { createInlineJobQueue } = require('./queue/inline');
const { createRegistry } = require('./registry');
const { createJobRunner } = require('./run-job');
const { createOutboxRelay } = require('./outbox');
const { createWorkerApp, createChildRegistry } = require('./app');
const { createDefaultRegistry, registerMaintenanceProcessors, registerSttProcessors, registerMediaProcessors } = require('./processors');
const mediaExec = require('./media/exec');
const probe = require('./media/probe');
const transcode = require('./media/transcode');
const ready = require('./media/ready');
const mediaProcessors = require('./processors/media');
const transcription = require('./stt/transcription');
const { createAi } = require('./stt/ai');
const { createRateGate } = require('./stt/rate-gate');
const sttProcessors = require('./processors/stt');
const { createScheduler, DEFAULT_SCHEDULES, bucketKey, isoWeek, HOUR, DAY, WEEK } = require('./scheduler');
const { createPlanResolver } = require('./plan-limits');

module.exports = {
  ...catalog,
  ...errors,
  loadWorkerConfig, redactRedisUrl, WorkerConfigError,
  createLogger, silentLogger,
  assertJobQueue, createBullJobQueue, createInlineJobQueue,
  createRegistry, createDefaultRegistry,
  createJobRunner, createOutboxRelay,
  createWorkerApp, createChildRegistry,
  // T-602: repeatable maintenance schedules + plan limits for verification.
  registerMaintenanceProcessors, createScheduler, DEFAULT_SCHEDULES, bucketKey, isoWeek, HOUR, DAY, WEEK, createPlanResolver,
  // T-603: transcription/AI in the worker.
  registerSttProcessors, createAi, createRateGate,
  createTranscriber: transcription.createTranscriber, sttConfigFromEnv: transcription.configFromEnv,
  mapGroqJson: transcription.mapGroqJson, buildSpeechChunks: transcription.buildSpeechChunks, capChunkCount: transcription.capChunkCount,
  parseSilences: transcription.parseSilences, generateTitle: transcription.generateTitle, WHISPER_NAME_TO_CODE: transcription.WHISPER_NAME_TO_CODE,
  settleAiStatus: sttProcessors.settleAiStatus, isDefaultTitle: sttProcessors.isDefaultTitle, DEFAULT_TITLES: sttProcessors.DEFAULT_TITLES,
  // T-701: media probe.
  registerMediaProcessors, createProber: probe.createProber, containerOf: probe.containerOf, parseDecodedDuration: probe.parseDecodedDuration,
  resolveBinaries: mediaExec.resolveBinaries, runTool: mediaExec.run,
  scratchDir: mediaProcessors.scratchDir, DURATION_GRACE_SEC: mediaProcessors.DURATION_GRACE_SEC, HLS_MIN_DURATION_SEC: mediaProcessors.HLS_MIN_DURATION_SEC,
  // T-702: transcode + maybe_mark_ready.
  createTranscoder: transcode.createTranscoder, buildTranscodeArgs: transcode.buildArgs, parseProgress: transcode.parseProgress, hasFaststart: transcode.hasFaststart,
  maybeMarkReady: ready.maybeMarkReady,
};
