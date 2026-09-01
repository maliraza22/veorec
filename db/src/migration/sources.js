// ─────────────────────────────────────────────────────────────────────────────
// LEGACY SOURCES (T-104) — STRICTLY READ-ONLY
//
// Every reader here opens a file for reading and nothing else. The importer is
// additive: it must never delete, rewrite, rename or transform a legacy source.
// There is deliberately no write path in this module.
//
// Sources (docs/01 §2.2):
//   users.json, meta.json, folders.json, subscriptions.json, usage.json,
//   contacts.json, notif-reads.json, plan_overrides.json, upgrade_events.json,
//   recordings.json (local-mode store)
//   + a MEDIA LISTING export describing where legacy media currently lives.
//
// The media listing is a plain JSON file produced by export-legacy-media.js.
// Consuming a file rather than calling Cloudinary keeps this importer free of
// any Cloudinary dependency — Cloudinary knowledge is confined to the exporter.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

/** Read a JSON file. Missing file → `fallback`; malformed → throws (loudly). */
function readJsonFile(file, fallback) {
  if (!fs.existsSync(file)) return { value: fallback, present: false };
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.trim() === '') return { value: fallback, present: true };
  try {
    return { value: JSON.parse(raw), present: true };
  } catch (err) {
    // Never "recover" by pretending the dataset is empty — the legacy stores do
    // exactly that on read (docs/01 §2.2) and it is how data silently vanishes.
    throw new Error(`legacy source ${path.basename(file)} is not valid JSON: ${err.message}`);
  }
}

const asArray = (v) => (Array.isArray(v) ? v : []);
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/**
 * Open the legacy data directory.
 * @param {string} dataDir directory holding the JSON stores (Railway volume copy)
 * @param {string|null} mediaListingFile export produced by export-legacy-media.js
 */
function openLegacySources(dataDir, mediaListingFile = null) {
  const file = (name) => path.join(dataDir, name);
  const present = {};
  const read = (name, fallback, coerce) => {
    const { value, present: found } = readJsonFile(file(name), fallback);
    present[name] = found;
    return coerce(value);
  };

  const sources = {
    dataDir,
    users: read('users.json', [], asArray),
    meta: read('meta.json', {}, asObject),
    folders: read('folders.json', [], asArray),
    subscriptions: read('subscriptions.json', {}, asObject),
    usage: read('usage.json', {}, asObject),
    contacts: read('contacts.json', {}, asObject),
    notifReads: read('notif-reads.json', {}, asObject),
    planOverrides: read('plan_overrides.json', {}, asObject),
    upgradeEvents: read('upgrade_events.json', [], asArray),
    localRecordings: read('recordings.json', [], asArray),
    mediaListing: [],
    present,
    mediaListingPresent: false,
  };

  if (mediaListingFile) {
    const { value, present: found } = readJsonFile(mediaListingFile, []);
    sources.mediaListingPresent = found;
    // Accept either a bare array or the exporter's { resources: [...] } envelope.
    sources.mediaListing = Array.isArray(value) ? value : asArray(value.resources);
  }

  return sources;
}

/**
 * Fingerprint every source file so a run can prove it did not modify them.
 * Used by the tests (and worth running in production before/after a real import).
 */
function fingerprintSources(dataDir, mediaListingFile = null) {
  const crypto = require('crypto');
  const names = ['users.json', 'meta.json', 'folders.json', 'subscriptions.json', 'usage.json',
    'contacts.json', 'notif-reads.json', 'plan_overrides.json', 'upgrade_events.json', 'recordings.json'];
  const out = {};
  for (const name of names) {
    const f = path.join(dataDir, name);
    out[name] = fs.existsSync(f)
      ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
      : null;
  }
  if (mediaListingFile && fs.existsSync(mediaListingFile)) {
    out['<media-listing>'] = crypto.createHash('sha256').update(fs.readFileSync(mediaListingFile)).digest('hex');
  }
  return out;
}

module.exports = { openLegacySources, fingerprintSources, readJsonFile };
