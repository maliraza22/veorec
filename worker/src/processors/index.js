// Processor registrations for the shipped worker.
//
// T-601 ships the INFRASTRUCTURE: the relay, the runner, the consumers and the
// admin surface. It registers no media/stt/ai processors on purpose — those are
// Phase 6–7 tasks (T-602 maintenance, T-603 transcription, T-701+ media). A
// worker with an empty registry still does real work: it relays every
// committed outbox row (the probe rows T-301 already writes) into the
// transport, where they wait for the workers that will consume them, and the
// reconciler keeps them there across a Redis loss.
'use strict';

const { createRegistry } = require('../registry');

function createDefaultRegistry({ logger } = {}) {
  const registry = createRegistry();
  // T-602 registers maintenance.*; T-603 stt.transcribe; T-701+ media.*.
  if (logger && logger.info) logger.info({ types: registry.types(), missing_types: registry.missing() }, 'processor registry built');
  return registry;
}

module.exports = { createDefaultRegistry };
