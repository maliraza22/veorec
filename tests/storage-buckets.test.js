// T-202 bucket policy tests (run: cd storage && npm run test:buckets)
//
// Part A — CORS + lifecycle construction and validation. Pure, no infrastructure.
// Part B — provisioner behaviour against a mock S3 client, including the
//          three-valued unsupported/mismatch/failed reporting.
// Part C — live bucket policy against a reachable S3-compatible endpoint;
//          skips loudly when none is available.
//
// The heaviest emphasis is on ONE property: a lifecycle rule must never be able
// to expire durable media. That rule deletes user recordings on a timer with no
// application involvement and no undo, so it is asserted from several angles.
'use strict';

const path = require('path');

const STORAGE_DIR = path.join(__dirname, '..', 'storage');
const {
  buildCorsConfiguration, buildLifecycleConfiguration, assertNoDurableExpiry, assertOrigin,
  ABORT_INCOMPLETE_MULTIPART_DAYS, DURABLE_PREFIXES, TEMP_PREFIX, RULE_ID,
  CORS_EXPOSE_HEADERS,
} = require(path.join(STORAGE_DIR, 'src', 'bucket-config.js'));
const { provisionBucket, STATUS, corsMatches } = require(path.join(STORAGE_DIR, 'src', 'provisioner.js'));
const { loadStorageConfig } = require(path.join(STORAGE_DIR, 'src', 'config.js'));
const AWS = require(require.resolve('@aws-sdk/client-s3', { paths: [STORAGE_DIR] }));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const threws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

const BASE = {
  appEnv: 'test', bucket: 'veorec-media-test',
  corsOrigins: ['https://veorec.com'], corsMaxAgeSeconds: 3600, isDeployed: false,
};

