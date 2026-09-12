// Job catalog (docs/10 §2–§3): every job TYPE (`processing_jobs.queue`) maps to
// the BullMQ queue that carries it, its retry budget and its timeout.
//
// The BullMQ queue is a routing decision, invisible to the API and to clients
// (docs/10 §2 — `render-gpu` later is just another queue name here). The row's
// `max_attempts` is what the producer wrote; the catalog value is the default
// when a producer does not say.
'use strict';

const MIN = 60 * 1000;

const JOB_TYPES = Object.freeze({
  probe:             { queue: 'media',       attempts: 5, timeoutMs: 5 * MIN },
  transcode:         { queue: 'media',       attempts: 3, timeoutMs: 10 * MIN },
  thumbnail:         { queue: 'media',       attempts: 3, timeoutMs: 3 * MIN },
  hls:               { queue: 'media',       attempts: 3, timeoutMs: 60 * MIN },
  audio_extract:     { queue: 'media',       attempts: 3, timeoutMs: 10 * MIN },
  captions:          { queue: 'media',       attempts: 3, timeoutMs: 5 * MIN },
  transcribe:        { queue: 'stt',         attempts: 3, timeoutMs: 30 * MIN },
  translate:         { queue: 'stt',         attempts: 2, timeoutMs: 10 * MIN },
  ai_title:          { queue: 'ai',          attempts: 2, timeoutMs: 5 * MIN },
  ai_summary:        { queue: 'ai',          attempts: 2, timeoutMs: 5 * MIN },
  ai_chapters:       { queue: 'ai',          attempts: 2, timeoutMs: 5 * MIN },
  render:            { queue: 'render',      attempts: 2, timeoutMs: 15 * MIN },
  silence_detect:    { queue: 'media',       attempts: 2, timeoutMs: 20 * MIN },   // T-1204: audio-based silence → virtual edit
  cleanup:           { queue: 'maintenance', attempts: 3, timeoutMs: 60 * MIN },
  usage_sync:        { queue: 'maintenance', attempts: 3, timeoutMs: 30 * MIN },
  subscription_sync: { queue: 'maintenance', attempts: 3, timeoutMs: 30 * MIN },
  upload_expiry:     { queue: 'maintenance', attempts: 3, timeoutMs: 30 * MIN },
  email:             { queue: 'email',       attempts: 5, timeoutMs: 1 * MIN },
});

const QUEUES = Object.freeze(['media', 'render', 'stt', 'ai', 'maintenance', 'email']);

// docs/10 §3: the stt queue runs one job at a time (Groq shared budget).
const QUEUE_CONCURRENCY = Object.freeze({ stt: 1 });

// docs/09 §9: CPU-bound types run one at a time PER WORKER PROCESS (an
// in-process semaphore in the runner); probe/thumbnail/audio share the media
// queue's concurrency. Scale transcoding by adding worker replicas.
const TYPE_CONCURRENCY = Object.freeze({ transcode: 1, hls: 1, render: 1 });

const STATUSES = Object.freeze(['queued', 'active', 'completed', 'failed', 'cancelled']);

function specFor(type) {
  const spec = JOB_TYPES[type];
  if (!spec) {
    const err = new Error(`unknown job type "${type}"`);
    err.code = 'unknown_job_type';
    err.retryable = false;
    throw err;
  }
  return spec;
}

const BACKOFF_BASE_MS = 5000;
const BACKOFF_FACTOR = 3;
const BACKOFF_CAP_MS = 60 * MIN;

/**
 * docs/10 §2: exponential, base 5 s, factor 3, FULL jitter — the delay is
 * uniform in [0, min(cap, base·factor^(attempt-1))]. `attempt` is 1-based
 * (BullMQ passes attemptsMade, which is 1 after the first failure).
 */
function backoffMs(attempt, random = Math.random) {
  const n = Math.max(1, Number(attempt) || 1);
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, n - 1));
  return Math.floor(random() * ceiling);
}

module.exports = { JOB_TYPES, QUEUES, QUEUE_CONCURRENCY, TYPE_CONCURRENCY, STATUSES, specFor, backoffMs, BACKOFF_BASE_MS, BACKOFF_FACTOR, BACKOFF_CAP_MS };
