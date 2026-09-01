// ─────────────────────────────────────────────────────────────────────────────
// IDENTIFIERS (docs/07 §1)
//
// Application-generated, prefixed, time-sortable IDs: `<prefix>_<uuidv7>`.
// UUIDv7 puts a millisecond timestamp in the high bits, so ids sort by creation
// time — which keeps B-tree inserts local and makes id order a useful proxy for
// chronological order. Implemented here (≈15 lines) rather than adding a
// dependency for it.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const crypto = require('crypto');

const PREFIXES = {
  user: 'usr', session: 'ses', workspace: 'ws', recording: 'rec', asset: 'ast',
  uploadSession: 'up', reservation: 'rsv', folder: 'fld', shareLink: 'shl',
  comment: 'cmt', reaction: 'rct', viewSession: 'vs', lead: 'led',
  transcript: 'trs', editSession: 'eds', renderJob: 'rnd', job: 'job',
  subscription: 'sub', contact: 'ctc',
};

/** RFC 9562 UUIDv7: 48-bit big-endian timestamp + 74 random bits. */
function uuidv7(now = Date.now()) {
  const b = crypto.randomBytes(16);
  const ts = BigInt(now);
  b[0] = Number((ts >> 40n) & 0xffn);
  b[1] = Number((ts >> 32n) & 0xffn);
  b[2] = Number((ts >> 24n) & 0xffn);
  b[3] = Number((ts >> 16n) & 0xffn);
  b[4] = Number((ts >> 8n) & 0xffn);
  b[5] = Number(ts & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;   // version 7
  b[8] = (b[8] & 0x3f) | 0x80;   // RFC 4122 variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** @param {keyof PREFIXES} kind */
function newId(kind) {
  const prefix = PREFIXES[kind];
  if (!prefix) throw new Error(`unknown id kind: ${kind}`);
  return `${prefix}_${uuidv7()}`;
}

module.exports = { newId, uuidv7, PREFIXES };