// ── A. CORS construction ─────────────────────────────────────────────────────
function corsTests() {
  console.log('\nA. CORS policy');

  const cfg = buildCorsConfiguration(BASE);
  const rule = cfg.CORSRules[0];
  ok(rule.AllowedOrigins.length === 1 && rule.AllowedOrigins[0] === 'https://veorec.com',
    'origins come from configuration');
  ok(rule.AllowedMethods.includes('PUT'), 'PUT is allowed (browser-direct part upload)');
  ok(rule.AllowedMethods.includes('GET') && rule.AllowedMethods.includes('HEAD'),
    'GET and HEAD are allowed (playback and verification)');
  ok(!rule.AllowedMethods.includes('DELETE'), 'DELETE is NOT allowed from a browser origin');
  ok(!rule.AllowedMethods.includes('POST'), 'POST is not allowed (no browser form uploads)');

  // Without ETag exposed, every browser-direct multipart upload fails at
  // completion, because script cannot read the part etags for the manifest.
  ok(rule.ExposeHeaders.includes('ETag'), 'ETag is exposed — required to build the complete manifest');
  ok(rule.AllowedHeaders.includes('x-amz-checksum-crc32c'), 'the CRC32C checksum header is permitted (docs/06 §9)');
  ok(!rule.AllowedHeaders.map((h) => h.toLowerCase()).includes('content-length'),
    'content-length is not listed — it is browser-controlled and enforced by the SIGNATURE, not CORS');
  ok(Number.isInteger(rule.MaxAgeSeconds) && rule.MaxAgeSeconds > 0, 'preflight max-age is set');

  // ── Wildcards. A "*" origin on a private media bucket would let any page
  // drive a presigned URL that leaked into it.
  for (const bad of ['*', 'https://*.veorec.com', 'http://*']) {
    ok(threws(() => assertOrigin(bad)), `wildcard origin "${bad}" is refused`);
  }
  ok(threws(() => buildCorsConfiguration({ ...BASE, corsOrigins: ['*'] })), 'a wildcard cannot reach the policy');
  ok(threws(() => buildCorsConfiguration({ ...BASE, corsOrigins: [] })),
    'an empty origin list is refused rather than silently allowing nothing');

  // Malformed origins fail at config time, not as mysterious browser errors.
  for (const bad of ['veorec.com', 'https://veorec.com/upload', 'https://veorec.com?a=1', 'ftp://veorec.com', '']) {
    ok(threws(() => assertOrigin(bad)), `malformed origin "${bad || '(empty)'}" is refused`);
  }
  ok(assertOrigin('https://veorec.com:443') === 'https://veorec.com', 'origins are normalised');
  ok(assertOrigin('chrome-extension://abcdefghijklmnopabcdefghijklmnop')
    === 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'a chrome-extension origin is accepted');
  ok(threws(() => assertOrigin('chrome-extension://short')), 'a malformed extension id is refused');

  // ── Plaintext origin policy (T-202 R2 verification).
  // Loopback is the ONE plaintext exception: browsers treat http://localhost as
  // a secure context because the traffic never leaves the machine, and it is
  // what makes a real browser preflight against staging testable. Production
  // stays strict regardless.
  ok(!threws(() => buildCorsConfiguration({
    ...BASE, appEnv: 'local', corsOrigins: ['http://localhost:5173'],
  })), 'loopback http is allowed in local when explicitly configured');
  ok(!threws(() => buildCorsConfiguration({
    ...BASE, appEnv: 'staging', isDeployed: true, corsOrigins: ['http://localhost:5173'],
  })), 'loopback http is allowed in staging when explicitly configured');
  ok(!threws(() => buildCorsConfiguration({
    ...BASE, appEnv: 'staging', isDeployed: true, corsOrigins: ['http://127.0.0.1:5173'],
  })), 'loopback http by IP is allowed in staging');

  // Arbitrary (non-loopback) plaintext origins are refused EVERYWHERE.
  for (const env of ['local', 'test', 'staging', 'production']) {
    ok(threws(() => buildCorsConfiguration({
      ...BASE, appEnv: env, isDeployed: env === 'staging' || env === 'production',
      corsOrigins: ['http://veorec.com'],
    })), `an arbitrary http:// origin is refused in ${env}`);
  }
  ok(threws(() => buildCorsConfiguration({
    ...BASE, appEnv: 'staging', isDeployed: true, corsOrigins: ['http://evil.example.com:5173'],
  })), 'a non-loopback host on the dev port is still refused');
  ok(threws(() => buildCorsConfiguration({
    ...BASE, appEnv: 'staging', isDeployed: true, corsOrigins: ['http://localhost.evil.com'],
  })), 'a hostname merely PREFIXED with localhost is refused');

  // Production refuses every plaintext origin, loopback included.
  ok(threws(() => buildCorsConfiguration({
    ...BASE, appEnv: 'production', isDeployed: true, corsOrigins: ['http://localhost:5173'],
  })), 'production refuses even a loopback http origin');
  ok(threws(() => buildCorsConfiguration({
    ...BASE, appEnv: 'production', isDeployed: true, corsOrigins: ['http://veorec.com'],
  })), 'production refuses a plaintext production origin');
  ok(!threws(() => buildCorsConfiguration({
    ...BASE, appEnv: 'production', isDeployed: true, corsOrigins: ['https://veorec.com'],
  })), 'production accepts an https origin');

  // Wildcards remain refused in every environment.
  for (const env of ['local', 'staging', 'production']) {
    ok(threws(() => buildCorsConfiguration({
      ...BASE, appEnv: env, corsOrigins: ['*'],
    })), `a wildcard origin is refused in ${env}`);
  }
  ok(threws(() => buildCorsConfiguration({
    ...BASE, appEnv: 'staging', corsOrigins: ['http://*.localhost'],
  })), 'a wildcard loopback pattern is refused');

  ok(threws(() => buildCorsConfiguration({
    ...BASE, isDeployed: true, corsOrigins: ['http://veorec.com'],
  })), 'a deployed http:// origin is refused');
  ok(!threws(() => buildCorsConfiguration({
    ...BASE, isDeployed: true, corsOrigins: ['https://veorec.com', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'],
  })), 'https + extension origins are accepted when deployed');

  // No invented production domain may be baked in as a default.
  const savedEnv = process.env.STORAGE_CORS_ORIGINS;
  delete process.env.STORAGE_CORS_ORIGINS;
  const localCfg = loadStorageConfig({ appEnv: 'local' });
  ok(localCfg.corsOrigins.every((o) => /localhost|127\.0\.0\.1/.test(o)),
    'local defaults to loopback dev origins only');
  ok(!localCfg.corsOrigins.some((o) => /veorec\.com/.test(o)),
    'no production domain is invented as a default');
  const deployed = loadStorageConfig({
    appEnv: 'production', endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'veorec-media',
    accessKeyId: 'k', secretAccessKey: 's',
  });
  ok(deployed.corsOrigins.length === 0, 'deployed environments get NO default origins — they must be configured');
  ok(threws(() => buildCorsConfiguration(deployed)),
    'building a deployed CORS policy without configured origins fails loudly');
  if (savedEnv !== undefined) process.env.STORAGE_CORS_ORIGINS = savedEnv;
}

// ── B. Lifecycle construction + the durable-media guarantee ──────────────────
function lifecycleTests() {
  console.log('\nB. Lifecycle policy');

  const lc = buildLifecycleConfiguration();
  const abort = lc.Rules.find((r) => r.AbortIncompleteMultipartUpload);
  const expiry = lc.Rules.find((r) => r.Expiration);

  ok(!!abort, 'an abort-incomplete-multipart rule exists');
  ok(abort.AbortIncompleteMultipartUpload.DaysAfterInitiation === ABORT_INCOMPLETE_MULTIPART_DAYS
    && ABORT_INCOMPLETE_MULTIPART_DAYS === 2, 'incomplete multiparts abort after 48h (2 days)');
  ok(abort.Status === 'Enabled', 'the abort rule is enabled');
  ok(abort.Filter.Prefix === '', 'the abort rule is bucket-wide, so uploads to sources/ are covered too');
  ok(!abort.Expiration, 'the abort rule does NOT expire objects');

  ok(!!expiry, 'a temp-object expiry rule exists');
  ok(expiry.Filter.Prefix === `${TEMP_PREFIX}/`, 'expiry is confined to the uploads-tmp/ namespace');

  // ── THE CRITICAL GUARANTEE: nothing may expire durable media.
  const expiring = lc.Rules.filter((r) => r.Expiration || r.NoncurrentVersionExpiration);
  ok(expiring.length === 1, 'exactly one rule deletes objects');
  ok(expiring.every((r) => r.Filter.Prefix.startsWith(`${TEMP_PREFIX}/`)),
    'every deleting rule is scoped to the temporary namespace');
  for (const durable of DURABLE_PREFIXES) {
    ok(!expiring.some((r) => r.Filter.Prefix.startsWith(durable)),
      `no rule expires the durable prefix "${durable}/"`);
  }

  // The guard must reject hand-written configurations too — this is what stops
  // a future edit from quietly deleting recordings.
  const hostile = [
    { ID: 'x', Filter: { Prefix: '' }, Expiration: { Days: 30 } },
    { ID: 'x', Filter: { Prefix: 'sources/' }, Expiration: { Days: 30 } },
    { ID: 'x', Filter: { Prefix: 'derived/' }, Expiration: { Days: 1 } },
    { ID: 'x', Filter: { Prefix: 'audio/' }, Expiration: { Days: 1 } },
    { ID: 'x', Filter: { Prefix: 'renders/' }, Expiration: { Days: 1 } },
    { ID: 'x', Prefix: 'sources/', Expiration: { Days: 7 } },            // legacy field
    { ID: 'x', Filter: { Prefix: 'sources/' }, NoncurrentVersionExpiration: { NoncurrentDays: 1 } },
  ];
  let blocked = 0;
  for (const rule of hostile) if (threws(() => assertNoDurableExpiry([rule]))) blocked += 1;
  ok(blocked === hostile.length,
    `every rule that could expire durable media is refused (${blocked}/${hostile.length})`);

  // ...while the legitimate shapes still pass.
  ok(!threws(() => assertNoDurableExpiry([
    { ID: 'ok', Filter: { Prefix: 'uploads-tmp/' }, Expiration: { Days: 2 } }])),
    'expiring uploads-tmp/ is permitted');
  ok(!threws(() => assertNoDurableExpiry([
    { ID: 'ok', Filter: { Prefix: '' }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 } }])),
    'a bucket-wide abort rule is permitted (it cannot touch completed objects)');
}

