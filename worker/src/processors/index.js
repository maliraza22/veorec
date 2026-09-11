// Processor registrations for the shipped worker.
//
// T-601 shipped the infrastructure with an EMPTY registry. T-602 registers the
// PostgreSQL-side maintenance jobs (usage_sync + storage verification,
// upload_expiry, cleanup); `subscription_sync` deliberately stays on the
// legacy scheduler until billing lives in PostgreSQL (see maintenance.js).
// T-603 adds stt.transcribe; T-701+ add the media pipeline.
'use strict';

const { createRegistry } = require('../registry');
const { registerMaintenanceProcessors } = require('./maintenance');

function createDefaultRegistry({ logger, maintenance = true } = {}) {
  const registry = createRegistry();
  if (maintenance) registerMaintenanceProcessors(registry);
  if (logger && logger.info) logger.info({ types: registry.types(), missing_types: registry.missing() }, 'processor registry built');
  return registry;
}

module.exports = { createDefaultRegistry, registerMaintenanceProcessors };
