#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// export-legacy-media — the ONLY file in the migration tooling that touches
// Cloudinary (T-104). READ-ONLY: it lists assets and writes a JSON file.
//
//   cd db && node src/migration/export-legacy-media.js --out=media.json
//
// Cloudinary is a MIGRATION SOURCE, not part of the target architecture
// (docs/02 §2.7). Keeping it in this single exporter means:
//   • `db/` gains no Cloudinary dependency — the SDK is resolved from the
//     LEGACY server's node_modules, where it already exists;
//   • the importer itself only ever reads a plain JSON file and knows nothing
//     about any provider;
//   • Phase 14 deletes this file and nothing else changes.
//
// Requires the same credentials the legacy server uses:
//   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function loadLegacyCloudinary() {
  const serverPkg = path.join(REPO_ROOT, 'server', 'package.json');
  if (!fs.existsSync(serverPkg)) {
    throw new Error('legacy server/ directory not found — cannot resolve the Cloudinary SDK');
  }
  try {
    // Resolve from the legacy server so db/ never declares the dependency.
    return createRequire(serverPkg)('cloudinary').v2;
  } catch (err) {
    throw new Error(`could not load the Cloudinary SDK from server/node_modules: ${err.message}\n` +
      'run `cd server && npm install` first (this is legacy tooling only)');
  }
}

async function main() {
  const outArg = process.argv.slice(2).find((a) => a.startsWith('--out='));
  const out = outArg ? outArg.slice('--out='.length) : 'legacy-media.json';

  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    console.error('[export] missing CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET');
    console.error('[export] these are the LEGACY credentials — needed only to read existing media');
    process.exit(1);
  }

  const cloudinary = loadLegacyCloudinary();
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME, api_key: CLOUDINARY_API_KEY, api_secret: CLOUDINARY_API_SECRET,
  });

  // Admin API (immediately consistent) rather than the Search API, whose index
  // lag is one of the reasons this migration exists (docs/01 §2.1).
  const resources = [];
  let nextCursor;
  do {
    const page = await cloudinary.api.resources({
      resource_type: 'video', type: 'upload', prefix: 'screenrec/',
      max_results: 500, context: true, next_cursor: nextCursor,
    });
    for (const r of page.resources || []) {
      resources.push({
        public_id: r.public_id, secure_url: r.secure_url, bytes: r.bytes, duration: r.duration,
        width: r.width, height: r.height, format: r.format, created_at: r.created_at,
        context: (r.context && r.context.custom) || {},
      });
    }
    nextCursor = page.next_cursor;
    console.error(`[export] listed ${resources.length} assets…`);
  } while (nextCursor);

  fs.writeFileSync(out, JSON.stringify({
    exportedAt: new Date().toISOString(), provider: 'cloudinary', count: resources.length, resources,
  }, null, 2));
  console.error(`[export] wrote ${resources.length} legacy media records → ${out}`);
  console.error('[export] Cloudinary was READ ONLY: nothing was modified, renamed or deleted');
}

main().catch((err) => {
  console.error(`[export] FAILED: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