// ── C. Provisioner behaviour (mock client) ───────────────────────────────────
async function provisionerTests() {
  console.log('\nC. Provisioner');

  const cfg = { ...loadStorageConfig({ appEnv: 'test' }), corsOrigins: ['https://veorec.com'] };
  const err = (Code, httpStatusCode = 400) => Object.assign(new Error('x'),
    { Code, name: Code, $metadata: { httpStatusCode } });

  // A backend that implements nothing but HeadBucket — i.e. MinIO's shape.
  const minioish = {
    send: async (cmd) => {
      const n = cmd.constructor.name;
      if (n === 'HeadBucketCommand') return {};
      if (n === 'GetBucketPolicyStatusCommand') return { PolicyStatus: { IsPublic: false } };
      if (n === 'GetBucketCorsCommand') throw err('NoSuchCORSConfiguration', 404);
      if (n === 'PutBucketCorsCommand') throw err('NotImplemented', 501);
      if (n === 'GetBucketLifecycleConfigurationCommand') throw err('NoSuchLifecycleConfiguration', 404);
      if (n === 'PutBucketLifecycleConfigurationCommand') throw err('InvalidArgument', 400);
      throw err('NotImplemented', 501);
    },
  };
  let report = await provisionBucket({ client: minioish, config: cfg, mode: 'apply' });
  const byStep = (needle) => report.steps.find((s) => s.step.includes(needle));
  ok(byStep('CORS applied').status === STATUS.unsupported,
    'a NotImplemented CORS write is reported UNSUPPORTED, not failed');
  ok(byStep('lifecycle applied').status === STATUS.unsupported,
    'a rejected lifecycle write is reported UNSUPPORTED, not failed');
  ok(report.unsupported.length >= 2, 'unsupported settings are collected for the operator');
  ok(/NOT.*verified|not.*confirmed/i.test(report.format()),
    'the report states plainly that unverifiable settings are not confirmed');
  ok(byStep('bucket is private').status === STATUS.ok, 'a non-public bucket passes the privacy check');

  // A public bucket is a hard failure — every recording would be world-readable.
  const publicBucket = {
    send: async (cmd) => {
      const n = cmd.constructor.name;
      if (n === 'HeadBucketCommand') return {};
      if (n === 'GetBucketPolicyStatusCommand') return { PolicyStatus: { IsPublic: true } };
      throw err('NoSuchCORSConfiguration', 404);
    },
  };
  report = await provisionBucket({ client: publicBucket, config: cfg, mode: 'check' });
  ok(report.steps.find((s) => s.step.includes('private')).status === STATUS.failed,
    'a PUBLIC bucket fails the check');
  ok(report.ok === false, 'the overall report is not ok when the bucket is public');

  // A missing bucket stops immediately; we never create one.
  const noBucket = { send: async () => { throw err('NoSuchBucket', 404); } };
  report = await provisionBucket({ client: noBucket, config: cfg, mode: 'apply' });
  ok(report.steps.length === 1 && report.steps[0].status === STATUS.failed,
    'a missing bucket halts provisioning');
  ok(/never creates buckets/.test(report.steps[0].detail), 'and says the tool does not create buckets');

  // A fully compliant backend.
  const good = {
    writes: [],
    send: async function (cmd) {
      const n = cmd.constructor.name;
      if (n === 'HeadBucketCommand') return {};
      if (n === 'GetBucketPolicyStatusCommand') return { PolicyStatus: { IsPublic: false } };
      if (n === 'PutBucketCorsCommand' || n === 'PutBucketLifecycleConfigurationCommand') {
        this.writes.push(n); return {};
      }
      if (n === 'GetBucketCorsCommand') return buildCorsConfiguration(cfg);
      if (n === 'GetBucketLifecycleConfigurationCommand') return buildLifecycleConfiguration();
      throw err('NotImplemented', 501);
    },
  };
  report = await provisionBucket({ client: good, config: cfg, mode: 'check' });
  ok(report.ok === true, 'a correctly configured bucket passes the check');
  ok(good.writes.length === 0, 'CHECK mode performs NO writes');
  ok(report.steps.find((s) => s.step.includes('abort incomplete')).status === STATUS.ok,
    'the 48h abort rule is recognised when present');

  report = await provisionBucket({ client: good, config: cfg, mode: 'apply' });
  ok(good.writes.includes('PutBucketCorsCommand') && good.writes.includes('PutBucketLifecycleConfigurationCommand'),
    'APPLY mode writes both CORS and lifecycle');

  // A bucket whose lifecycle would expire durable media must be refused even
  // when it is what the bucket already reports.
  const dangerous = {
    send: async (cmd) => {
      const n = cmd.constructor.name;
      if (n === 'HeadBucketCommand') return {};
      if (n === 'GetBucketPolicyStatusCommand') return { PolicyStatus: { IsPublic: false } };
      if (n === 'GetBucketLifecycleConfigurationCommand') {
        return { Rules: [{ ID: 'rogue', Status: 'Enabled', Filter: { Prefix: 'sources/' }, Expiration: { Days: 30 } }] };
      }
      throw err('NoSuchCORSConfiguration', 404);
    },
  };
  report = await provisionBucket({ client: dangerous, config: cfg, mode: 'check' });
  ok(report.steps.some((s) => s.status === STATUS.failed && /durable|sources/i.test(s.detail || '')),
    'a pre-existing rule expiring sources/ is reported as a failure');

  // Comparison helper
  const intended = buildCorsConfiguration(cfg);
  ok(corsMatches(intended, intended), 'an identical CORS policy matches');
  ok(!corsMatches(intended, { CORSRules: [{ AllowedOrigins: ['https://evil.com'], AllowedMethods: ['GET', 'HEAD', 'PUT'], ExposeHeaders: CORS_EXPOSE_HEADERS }] }),
    'a different origin does not match');
  ok(!corsMatches(intended, { CORSRules: [{ AllowedOrigins: ['https://veorec.com'], AllowedMethods: ['GET', 'HEAD', 'PUT'], ExposeHeaders: [] }] }),
    'a policy missing the exposed ETag does not match');
}

