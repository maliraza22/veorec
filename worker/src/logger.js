// Worker logger (docs/19 §2): JSON lines, service=worker, the same redaction
// paths as the API logger (server/log.js) so a payload passed to a log call can
// never print a token or a secret. Never console.log in worker code (docs/26).
'use strict';

const pino = require('pino');

const REDACT_PATHS = [
  'password', 'currentPassword', 'newPassword', 'token', 'credential',
  'authorization', 'cookie', 'secret', 'apiKey',
  '*.password', '*.currentPassword', '*.newPassword', '*.token',
  '*.credential', '*.authorization', '*.cookie', '*.secret', '*.apiKey',
];

function createLogger({ level, pretty, env = process.env } = {}) {
  const isProd = env.NODE_ENV === 'production';
  const lvl = level || env.LOG_LEVEL || (isProd ? 'info' : 'debug');
  let transport;
  const wantPretty = pretty !== undefined ? pretty : (!isProd && env.LOG_PRETTY !== 'false');
  if (wantPretty) {
    try {
      require.resolve('pino-pretty');
      transport = { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } };
    } catch { /* JSON */ }
  }
  return pino({
    level: lvl,
    base: { service: 'worker', env: env.APP_ENV || 'local' },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    transport,
  });
}

/** A logger that records nothing — for tests and for the inline queue in the API. */
function silentLogger() {
  const l = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return l; } };
  return l;
}

module.exports = { createLogger, silentLogger, REDACT_PATHS };
