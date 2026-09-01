// Deterministic legacy → PostgreSQL identifier mapping (T-104/T-105).
//
// Shared by the bulk importer and the runtime dual-write mirror so both produce
// the SAME primary keys. If these two ever diverged, re-importing would create
// duplicates instead of converging — so there is exactly one implementation.
'use strict';

const crypto = require('crypto');

/** `rec_<legacyUuid>` — a pure function of the legacy identifier. */
const idFor = (prefix, legacyId) => `${prefix}_${legacyId}`;

/** Stable surrogate for legacy records that never had an id (reactions, views). */
const derivedId = (prefix, ...parts) =>
  `${prefix}_${crypto.createHash('sha256').update(parts.map((p) => String(p ?? '')).join(' ')).digest('hex').slice(0, 32)}`;

module.exports = { idFor, derivedId };
