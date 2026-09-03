// T-201 StorageProvider CONTRACT suite (run: cd storage && npm run test:contract)
//
// This suite tests the ABSTRACT CONTRACT, not an implementation. It talks only
// to the StorageProvider surface — no @aws-sdk import, no bucket names, no
// R2- or MinIO-specific behaviour — so the SAME file verifies both:
//
//   MinIO   docker compose up -d minio        (local/CI default)
//   R2      STORAGE_ENDPOINT=https://<acct>.r2.cloudflarestorage.com \
//           STORAGE_BUCKET=… STORAGE_ACCESS_KEY_ID=… STORAGE_SECRET_ACCESS_KEY=… \
//           STORAGE_CONTRACT_TARGET=r2 npm run test:contract
//
// It SKIPS LOUDLY (exit 0) when no endpoint is reachable, matching the
// convention in tests/db.test.js, so the repo suite stays runnable on machines
// without infrastructure. Set STORAGE_TESTS_REQUIRED=1 (CI) to turn an
// unreachable endpoint into a failure instead.
//
// NEVER point this at production: it writes and deletes objects under its own
// throwaway prefix. It refuses to run when APP_ENV=production.
'use strict';

const path = require('path');
const crypto = require('crypto');

const STORAGE_DIR = path.join(__dirname, '..', 'storage');
const S = require(path.join(STORAGE_DIR, 'src', 'index.js'));
const { keys } = require(path.join(STORAGE_DIR, 'src', 'keys.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const arejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const TARGET = process.env.STORAGE_CONTRACT_TARGET || 'minio';
const REQUIRED = process.env.STORAGE_TESTS_REQUIRED === '1';
// Unique per run so parallel runs and leftovers can never collide.
const RUN = crypto.randomBytes(6).toString('hex');
const recId = (suffix) => `rec_ct${RUN}${suffix}`;

// S3 requires every part except the last to be ≥ 5 MiB.
const MIN_PART_BYTES = 5 * 1024 * 1024;

function skip(reason) {
  console.log(`\n  SKIPPED — ${reason}`);
  if (REQUIRED) {
    console.log('  STORAGE_TESTS_REQUIRED=1 — treating an unreachable endpoint as a failure.');
    process.exit(1);
  }
  console.log('\n  The contract suite did NOT run. T-201 is not integration-verified by this run.');
  console.log('  Start MinIO with:  docker compose up -d minio');
  process.exit(0);
}

async function main() {
  if (String(process.env.APP_ENV).toLowerCase() === 'production') {
    console.error('Refusing to run the contract suite against APP_ENV=production.');
    process.exit(1);
  }

  let provider;
  try {
    provider = S.createStorageProvider({ appEnv: process.env.APP_ENV || 'test' });
  } catch (e) {
    skip(`storage is not configured: ${e.message}`);
  }
  console.log(`T-201 StorageProvider contract suite — target=${TARGET}`);
  console.log(`  ${JSON.stringify(provider.describe())}`);

  // Reachability probe. A missing object is a SUCCESSFUL round trip: it proves
  // we reached the endpoint, authenticated, and got a well-formed answer.
  const probe = await arejects(() => provider.headObject(keys.source(recId('probe'))));
  if (probe && ['provider_unavailable', 'timeout', 'unknown_storage_error'].includes(probe.code)) {
    skip(`no object store reachable at the configured endpoint (${probe.code})`);
  }
  if (probe && probe.code === 'permission_denied') {
    skip('the configured credentials were rejected by the endpoint');
  }

  const created = [];
  const track = (k) => { created.push(k); return k; };

  try {
    await basicOperations(provider, track);
    await securityChecks(provider, track);
    await multipartLifecycle(provider, track);
    await errorBehaviour(provider, track);
    await isolation(provider, track);
  } finally {
    // Always clean up, even on failure — this suite must be re-runnable.
    await provider.deleteObjects([...new Set(created)]).catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed  (contract target: ${TARGET})`);
  process.exit(fail ? 1 : 0);
}

// ── Basic object operations ──────────────────────────────────────────────────
async function basicOperations(provider, track) {
  console.log('\nA. Basic object operations');
  const key = track(keys.source(recId('a')));
  const body = Buffer.from('veorec contract suite payload');

  const put = await provider.putObject(key, body, { contentType: 'video/webm' });
  ok(!!put.etag, 'put returns an etag');

  const got = await provider.getObjectBuffer(key);
  ok(got.body.equals(body), 'get returns exactly the bytes that were put');
  ok(got.contentType === 'video/webm', 'content type round-trips');
  ok(got.contentLength === body.length, 'content length round-trips');

  const head = await provider.headObject(key);
  ok(head.contentLength === body.length, 'head reports the byte length');
  ok(head.contentType === 'video/webm', 'head reports the content type');
  ok(head.etag === put.etag, 'head reports the same etag as put');
  ok(!head.body, 'head returns no body');

  ok(await provider.objectExists(key) === true, 'exists is true for a stored object');
  ok(await provider.objectExists(keys.source(recId('nope'))) === false, 'exists is false for a missing object');

  // Overwrite: last writer wins, which is what makes a retried write idempotent.
  const body2 = Buffer.from('replacement payload, different length');
  await provider.putObject(key, body2, { contentType: 'video/mp4' });
  const after = await provider.getObjectBuffer(key);
  ok(after.body.equals(body2), 'overwrite replaces the previous bytes');
  ok(after.contentType === 'video/mp4', 'overwrite replaces the content type');

  // Metadata, where the provider supports it.
  const metaKey = track(keys.audio(recId('m')));
  await provider.putObject(metaKey, Buffer.from('x'), { metadata: { 'recording-id': 'rec_abc' } });
  const metaHead = await provider.headObject(metaKey);
  ok(metaHead.metadata && metaHead.metadata['recording-id'] === 'rec_abc', 'user metadata round-trips');

  await provider.deleteObject(key);
  ok(await provider.objectExists(key) === false, 'delete removes the object');

  // Idempotent delete — cleanup jobs and retries must not fail on a second run.
  const again = await arejects(() => provider.deleteObject(key));
  ok(again === null, 'deleting an already-deleted object succeeds (idempotent)');
  const never = await arejects(() => provider.deleteObject(keys.source(recId('never'))));
  ok(never === null, 'deleting a never-existing object succeeds');
}

// ── Security ─────────────────────────────────────────────────────────────────
async function securityChecks(provider, track) {
  console.log('\nB. Security');
  const key = track(keys.source(recId('s')));
  const body = Buffer.from('signed url payload');
  await provider.putObject(key, body, { contentType: 'video/webm' });

  // A signed GET is a bearer credential for exactly one object.
  const url = await provider.getSignedDownloadUrl(key, { expiresIn: 300 });
  const res = await fetch(url);
  ok(res.ok, 'a signed GET URL retrieves the object');
  ok(Buffer.from(await res.arrayBuffer()).equals(body), 'the signed GET returns the right bytes');

  // The bucket is private: the same path without a signature must fail.
  const unsigned = url.split('?')[0];
  const anon = await fetch(unsigned);
  ok(!anon.ok && (anon.status === 401 || anon.status === 403 || anon.status === 404),
    `an unsigned request is refused (status ${anon.status}) — the bucket is not public`);

  // A tampered signature must not work.
  const tampered = new URL(url);
  const sig = tampered.searchParams.get('X-Amz-Signature');
  tampered.searchParams.set('X-Amz-Signature', sig.slice(0, -2) + (sig.endsWith('aa') ? 'bb' : 'aa'));
  ok(!(await fetch(tampered)).ok, 'a tampered signature is rejected');

  // A URL signed for object A must not read object B.
  const otherKey = track(keys.source(recId('s2')));
  await provider.putObject(otherKey, Buffer.from('other tenant bytes'));
  const swapped = new URL(url);
  swapped.pathname = swapped.pathname.replace(recId('s'), recId('s2'));
  ok(!(await fetch(swapped)).ok, 'a signature for one object cannot fetch another');

  // An expired URL must stop working. expiresIn=1 then wait it out.
  const shortLived = await provider.getSignedDownloadUrl(key, { expiresIn: 1 });
  await new Promise((r) => setTimeout(r, 2200));
  ok(!(await fetch(shortLived)).ok, 'an expired signed URL is rejected');

  // Signed PUT: upload without ever handing out credentials.
  const putKey = track(keys.source(recId('p')));
  const putUrl = await provider.getSignedUploadUrl(putKey, { expiresIn: 300, contentType: 'video/webm' });
  const putRes = await fetch(putUrl, {
    method: 'PUT', body: Buffer.from('uploaded via presigned put'),
    headers: { 'content-type': 'video/webm' },
  });
  ok(putRes.ok, 'a signed PUT URL uploads the object');
  ok(await provider.objectExists(putKey) === true, 'the presigned PUT actually stored the object');

  // A GET URL must not be usable to write.
  const getAsPut = await fetch(url, { method: 'PUT', body: Buffer.from('should not work') });
  ok(!getAsPut.ok, 'a signed GET URL cannot be used to PUT (method is bound)');

  // Content-Length signing: the enforceable ceiling T-306 depends on. A body
  // of a different size must be refused BY THE PROVIDER, not by the client.
  const capKey = track(keys.source(recId('c')));
  const exact = Buffer.from('0123456789');
  const capUrl = await provider.getSignedUploadUrl(capKey, { expiresIn: 300, contentLength: exact.length });
  const good = await fetch(capUrl, { method: 'PUT', body: exact, headers: { 'content-length': String(exact.length) } });
  ok(good.ok, 'a presigned PUT with the exact signed length succeeds');
  const oversize = Buffer.alloc(exact.length * 3, 0x41);
  const bad = await fetch(capUrl, { method: 'PUT', body: oversize, headers: { 'content-length': String(oversize.length) } });
  ok(!bad.ok, 'a body larger than the signed Content-Length is REJECTED by the provider');

  // No credential material may appear in a signed URL.
  ok(!url.includes(provider.config.secretAccessKey), 'the signed URL does not contain the secret key');
}

// ── Multipart lifecycle ──────────────────────────────────────────────────────
async function multipartLifecycle(provider, track) {
  console.log('\nC. Multipart lifecycle');
  const key = track(keys.source(recId('mp')));

  const { uploadId } = await provider.createMultipartUpload(key, { contentType: 'video/webm' });
  ok(!!uploadId, 'create returns an upload id');

  // An incomplete multipart upload must NOT be visible as an object — the
  // object appears atomically at completion, so a crashed upload can never be
  // mistaken for a finished recording.
  ok(await provider.objectExists(key) === false, 'an in-progress multipart upload is not a visible object');

  const part1 = Buffer.alloc(MIN_PART_BYTES, 0x61);
  const part2 = Buffer.from('tail part');
  const etags = [];
  for (const [i, part] of [part1, part2].entries()) {
    const partUrl = await provider.getSignedPartUrl(key, uploadId, i + 1, { expiresIn: 600 });
    const res = await fetch(partUrl, { method: 'PUT', body: part });
    if (!res.ok) { fail++; console.log(`  FAIL: part ${i + 1} upload failed (${res.status})`); return; }
    etags.push({ partNumber: i + 1, etag: (res.headers.get('etag') || '').replace(/"/g, '') });
  }
  ok(etags.length === 2 && etags.every((e) => e.etag), 'parts upload via presigned URLs and return etags');

  const listed = await provider.listParts(key, uploadId);
  ok(listed.length === 2, 'listParts reports the received parts');
  ok(listed.find((p) => p.partNumber === 1).size === MIN_PART_BYTES, 'listParts reports part sizes');

  const done = await provider.completeMultipartUpload(key, uploadId, etags);
  ok(!!done.etag, 'complete returns the object etag');

  const head = await provider.headObject(key);
  ok(head.contentLength === part1.length + part2.length, 'the completed object is the concatenation of its parts');
  const full = await provider.getObjectBuffer(key);
  ok(full.body.subarray(0, MIN_PART_BYTES).equals(part1)
    && full.body.subarray(MIN_PART_BYTES).equals(part2), 'the assembled bytes are correct and in order');

  // Retry safety: completing again must not create a second object.
  const retry = await arejects(() => provider.completeMultipartUpload(key, uploadId, etags));
  ok(retry === null || retry.code === 'upload_not_found' || retry.code === 'multipart_failed',
    'a repeated completion either succeeds or reports the upload as gone — never duplicates');
  ok((await provider.headObject(key)).contentLength === part1.length + part2.length,
    'the object is unchanged after a repeated completion');

  // Abort discards everything and leaves no object behind.
  const abortKey = track(keys.source(recId('ab')));
  const aborted = await provider.createMultipartUpload(abortKey);
  const abortPartUrl = await provider.getSignedPartUrl(abortKey, aborted.uploadId, 1, { expiresIn: 300 });
  await fetch(abortPartUrl, { method: 'PUT', body: Buffer.alloc(MIN_PART_BYTES, 0x62) });
  await provider.abortMultipartUpload(abortKey, aborted.uploadId);
  ok(await provider.objectExists(abortKey) === false, 'an aborted multipart upload leaves no object');

  // Abort must be safely repeatable — cleanup runs more than once.
  // The CONTRACT is "resolves without throwing", not any particular response
  // shape: AWS reports NoSuchUpload for an unknown upload while MinIO returns
  // 204, so asserting `alreadyGone` would pin a provider-specific detail and
  // make this suite non-portable between the two stores it must both verify.
  const second = await arejects(() => provider.abortMultipartUpload(abortKey, aborted.uploadId));
  ok(second === null, 'aborting an already-aborted upload succeeds (repeatable)');
  const bogus = await arejects(() => provider.abortMultipartUpload(abortKey, 'no-such-upload-id'));
  ok(bogus === null, 'aborting an unknown upload id succeeds (repeatable)');

  // Parts of an aborted upload are gone.
  const goneParts = await arejects(() => provider.listParts(abortKey, aborted.uploadId));
  ok(goneParts && goneParts.code === 'upload_not_found', 'the aborted upload id is no longer usable');
}

// ── Error behaviour ──────────────────────────────────────────────────────────
async function errorBehaviour(provider) {
  console.log('\nD. Error behaviour');

  const missing = keys.source(recId('missing'));
  let e = await arejects(() => provider.getObject(missing));
  ok(e && e.code === 'object_not_found', 'get on a missing object maps to object_not_found');
  ok(e && e.retryable === false, 'a missing object is not retryable');
  ok(e && e.key === missing && e.operation === 'getObject', 'the error carries operation context');
  ok(e && !/Bucket|endpoint|http/i.test(e.message), 'the error message leaks no endpoint/bucket detail');

  e = await arejects(() => provider.headObject(missing));
  ok(e && e.code === 'object_not_found', 'head on a missing object maps to object_not_found');

  e = await arejects(() => provider.listParts(keys.source(recId('x')), 'definitely-not-an-upload-id'));
  ok(e && ['upload_not_found', 'invalid_request'].includes(e.code), 'an unknown upload id is reported precisely');

  e = await arejects(() => provider.completeMultipartUpload(
    keys.source(recId('x')), 'not-an-upload', [{ partNumber: 1, etag: 'deadbeef' }]));
  ok(e && ['upload_not_found', 'invalid_request', 'multipart_failed'].includes(e.code),
    'completing an unknown upload fails with a mapped error');

  // Invalid credentials must map to permission_denied, not a raw SDK error.
  const badCreds = S.createStorageProvider({
    appEnv: process.env.APP_ENV || 'test',
    accessKeyId: 'AKIAINVALIDINVALID00',
    secretAccessKey: 'definitely-not-the-right-secret-value-here',
  });
  e = await arejects(() => badCreds.headObject(keys.source(recId('auth'))));
  ok(e && ['permission_denied', 'object_not_found'].includes(e.code),
    `invalid credentials map to a storage error (got ${e && e.code})`);
  ok(e && e.name && e.name.endsWith('Error') && e.code, 'the failure is a StorageError, not a raw SDK error');

  // An unreachable endpoint must be retryable, so the future queue backs off.
  const unreachable = S.createStorageProvider({
    appEnv: 'test', endpoint: 'http://127.0.0.1:1', maxAttempts: 1, requestTimeoutMs: 2000,
  });
  e = await arejects(() => unreachable.headObject(keys.source(recId('down'))));
  ok(e && ['provider_unavailable', 'timeout'].includes(e.code), 'an unreachable provider maps to provider_unavailable');
  ok(e && e.retryable === true, 'provider unavailability is retryable');
}

// ── Isolation ────────────────────────────────────────────────────────────────
async function isolation(provider, track) {
  console.log('\nE. Isolation');

  const a = track(keys.source(recId('i1')));
  const b = track(keys.source(recId('i2')));
  const bodyA = Buffer.from('recording A bytes');
  const bodyB = Buffer.from('recording B — different tenant entirely');

  await provider.putObject(a, bodyA);
  await provider.putObject(b, bodyB);
  ok((await provider.getObjectBuffer(a)).body.equals(bodyA), 'object A is unaffected by object B');
  ok((await provider.getObjectBuffer(b)).body.equals(bodyB), 'object B is unaffected by object A');

  // Deleting one must not touch the other.
  await provider.deleteObject(a);
  ok(await provider.objectExists(a) === false, 'the deleted object is gone');
  ok(await provider.objectExists(b) === true, 'the sibling object survives');

  // Different asset ids under the same recording stay distinct.
  const v1 = track(keys.derivedVideo(recId('i3'), 'ast_one'));
  const v2 = track(keys.derivedVideo(recId('i3'), 'ast_two'));
  await provider.putObject(v1, Buffer.from('720p'));
  await provider.putObject(v2, Buffer.from('1080p'));
  ok((await provider.getObjectBuffer(v1)).body.toString() === '720p'
    && (await provider.getObjectBuffer(v2)).body.toString() === '1080p',
    'sibling assets do not overwrite each other');

  // Prefix listing sees only its own recording (maintenance path).
  const listed = await provider.listObjects(`derived/${recId('i3')}/`);
  ok(listed.objects.length === 2 && listed.objects.every((o) => o.key.includes(recId('i3'))),
    'a prefix listing is scoped to that prefix');
  await provider.deleteObjects([v1, v2]);
}

main().catch((e) => { console.error('harness error:', e); process.exit(1); });
