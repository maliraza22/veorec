// ─────────────────────────────────────────────────────────────────────────────
// OBSERVABILITY FOUNDATION (T-002) — structured logging + request IDs + Sentry.
//
// One module, three exports used by index.js:
//   logger            pino instance (JSON in production, pretty in dev TTY)
//   httpLogger        per-request middleware: request id + one completion line
//   initSentry()      enables Sentry iff SENTRY_DSN is set; safe no-op otherwise
//   captureException  send an unexpected error to Sentry (no-op when disabled)
//
// Behavior-preservation rules (docs/26 §2, this task):
//   • No API response changes — the only externally visible addition is the
//     X-Request-Id response header.
//   • Never log: tokens, passwords, cookies, signed URLs, request bodies.
//     Request serialization is allowlist-based (method + path only; the query
//     string is stripped because share/reset tokens travel there).
//   • Sentry is never required to start: absent DSN → disabled, absent/broken
//     package → warn and continue.
//   • Process-crash semantics are unchanged: we observe uncaught exceptions via
//     uncaughtExceptionMonitor (never a handler, so Node's default crash-and-
//     exit-1 stands). When Sentry IS enabled, its OnUnhandledRejection
//     integration is pinned to mode:'strict' so a rejection still crashes the
//     process exactly like Node's default — Sentry's default 'warn' mode would
//     silently change that.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const crypto = require('crypto');
const pino = require('pino');
const pinoHttp = require('pino-http');

const IS_PROD = process.env.NODE_ENV === 'production';
const LEVEL = process.env.LOG_LEVEL || (IS_PROD ? 'info' : 'debug');

// Human-readable logs for local dev only (LOG_PRETTY=false forces JSON).
// Production is always structured JSON (docs/19 §2).
let transport;
if (!IS_PROD && process.env.LOG_PRETTY !== 'false') {
  try {
    require.resolve('pino-pretty');
    transport = { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } };
  } catch { /* pino-pretty not installed → JSON */ }
}

const logger = pino({
  level: LEVEL,
  base: { service: 'api' },
  // Belt-and-braces redaction for any object passed to manual log calls.
  // (Request logging below is allowlist-serialized and never includes these.)
  redact: {
    paths: [
      'password', 'currentPassword', 'newPassword', 'token', 'credential',
      'authorization', 'cookie', 'secret', 'apiKey',
      '*.password', '*.currentPassword', '*.newPassword', '*.token',
      '*.credential', '*.authorization', '*.cookie', '*.secret', '*.apiKey',
      'req.headers.authorization', 'req.headers.cookie',
    ],
    censor: '[REDACTED]',
  },
  transport,
});

// ── Request IDs ───────────────────────────────────────────────────────────────
// Accept an inbound X-Request-Id only when it is plainly safe to echo into
// logs/headers (alnum . _ -, 6–64 chars — blocks log injection and abuse of the
// header as a data channel, docs/17 §10 / 19 §1). Anything else → generate.
const REQ_ID_RE = /^[A-Za-z0-9._-]{6,64}$/;
function makeRequestId(req) {
  const h = req.headers['x-request-id'];
  if (typeof h === 'string' && REQ_ID_RE.test(h)) return h;
  return 'req_' + crypto.randomUUID();
}

const httpLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const id = makeRequestId(req);
    res.setHeader('X-Request-Id', id);
    return id;
  },
  // Top-level request_id field on every line written during the request —
  // the canonical correlation key (docs/19 §1).
  customProps: (req) => ({ request_id: req.id }),
  customLogLevel: (req, res, err) =>
    (err || res.statusCode >= 500) ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
  customSuccessMessage: (req, res) =>
    `${req.method} ${String(req.url || '').split('?')[0]} ${res.statusCode}`,
  customErrorMessage: (err, req, res) =>
    `${req.method} ${String(req.url || '').split('?')[0]} ${res.statusCode} — ${err ? err.message : 'error'}`,
  // Allowlist serializers: never headers, never bodies, never query strings.
  serializers: {
    req(req) { return { method: req.method, url: String(req.url || '').split('?')[0] }; },
    res(res) { return { status: res.statusCode }; },
    err: pino.stdSerializers.err,
  },
});

// ── Sentry (optional) ─────────────────────────────────────────────────────────
let Sentry = null;

function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    logger.info('sentry disabled (no SENTRY_DSN)');
    return false;
  }
  try {
    // Required lazily so a missing/broken package can never block boot.
    const S = require('@sentry/node');
    S.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
      release: process.env.SENTRY_RELEASE || undefined,
      tracesSampleRate: 0,          // errors only — no performance tracing yet
      sendDefaultPii: false,
      // 'strict' preserves Node's crash-on-unhandled-rejection default
      // (Sentry's own default mode 'warn' would swallow the crash = behavior change).
      integrations: [S.onUnhandledRejectionIntegration({ mode: 'strict' })],
      beforeSend(event) {
        try {
          if (event.request) {
            delete event.request.data;      // never ship request bodies
            delete event.request.cookies;
            if (event.request.headers) {
              delete event.request.headers.authorization;
              delete event.request.headers.Authorization;
              delete event.request.headers.cookie;
            }
            if (event.request.url) event.request.url = String(event.request.url).split('?')[0];
          }
        } catch { /* scrubbing must never break capture */ }
        return event;
      },
    });
    Sentry = S;
    logger.info({ environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development' }, 'sentry enabled');
    return true;
  } catch (e) {
    Sentry = null;
    logger.warn({ err: e }, 'sentry init failed — continuing without error tracking');
    return false;
  }
}

/**
 * Report a genuine unexpected error to Sentry (expected 4xx flows must not
 * call this). Callers do their own pino logging — this only ships the event.
 * @param {Error} err
 * @param {{requestId?:string, route?:string, method?:string, origin?:string}} ctx
 */
function captureException(err, ctx = {}) {
  if (!Sentry) return;
  try {
    Sentry.withScope((scope) => {
      if (ctx.requestId) scope.setTag('request_id', ctx.requestId);
      if (ctx.route) scope.setTag('route', ctx.route);
      if (ctx.method) scope.setTag('method', ctx.method);
      if (ctx.origin) scope.setTag('origin', ctx.origin);
      Sentry.captureException(err);
    });
  } catch (e) {
    logger.warn({ err: e }, 'sentry capture failed');
  }
}

// Observe fatal crashes without altering Node's default behavior: a MONITOR
// never prevents the default crash/exit(1) the way an 'uncaughtException'
// handler would. Covers unhandled rejections too (Node's default throw mode
// funnels them here with origin 'unhandledRejection').
process.on('uncaughtExceptionMonitor', (err, origin) => {
  try {
    logger.fatal({ err, origin }, 'fatal: ' + (err && err.message ? err.message : origin));
    captureException(err, { origin });
  } catch { /* never throw from the monitor */ }
});

module.exports = { logger, httpLogger, initSentry, captureException, makeRequestId, REQ_ID_RE };
