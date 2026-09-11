// Worker/job error model (docs/18 §6).
//
// A processor classifies its failures: TransientError (infra, rate limit,
// timeout → retry with backoff) vs TerminalError (deterministic: corrupt input,
// invalid state → fail fast and apply the job's declared user-visible failure
// state). An unknown exception is transient until the attempts run out.
'use strict';

class JobError extends Error {
  constructor(code, message, options = {}) {
    super(message || code);
    this.name = this.constructor.name;
    this.code = code;
    this.retryable = options.retryable !== undefined ? !!options.retryable : true;
    if (options.stderrTail) this.stderrTail = String(options.stderrTail).slice(-2048);
    if (options.cause) this.cause = options.cause;
  }
}

class TransientError extends JobError {
  constructor(code, message, options = {}) { super(code, message, { ...options, retryable: true }); }
}

class TerminalError extends JobError {
  constructor(code, message, options = {}) { super(code, message, { ...options, retryable: false }); }
}

/**
 * "Not now, not here": the delivery must go back to the transport untouched
 * (e.g. this worker has no processor for the type — a rolling deploy where an
 * older worker shares the queue). Not a failure: no attempt is consumed.
 */
class DeferredError extends JobError {
  constructor(code, message, options = {}) {
    super(code, message, { ...options, retryable: true });
    this.defer = true;
    this.deferMs = options.deferMs || 5000;
  }
}

/** Deterministic failure ⇒ no retry. Anything else keeps retrying. */
function isTerminal(err) { return !!err && err.retryable === false; }

/** `last_error` text: code + message (+ ffmpeg stderr tail ≤ 2 KB, docs/19 §2). */
function formatError(err) {
  if (!err) return 'unknown error';
  const head = err.code ? `${err.code}: ${err.message || ''}` : String(err.message || err);
  const tail = err.stderrTail ? `\n--- stderr tail ---\n${String(err.stderrTail).slice(-2048)}` : '';
  return (head + tail).slice(0, 4000);
}

module.exports = { JobError, TransientError, TerminalError, DeferredError, isTerminal, formatError };
