#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// storage:provision — bucket policy check/apply (T-202)
//
//   cd storage
//   npm run storage:provision              # CHECK, read-only (default)
//   npm run storage:provision -- --apply   # write CORS + lifecycle
//
// DEFAULT IS READ-ONLY. Provisioning changes how a production bucket behaves —
// including a rule that deletes objects on a timer — so it never happens as a
// side effect of inspecting one.
//
// Exit codes: 0 policy correct (or only unverifiable-here settings remain)
//             2 policy differs / missing
//             1 error
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { S3Client } = require('@aws-sdk/client-s3');
const { loadStorageConfig } = require('../config');
const { provisionBucket } = require('../provisioner');

const USAGE = `
storage:provision — verify or apply the VeoRec bucket policy (T-202)

  --check     verify only, no writes (DEFAULT)
  --apply     apply CORS + lifecycle to the configured bucket
  --json      machine-readable report
  --help

Configuration comes from the environment (see .env.example):
  STORAGE_ENDPOINT / STORAGE_BUCKET / STORAGE_ACCESS_KEY_ID /
  STORAGE_SECRET_ACCESS_KEY / STORAGE_CORS_ORIGINS

This tool never creates a bucket and never deletes an object.
`;

function parseArgs(argv) {
  const a = { mode: 'check', json: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--check') a.mode = 'check';
    else if (arg === '--apply') a.mode = 'apply';
    else if (arg === '--json') a.json = true;
    else if (arg === '--help' || arg === '-h') a.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(USAGE); process.exit(0); }

  const config = loadStorageConfig();
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: config.maxAttempts,
    requestHandler: { requestTimeout: config.requestTimeoutMs },
  });

  console.log(`[provision] ${JSON.stringify(config.describe())}`);
  console.log(args.mode === 'apply'
    ? '[provision] APPLY mode — CORS and lifecycle will be written to this bucket'
    : '[provision] CHECK mode — no changes will be made');

  const report = await provisionBucket({ client, config, mode: args.mode });

  if (args.json) console.log(JSON.stringify(report.toJSON(), null, 2));
  else console.log(report.format());

  const problems = report.problems.length;
  const unverifiable = report.unsupported.length;
  console.log(`\n[provision] ${problems ? `${problems} problem(s)` : 'policy correct'}` +
    (unverifiable ? ` · ${unverifiable} setting(s) NOT verifiable against this backend` : ''));

  if (problems) process.exitCode = 2;
}

main().catch((err) => {
  console.error(`[provision] FAILED: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
