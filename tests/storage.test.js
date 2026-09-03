// T-201 storage unit tests (run: cd storage && npm run test:unit)
//
// Everything here runs WITHOUT an object store: key building/validation,
// configuration resolution and secret hygiene, the error taxonomy, and
// presigned-URL generation.
//
// Presigning needs no server — the SDK computes a real SigV4 signature
// locally — so URL structure, method binding, object scoping, expiry capping
// and Content-Length signing are genuinely verified here, not mocked. What
// still needs a live endpoint (round-tripping bytes, multipart) lives in
// tests/storage-contract.test.js.
'use strict';

const path = require('path');
const { Readable } = require('stream');

const STORAGE_DIR = path.join(__dirname, '..', 'storage');
const S = require(path.join(STORAGE_DIR, 'src', 'index.js'));
const { loadStorageConfig } = require(path.join(STORAGE_DIR, 'src', 'config.js'));
const { keys, assertKey, isValidKey } = require(path.join(STORAGE_DIR, 'src', 'keys.js'));
const { mapStorageError } = require(path.join(STORAGE_DIR, 'src', 'errors.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const threws = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const arejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// Test-only credentials. Syntactically valid, never real, never a live account.
const TEST_CONFIG = {
  appEnv: 'test',
  flavour: 'minio',
  endpoint: 'http://127.0.0.1:9100',
  region: 'auto',
  bucket: 'veorec-media-test',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  forcePathStyle: true,
};

// ── A. Object keys ───────────────────────────────────────────────────────────
function keyTests() {
  console.log('\nA. Object key strategy');

  // Canonical layout (docs/02 §2.7)
  ok(keys.source('rec_abc') === 'sources/rec_abc/source.webm', 'source key matches the canonical layout');
  ok(keys.source('rec_abc', 'mp4') === 'sources/rec_abc/source.mp4', 'source honours the server-chosen container');
  ok(keys.derivedVideo('rec_abc', 'ast_1') === 'derived/rec_abc/ast_1/video.mp4', 'derived MP4 key');
  ok(keys.hlsMaster('rec_abc', 'ast_1') === 'derived/rec_abc/ast_1/hls/master.m3u8', 'HLS master key');
  ok(keys.hlsSegment('rec_abc', 'ast_1', 'seg_00001.m4s') === 'derived/rec_abc/ast_1/hls/seg_00001.m4s', 'HLS segment key');
  ok(keys.image('rec_abc', 'ast_1', 'poster') === 'derived/rec_abc/ast_1/poster.jpg', 'poster key');
  ok(keys.image('rec_abc', 'ast_1', 'thumb') === 'derived/rec_abc/ast_1/thumb.jpg', 'thumb key');
  ok(keys.audio('rec_abc') === 'audio/rec_abc/audio.m4a', 'audio key');
  ok(keys.render('es_1', 'job_2') === 'renders/es_1/job_2.mp4', 'render key');
  ok(keys.uploadTemp('ups_1') === 'uploads-tmp/ups_1/source.webm', 'multipart scratch key');

  // Deterministic — the property that makes retried copies idempotent.
  ok(keys.source('rec_abc') === keys.source('rec_abc'), 'source keys are deterministic');

  // Media classes are separated by prefix so lifecycle rules can target them.
  const prefixes = new Set([
    keys.source('r').split('/')[0], keys.derivedVideo('r', 'a').split('/')[0],
    keys.audio('r').split('/')[0], keys.render('e', 'j').split('/')[0],
    keys.uploadTemp('u').split('/')[0],
  ]);
  ok(prefixes.size === 5, 'originals, derived, audio, renders and scratch are separated');

  // ── Traversal and injection. Each of these, unblocked, reads another tenant.
  const hostile = [
    '../../etc/passwd', 'sources/../../secret', '/etc/passwd', 'sources//double',
    'sources/./here', 'sources/rec/..', 'a\\b', 'sources/%2e%2e/x', 'key .mp4',
    'has space/x', 'trailing/', '', 'sources/rec/',
  ];
  let blocked = 0;
  for (const k of hostile) if (threws(() => assertKey(k))) blocked += 1;
  ok(blocked === hostile.length, `every hostile key is rejected (${blocked}/${hostile.length})`);
  ok(isValidKey('sources/rec_abc/source.webm'), 'a legitimate key validates');
  ok(!isValidKey('../x'), 'isValidKey reports rather than throws');

  // Traversal via the *identifier*, which is the realistic injection point.
  ok(threws(() => keys.source('../../etc')), 'traversal in recordingId is rejected');
  ok(threws(() => keys.source('rec/abc')), 'a slash in recordingId is rejected');
  ok(threws(() => keys.derivedVideo('rec_abc', '../x')), 'traversal in assetId is rejected');
  ok(threws(() => keys.hlsSegment('r', 'a', '../../x')), 'traversal in a segment name is rejected');
  ok(threws(() => keys.source('')), 'an empty id is rejected');
  ok(threws(() => keys.source('a'.repeat(200))), 'an over-long id is rejected');

  // The rejection must not echo the attacker's string back into logs.
  const err = threws(() => keys.source('../../etc/passwd'));
  ok(err && !err.message.includes('..'), 'the error does not echo the hostile value');

  // Client filenames are never trusted as paths or extensions.
  ok(threws(() => keys.source('rec_abc', 'exe')), 'an unknown container is rejected');
  ok(threws(() => keys.source('rec_abc', '../../x')), 'a container cannot smuggle a path');
  ok(threws(() => keys.image('r', 'a', 'evil')), 'an unknown image kind is rejected');

  ok(threws(() => assertKey('a'.repeat(1025))), 'an over-long key is rejected');

  // Keys carry opaque ids only — no email/name reaches storage.
  ok(!keys.source('rec_abc').includes('@'), 'keys carry no personal data');
}

// ── B. Configuration + secret hygiene ────────────────────────────────────────
function configTests() {
  console.log('\nB. Configuration');

  const cfg = loadStorageConfig(TEST_CONFIG);
  ok(cfg.bucket === 'veorec-media-test' && cfg.forcePathStyle === true, 'resolves explicit configuration');

  // Deployed environments must be explicit — never guess, never fall back local.
  // Cleared explicitly so a developer's local .env cannot change the outcome.
  const saved = {};
  for (const k of ['STORAGE_ENDPOINT', 'STORAGE_BUCKET', 'STORAGE_ACCESS_KEY_ID',
    'STORAGE_SECRET_ACCESS_KEY', 'STORAGE_PROVIDER']) {
    saved[k] = process.env[k]; delete process.env[k];
  }
  let e = threws(() => loadStorageConfig({ appEnv: 'production' }));
  ok(e && /missing storage configuration/.test(e.message), 'production requires explicit configuration');
  ok(e && /refuse to guess/.test(e.message), 'and says it refuses to guess rather than defaulting');
  e = threws(() => loadStorageConfig({ appEnv: 'staging' }));
  ok(e, 'staging requires explicit configuration');
  const localCfg = loadStorageConfig({ appEnv: 'local' });
  ok(localCfg.endpoint === 'http://127.0.0.1:9100', 'local falls back to the documented MinIO default');
  ok(localCfg.flavour === 'minio', 'local defaults to the MinIO flavour');
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;

  // Production defaults to R2 without any code branching on it.
  // (flavour deliberately omitted — this asserts the DEFAULT, not an override.)
  const { flavour: _ignored, ...noFlavour } = TEST_CONFIG;
  const r2 = loadStorageConfig({
    ...noFlavour, appEnv: 'production',
    endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'veorec-media',
  });
  ok(r2.flavour === 'r2', 'deployed environments default to the R2 flavour');

  // Transport safety
  ok(threws(() => loadStorageConfig({ ...TEST_CONFIG, appEnv: 'production', endpoint: 'http://r2.example.com' })),
    'production refuses a plaintext endpoint');
  ok(threws(() => loadStorageConfig({ ...TEST_CONFIG, endpoint: 'http://storage.example.com' })),
    'http is refused for a non-loopback host');
  ok(!threws(() => loadStorageConfig({ ...TEST_CONFIG, endpoint: 'http://localhost:9100' })),
    'http is allowed for loopback (MinIO)');
  ok(threws(() => loadStorageConfig({ ...TEST_CONFIG, endpoint: 'ftp://x.com' })), 'a non-HTTP scheme is refused');
  ok(threws(() => loadStorageConfig({ ...TEST_CONFIG, endpoint: 'not-a-url' })), 'a malformed endpoint is refused');

  // Bucket comes from configuration, and must be a real bucket name.
  ok(threws(() => loadStorageConfig({ ...TEST_CONFIG, bucket: '../other-bucket' })), 'an injected bucket path is refused');
  ok(threws(() => loadStorageConfig({ ...TEST_CONFIG, bucket: 'UPPER' })), 'an invalid bucket name is refused');

  ok(threws(() => loadStorageConfig({ ...TEST_CONFIG, appEnv: 'nope' })), 'an unknown APP_ENV is refused');
  ok(threws(() => loadStorageConfig({ ...TEST_CONFIG, flavour: 'cloudinary' })),
    'Cloudinary is not an available storage flavour');

  // ── Secrets must not escape through any printing path.
  const described = JSON.stringify(cfg.describe());
  ok(!described.includes(TEST_CONFIG.secretAccessKey), 'describe() omits the secret key');
  ok(!described.includes(TEST_CONFIG.accessKeyId), 'describe() does not print the full access key id');
  ok(described.includes('***'), 'describe() masks the access key id');
  ok(!JSON.stringify(cfg).includes(TEST_CONFIG.secretAccessKey), 'JSON.stringify(config) omits the secret');
  ok(!require('util').inspect(cfg).includes(TEST_CONFIG.secretAccessKey),
    'util.inspect(config) omits the secret (console.log path)');
  const provider = S.createStorageProvider({ ...TEST_CONFIG, client: {} });
  ok(!JSON.stringify(provider.describe()).includes(TEST_CONFIG.secretAccessKey),
    'provider.describe() omits the secret');

  // TTL ceiling is configuration, not a constant callers can talk past.
  ok(threws(() => loadStorageConfig({ ...TEST_CONFIG, maxSignedUrlTtlSeconds: 99_999_999 })),
    'a TTL ceiling beyond the SigV4 maximum is refused');
}

// ── C. Error taxonomy ────────────────────────────────────────────────────────
function errorTests() {
  console.log('\nC. Error model');

  const s3err = (Code, httpStatusCode) => Object.assign(new Error('raw sdk text'),
    { Code, name: Code, $metadata: { httpStatusCode, requestId: 'req-123' } });

  const cases = [
    ['NoSuchKey', 404, 'object_not_found', false],
    ['NotFound', 404, 'object_not_found', false],
    ['AccessDenied', 403, 'permission_denied', false],
    ['InvalidAccessKeyId', 403, 'permission_denied', false],
    ['SignatureDoesNotMatch', 403, 'permission_denied', false],
    ['NoSuchUpload', 404, 'upload_not_found', false],
    ['InvalidPart', 400, 'multipart_failed', false],
    ['EntityTooSmall', 400, 'multipart_failed', false],
    ['PreconditionFailed', 412, 'conflict', false],
    ['InvalidArgument', 400, 'invalid_request', false],
    ['InternalError', 500, 'provider_unavailable', true],
    ['ServiceUnavailable', 503, 'provider_unavailable', true],
    ['SlowDown', 503, 'provider_unavailable', true],
    ['RequestTimeout', 408, 'timeout', true],
  ];
  let mapped = 0;
  for (const [code, status, expected, retryable] of cases) {
    const e = mapStorageError(s3err(code, status), { operation: 'getObject', key: 'sources/r/source.webm' });
    if (e.code === expected && e.retryable === retryable) mapped += 1;
    else console.log(`    (${code} → ${e.code}/${e.retryable}, wanted ${expected}/${retryable})`);
  }
  ok(mapped === cases.length, `every S3 code maps correctly (${mapped}/${cases.length})`);

  // NoSuchUpload must beat the bare 404: "retry the part" vs "upload is dead".
  ok(mapStorageError(s3err('NoSuchUpload', 404)).code === 'upload_not_found',
    'an explicit code wins over the HTTP status');

  // Status-only fallback for codes we do not recognise.
  ok(mapStorageError(s3err('Weird', 404)).code === 'object_not_found', 'falls back to status 404');
  ok(mapStorageError(s3err('Weird', 500)).code === 'provider_unavailable', 'falls back to status 5xx');
  ok(mapStorageError(s3err('Weird', 503)).retryable === true, '5xx is retryable');
  ok(mapStorageError(new Error('nope')).code === 'unknown_storage_error', 'an unclassifiable error is unknown');
  ok(mapStorageError(new Error('nope')).retryable === false, 'unknown errors are conservatively not retryable');

  // Socket failures arrive before any S3 code exists.
  for (const c of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']) {
    const e = mapStorageError(Object.assign(new Error('socket'), { code: c, errno: -1, syscall: 'connect' }));
    ok(e.retryable === true && e.code === 'provider_unavailable', `${c} is a retryable provider failure`);
  }

  // Raw SDK detail must not survive into the mapped error's own message.
  const e = mapStorageError(s3err('AccessDenied', 403), { operation: 'getObject', key: 'sources/r/source.webm' });
  ok(!e.message.includes('raw sdk text'), 'the raw SDK message does not survive');
  ok(!e.message.includes('req-123'), 'provider request ids do not survive');
  ok(e.operation === 'getObject' && e.key === 'sources/r/source.webm', 'context is preserved for logs');
  ok(e.cause, 'the original error is retained as cause for debugging');
  ok(!('status' in e) && !('statusCode' in e), 'no HTTP status is attached (transport-agnostic)');

  // Our own errors pass through unchanged (key validation must not be remapped).
  const own = new S.InvalidRequestError('bad key');
  ok(mapStorageError(own) === own, 'an existing StorageError passes through unchanged');
}

// ── D. Signed URLs (real SigV4, no server needed) ────────────────────────────
async function signedUrlTests() {
  console.log('\nD. Signed URLs');

  const provider = S.createStorageProvider(TEST_CONFIG);
  const key = keys.source('rec_abc');

  const get = await provider.getSignedDownloadUrl(key, { expiresIn: 300 });
  const u = new URL(get);
  ok(u.pathname.includes('veorec-media-test') && u.pathname.includes(key), 'the GET URL addresses the exact object');
  ok(u.searchParams.get('X-Amz-Expires') === '300', 'the GET URL carries the requested expiry');
  ok(!!u.searchParams.get('X-Amz-Signature'), 'the GET URL is signed');
  ok(u.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256', 'SigV4 is used');
  ok(!get.includes(TEST_CONFIG.secretAccessKey), 'the signed URL never contains the secret key');

  // Scoping: a different object produces a different signature, so a URL for
  // one recording cannot be edited into a URL for another.
  const otherUrl = new URL(await provider.getSignedDownloadUrl(keys.source('rec_other'), { expiresIn: 300 }));
  ok(otherUrl.searchParams.get('X-Amz-Signature') !== u.searchParams.get('X-Amz-Signature'),
    'a different object yields a different signature');

  // Method binding: a GET URL cannot be reused to write.
  const put = await provider.getSignedUploadUrl(key, { expiresIn: 300 });
  ok(new URL(put).searchParams.get('X-Amz-Signature') !== u.searchParams.get('X-Amz-Signature'),
    'GET and PUT signatures differ (method is bound)');

  // Expiry is mandatory and capped — no permanently public object.
  ok(u.searchParams.has('X-Amz-Expires'), 'signed URLs always expire');
  let e = await arejects(() => provider.getSignedDownloadUrl(key, { expiresIn: 999_999_999 }));
  ok(e && e.code === 'invalid_request', 'a TTL beyond the ceiling is refused, not silently shortened');
  e = await arejects(() => provider.getSignedDownloadUrl(key, { expiresIn: 0 }));
  ok(e && e.code === 'invalid_request', 'a zero TTL is refused');
  e = await arejects(() => provider.getSignedDownloadUrl(key, { expiresIn: -5 }));
  ok(e && e.code === 'invalid_request', 'a negative TTL is refused');
  const dflt = new URL(await provider.getSignedDownloadUrl(key));
  ok(dflt.searchParams.get('X-Amz-Expires') === '600', 'the default GET TTL is the documented 10 minutes');

  // Content-Length signing — the enforceable byte ceiling T-306 will rely on.
  const capped = await provider.getSignedUploadUrl(key, { expiresIn: 300, contentLength: 1024 });
  const signed = new URL(capped).searchParams.get('X-Amz-SignedHeaders') || '';
  ok(signed.includes('content-length'), 'Content-Length is a SIGNED header when a ceiling is set');
  ok(new URL(capped).searchParams.get('X-Amz-Signature')
    !== new URL(await provider.getSignedUploadUrl(key, { expiresIn: 300, contentLength: 2048 }))
      .searchParams.get('X-Amz-Signature'),
    'a different byte ceiling yields a different signature');
  e = await arejects(() => provider.getSignedUploadUrl(key, { contentLength: -1 }));
  ok(e && e.code === 'invalid_request', 'a negative content length is refused');

  // The signed set must contain EXACTLY the headers being signed. Signing a
  // header the caller was never given makes a real provider reject any client
  // that omits it (found against MinIO: "headers present in the request which
  // were not signed"), so a byte ceiling asked for alone must not drag
  // content-type into the signature.
  const headersOf = async (opts) => (new URL(await provider.getSignedUploadUrl(key, opts))
    .searchParams.get('X-Amz-SignedHeaders') || '').split(';').sort();
  ok(JSON.stringify(await headersOf({ contentLength: 10 })) === JSON.stringify(['content-length', 'host']),
    'a byte ceiling alone signs only host + content-length');
  ok(JSON.stringify(await headersOf({ contentType: 'video/webm' })) === JSON.stringify(['content-type', 'host']),
    'a content type alone signs only host + content-type');
  ok(JSON.stringify(await headersOf({ contentLength: 10, contentType: 'video/webm' }))
    === JSON.stringify(['content-length', 'content-type', 'host']),
    'both options together sign both headers');

  // Part URLs bind the upload and the part number.
  const partUrl = await provider.getSignedPartUrl(key, 'upload-id-1', 1, { expiresIn: 300 });
  ok(new URL(partUrl).searchParams.get('partNumber') === '1', 'the part URL carries its part number');
  ok(new URL(partUrl).searchParams.get('uploadId') === 'upload-id-1', 'the part URL carries its upload id');
  ok(new URL(await provider.getSignedPartUrl(key, 'upload-id-1', 2, { expiresIn: 300 }))
    .searchParams.get('X-Amz-Signature') !== new URL(partUrl).searchParams.get('X-Amz-Signature'),
    'a different part number yields a different signature');
  for (const bad of [0, -1, 10_001, 1.5, 'x']) {
    e = await arejects(() => provider.getSignedPartUrl(key, 'u', bad, {}));
    if (!(e && e.code === 'invalid_request')) { fail++; console.log('  FAIL: part number', bad, 'accepted'); }
  }
  ok(true, 'out-of-range part numbers are refused');

  // Key validation runs on the signing path too — not only on writes.
  e = await arejects(() => provider.getSignedDownloadUrl('../../etc/passwd'));
  ok(e && e.code === 'invalid_request', 'a hostile key cannot be signed');
  e = await arejects(() => provider.getSignedUploadUrl('../../etc/passwd'));
  ok(e && e.code === 'invalid_request', 'a hostile key cannot be signed for upload');
}

// ── E. Argument validation without a server (mock client) ────────────────────
async function validationTests() {
  console.log('\nE. Operation validation');

  // A client that fails loudly if any call reaches it: these assertions are
  // about rejecting bad input BEFORE a request is made.
  let reached = 0;
  const provider = S.createStorageProvider({
    ...TEST_CONFIG, client: { send: async () => { reached += 1; throw new Error('should not be reached'); } },
  });

  for (const call of [
    () => provider.putObject('../x', Buffer.from('a')),
    () => provider.getObject('../x'),
    () => provider.headObject('../x'),
    () => provider.deleteObject('../x'),
    () => provider.createMultipartUpload('../x'),
    () => provider.listObjects('../x'),
    () => provider.deleteObjects(['ok/a', '../x']),
  ]) {
    const e = await arejects(call);
    if (!(e && e.code === 'invalid_request')) { fail++; console.log('  FAIL: hostile key reached the provider'); }
  }
  ok(reached === 0, 'no hostile key reaches the wire');

  let e = await arejects(() => provider.putObject(keys.source('r'), null));
  ok(e && e.code === 'invalid_request', 'putObject requires a body');

  // Multipart completion argument checks.
  const k = keys.source('rec_abc');
  e = await arejects(() => provider.completeMultipartUpload(k, 'u', []));
  ok(e && e.code === 'invalid_request', 'completion requires at least one part');
  e = await arejects(() => provider.completeMultipartUpload(k, 'u', [{ partNumber: 1 }]));
  ok(e && e.code === 'invalid_request', 'completion requires an etag per part');
  e = await arejects(() => provider.completeMultipartUpload(k, 'u',
    [{ partNumber: 1, etag: 'a' }, { partNumber: 1, etag: 'b' }]));
  ok(e && e.code === 'invalid_request', 'duplicate part numbers are refused');
  e = await arejects(() => provider.completeMultipartUpload(k, '', [{ partNumber: 1, etag: 'a' }]));
  ok(e && e.code === 'invalid_request', 'an empty uploadId is refused');

  // Metadata is header material: injection and non-ASCII must not pass.
  e = await arejects(() => provider.putObject(k, Buffer.from('a'), { metadata: { 'bad key': 'v' } }));
  ok(e && e.code === 'invalid_request', 'an invalid metadata key is refused');
  e = await arejects(() => provider.putObject(k, Buffer.from('a'), { metadata: { ok: 'a\r\nInjected: 1' } }));
  ok(e && e.code === 'invalid_request', 'CRLF injection through metadata is refused');
  e = await arejects(() => provider.putObject(k, Buffer.from('a'), { metadata: { ok: 'café' } }));
  ok(e && e.code === 'invalid_request', 'non-ASCII metadata is refused');

  e = await arejects(() => provider.deleteObjects(new Array(1001).fill('a/b')));
  ok(e && e.code === 'invalid_request', 'an over-large batch delete is refused');
  ok((await provider.deleteObjects([])).deleted === 0, 'an empty batch delete is a no-op');

  // Provider failures are translated, and abort stays repeatable.
  const failing = S.createStorageProvider({
    ...TEST_CONFIG,
    client: { send: async () => { throw Object.assign(new Error('x'), { Code: 'NoSuchUpload', name: 'NoSuchUpload', $metadata: { httpStatusCode: 404 } }); } },
  });
  const aborted = await failing.abortMultipartUpload(k, 'gone');
  ok(aborted.alreadyGone === true, 'aborting an unknown upload resolves (safely repeatable)');

  const denied = S.createStorageProvider({
    ...TEST_CONFIG,
    client: { send: async () => { throw Object.assign(new Error('x'), { Code: 'AccessDenied', name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }); } },
  });
  e = await arejects(() => denied.headObject(k));
  ok(e && e.code === 'permission_denied' && e.name === 'PermissionDeniedError', 'SDK failures surface as storage errors');
  ok(await (async () => {
    const missing = S.createStorageProvider({
      ...TEST_CONFIG,
      client: { send: async () => { throw Object.assign(new Error('x'), { Code: 'NoSuchKey', name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }); } },
    });
    return (await missing.objectExists(k)) === false;
  })(), 'objectExists returns false rather than throwing for a missing object');

  // getObjectBuffer drains a stream (checks the read path without a server).
  const streaming = S.createStorageProvider({
    ...TEST_CONFIG,
    client: { send: async () => ({ Body: Readable.from([Buffer.from('hel'), Buffer.from('lo')]), ETag: '"abc"', ContentLength: 5 }) },
  });
  const buf = await streaming.getObjectBuffer(k);
  ok(buf.body.toString() === 'hello' && buf.etag === 'abc', 'getObjectBuffer concatenates and unquotes the etag');
}

// ── F. Abstraction boundary ──────────────────────────────────────────────────
function boundaryTests() {
  console.log('\nF. Abstraction boundary');

  const fs = require('fs');
  const srcDir = path.join(STORAGE_DIR, 'src');
  const sources = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js'));

  // These assertions are about CODE, so comments must be stripped first —
  // the header comments deliberately quote the very patterns being banned
  // ("never import @aws-sdk/*", "no if (flavour === 'r2')"), and matching
  // those would make the guard fire on its own documentation.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const text = Object.fromEntries(sources.map(
    (f) => [f, stripComments(fs.readFileSync(path.join(srcDir, f), 'utf8'))]));

  // Cloudinary must never enter the new abstraction (docs/02 §2.7).
  const cloudinary = sources.filter((f) => /cloudinary/i.test(text[f]));
  ok(cloudinary.length === 0, 'no Cloudinary reference in any storage source file');
  ok(!JSON.stringify(require(path.join(STORAGE_DIR, 'package.json')).dependencies).match(/cloudinary/i),
    'the storage package declares no Cloudinary dependency');

  // The SDK is confined to two files, and the split is deliberate:
  //   s3-provider.js  DATA plane    - object bytes, used by application code
  //   provisioner.js  CONTROL plane - bucket administration, operator tooling
  // Bucket administration (PutBucketCors, PutBucketLifecycleConfiguration) has
  // no application-level abstraction, and giving StorageProvider a
  // putBucketCors() would let anyone holding a provider reconfigure the bucket.
  // So the control plane keeps its own SDK import and is deliberately NOT part
  // of the application-facing surface - asserted below.
  const sdkUsers = sources.filter((f) => text[f].includes('@aws-sdk/')).sort();
  ok(JSON.stringify(sdkUsers) === JSON.stringify(['provisioner.js', 's3-provider.js']),
    `the AWS SDK is imported only by the provider and provisioner (found: ${sdkUsers.join(', ') || 'none'})`);
  for (const pure of ['index.js', 'config.js', 'keys.js', 'errors.js', 'bucket-config.js']) {
    ok(!text[pure].includes('@aws-sdk/'), `${pure} is SDK-free`);
  }
  // Application code must not provision a bucket through the public surface:
  // the CLI imports provisioner.js directly, and nothing else may.
  ok(!Object.keys(S).some((n) => /provision/i.test(n)),
    'bucket provisioning is NOT exported from the application-facing surface');

  // One code path: construction may differ, behaviour may not.
  const behaviourBranch = /(if|\?)\s*\(?[^\n]*\bflavour\s*===/.test(text['s3-provider.js']);
  ok(!behaviourBranch, 'the provider never branches on the R2/MinIO flavour');

  // The public surface exposes no bucket/SDK/R2 concepts.
  const exported = Object.keys(S);
  ok(!exported.some((n) => /bucket|s3client|aws|r2|minio/i.test(n) && n !== 'S3StorageProvider'),
    'the public surface leaks no provider-specific names');

  // Storage owns bytes; PostgreSQL owns application state and ownership.
  const surface = Object.getOwnPropertyNames(
    Object.getPrototypeOf(S.createStorageProvider({ ...TEST_CONFIG, client: {} })));
  ok(!surface.some((m) => /user|owner|recordingRow|quota|permission|auth/i.test(m)),
    'the provider exposes no ownership/quota/authorization methods');
  ok(surface.includes('putObject') && surface.includes('getSignedDownloadUrl')
    && surface.includes('createMultipartUpload') && surface.includes('completeMultipartUpload')
    && surface.includes('abortMultipartUpload') && surface.includes('getSignedPartUrl'),
    'the documented contract methods are all present');
}

(async () => {
  console.log('T-201 storage unit tests (no object store required)');
  keyTests();
  configTests();
  errorTests();
  await signedUrlTests();
  await validationTests();
  boundaryTests();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
