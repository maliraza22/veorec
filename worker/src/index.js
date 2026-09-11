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
const { createDefaultRegistry } = require('./processors');

module.exports = {
  ...catalog,
  ...errors,
  loadWorkerConfig, redactRedisUrl, WorkerConfigError,
  createLogger, silentLogger,
  assertJobQueue, createBullJobQueue, createInlineJobQueue,
  createRegistry, createDefaultRegistry,
  createJobRunner, createOutboxRelay,
  createWorkerApp, createChildRegistry,
};
