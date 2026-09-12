// Processor registrations for the shipped worker.
//
// T-601 shipped the infrastructure with an EMPTY registry. T-602 registered
// the PostgreSQL-side maintenance jobs (usage_sync + storage verification,
// upload_expiry, cleanup); `subscription_sync` deliberately stays on the
// legacy scheduler until billing lives in PostgreSQL (see maintenance.js).
// T-603 registered stt.transcribe / stt.translate and the ai.* chain (the
// transcriber/ai instances arrive through deps, built in main.js from env).
// T-701 registered media.probe (the prober arrives through deps); T-702+ add
// transcode, thumbnail, audio_extract/captions, hls.
'use strict';

const { createRegistry } = require('../registry');
const { registerMaintenanceProcessors } = require('./maintenance');
const { registerSttProcessors } = require('./stt');
const { registerMediaProcessors } = require('./media');
const { registerEditingProcessors } = require('./render');

// T-1202/T-1204 registered render + silence_detect (the renderer arrives through deps).
function createDefaultRegistry({ logger, maintenance = true, stt = true, media = true, editing = true } = {}) {
  const registry = createRegistry();
  if (maintenance) registerMaintenanceProcessors(registry);
  if (stt) registerSttProcessors(registry);
  if (media) registerMediaProcessors(registry);
  if (editing) registerEditingProcessors(registry);
  if (logger && logger.info) logger.info({ types: registry.types(), missing_types: registry.missing() }, 'processor registry built');
  return registry;
}

module.exports = { createDefaultRegistry, registerMaintenanceProcessors, registerSttProcessors, registerMediaProcessors, registerEditingProcessors };