// ── D. Live endpoint (skips loudly) ──────────────────────────────────────────
async function liveTests() {
  console.log('\nD. Live bucket policy');
  const { S3Client, HeadBucketCommand } = AWS;
  const cfg = loadStorageConfig({ appEnv: process.env.APP_ENV || 'test' });
  // keepAlive:false matters here. With pooled sockets left open, Node's
  // teardown on Windows trips a libuv assertion (UV_HANDLE_CLOSING) AFTER the
  // results are printed, so the process exits 127 with every assertion passing
  // — a green suite CI would read as a failure. Closing each connection keeps
  // the exit code honest.
  const http = require('http');
  const client = new S3Client({
    region: cfg.region, endpoint: cfg.endpoint, forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    maxAttempts: 1,
    requestHandler: { requestTimeout: 3000, httpAgent: new http.Agent({ keepAlive: false }) },
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
  } catch (e) {
    console.log(`  SKIPPED — no reachable bucket at ${cfg.endpoint} (${e.Code || e.name})`);
    console.log('  Bucket policy was NOT verified against a live endpoint by this run.');
    if (process.env.STORAGE_TESTS_REQUIRED === '1') { fail++; console.log('  FAIL: STORAGE_TESTS_REQUIRED=1'); }
    return;
  }

  const report = await provisionBucket({ client, config: cfg, mode: 'check' });
  ok(report.steps.find((s) => s.step === 'bucket exists').status === STATUS.ok, 'the live bucket exists');
  const priv = report.steps.find((s) => s.step.includes('private'));
  ok(priv && priv.status !== STATUS.failed, 'the live bucket is not public');

  // Record, rather than assert, what this backend cannot do — MinIO implements
  // neither bucket CORS nor abort-incomplete-multipart, and pretending
  // otherwise would be a false verification.
  for (const s of report.unsupported) console.log(`  NOTE: not verifiable here — ${s.step}: ${s.detail}`);

  // PARTIAL verification of the lifecycle policy.
  // The combined policy is rejected here only because of the abort rule, so
  // apply the expiry rule ALONE to prove that half is well-formed against a
  // real S3 implementation. This does not verify the abort rule, and the
  // shipped configuration is NOT split — R2 takes both together.
  const {
    PutBucketLifecycleConfigurationCommand, GetBucketLifecycleConfigurationCommand,
    DeleteBucketLifecycleCommand,
  } = AWS;
  const full = buildLifecycleConfiguration();
  const expiryOnly = { Rules: full.Rules.filter((r) => r.Expiration) };
  try {
    await client.send(new PutBucketLifecycleConfigurationCommand({
      Bucket: cfg.bucket, LifecycleConfiguration: expiryOnly,
    }));
    const back = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: cfg.bucket }));
    const rule = (back.Rules || []).find((r) => r.Expiration);
    ok(!!rule, 'PARTIAL: the uploads-tmp expiry rule is accepted and read back by a real S3 backend');
    ok(rule && rule.Filter && rule.Filter.Prefix === `${TEMP_PREFIX}/`,
      'PARTIAL: the stored expiry rule is scoped to uploads-tmp/ on the live bucket');
    ok(!threws(() => assertNoDurableExpiry(back.Rules)),
      'PARTIAL: the live lifecycle configuration expires no durable prefix');
    await client.send(new DeleteBucketLifecycleCommand({ Bucket: cfg.bucket })).catch(() => {});
  } catch (e) {
    console.log(`  NOTE: expiry-only lifecycle also unsupported here (${e.Code || e.name})`);
  }

  // Acceptance half that IS locally checkable (docs/24 T-202): an unsigned GET
  // must fail. The other half — a presigned PUT from a *browser origin* —
  // needs bucket CORS and a real browser, so it stays pending R2.
  const probeKey = 'uploads-tmp/ct_policy_probe/source.webm';
  const { PutObjectCommand, DeleteObjectCommand } = AWS;
  await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: probeKey, Body: Buffer.from('x') }));
  // Plain http rather than global fetch: undici's dispatcher and the SDK's
  // agent tearing down together abort the process on Windows after the results
  // are printed, corrupting an otherwise-green exit code.
  const anonStatus = await new Promise((resolve, reject) => {
    http.get(`${cfg.endpoint}/${cfg.bucket}/${probeKey}`, { agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
  ok(anonStatus >= 400, `an unauthorized GET is refused (status ${anonStatus}) — the bucket is private`);
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: probeKey })).catch(() => {});
}

(async () => {
  console.log('T-202 bucket policy tests');
  corsTests();
  lifecycleTests();
  await provisionerTests();
  await liveTests();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
