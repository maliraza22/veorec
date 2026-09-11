// T-303 extension uploader tests (run: cd extension && npm test, or node directly)
//
// Unit tests with a MOCK FETCH, per the canonical task. No network and no clock:
// `fetch`, `sleep`, `now` and `random` are all injected, so the retry classifier,
// the backoff schedule, the resume diff and the R14/R15 network scenarios are
// deterministic rather than timing-dependent.
//
// The retry branches get the most attention because they are what decides
// whether a 40-minute recording survives a bad ten minutes of network.
'use strict';

const path = require('path');
const U = require(path.join(__dirname, '..', 'extension', 'uploader.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

const PART = 8 * 1024 * 1024;
const chunk = (n) => new Uint8Array(n).fill(7);

/**
 * A scriptable server + storage. Records every call so ordering, concurrency
 * and retry counts can be asserted exactly.
 */
function mockWorld(opts = {}) {
  const calls = [];
  const storage = new Map();          // partNumber -> bytes
  const recorded = new Map();         // partNumber -> {etag,size,crc32c}
  let putBehaviour = opts.putBehaviour || (() => ({ status: 200 }));
  const world = {
    calls, storage, recorded,
    sleeps: [],
    setPutBehaviour(fn) { putBehaviour = fn; },
    session: {
      uploadSessionId: 'up_1', recordingId: 'rec_1',
      partSize: opts.partSize || PART, minPartSize: 5 * 1024 * 1024,
      maxParts: 10000, byteCeiling: opts.byteCeiling || 512 * 1024 * 1024,
      expiresAt: new Date(Date.now() + 3600e3).toISOString(), status: 'pending',
    },
    serverParts: opts.serverParts || [],
    completeStatus: opts.completeStatus || 200,
    presignStatus: opts.presignStatus || 200,
  };

  const json = (status, body) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: { get: () => null },
  });

  world.fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method });

    if (url.includes('/api/v1/recordings')) return json(201, { id: 'rec_1', status: 'recording' });

    if (url.endsWith('/api/v1/uploads') && method === 'POST') {
      return json(201, world.session);
    }
    if (/\/uploads\/[^/]+$/.test(url) && method === 'GET') {
      return json(200, { ...world.session, parts: world.serverParts });
    }
    if (url.endsWith('/parts') && method === 'POST') {
      if (world.presignStatus !== 200) {
        return json(world.presignStatus, { error: { code: 'storage_limit', message: 'over' } });
      }
      const body = JSON.parse(init.body);
      return json(200, {
        parts: body.parts.map((p) => ({
          partNumber: p.partNumber, url: `https://storage.test/part/${p.partNumber}`,
          expiresAt: new Date(Date.now() + 3600e3).toISOString(),
        })),
      });
    }
    if (/\/parts\/\d+$/.test(url) && method === 'PUT') {
      const n = Number(url.split('/').pop());
      recorded.set(n, JSON.parse(init.body));
      return json(200, { partNumber: n });
    }
    if (url.endsWith('/complete')) {
      if (world.completeStatus !== 200) {
        return json(world.completeStatus, { error: { code: 'storage_limit', message: 'too big', upgradeRequired: true } });
      }
      return json(200, { recordingId: 'rec_1', status: 'uploaded' });
    }
    if (url.endsWith('') && method === 'DELETE') return json(200, { status: 'aborted' });

    // Storage PUT of a part.
    if (url.startsWith('https://storage.test/part/')) {
      const n = Number(url.split('/').pop());
      const outcome = putBehaviour(n, calls.filter((c) => c.url === url).length);
      if (outcome.throw) throw new Error('network down');
      if (outcome.status === 200) {
        storage.set(n, init.body);
        return { ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'etag' ? `"etag-${n}"` : null) },
          text: async () => '', json: async () => ({}) };
      }
      return { ok: false, status: outcome.status,
        headers: { get: () => null },
        text: async () => outcome.body || '', json: async () => ({}) };
    }
    return json(404, {});
  };

  world.sleep = async (ms) => { world.sleeps.push(ms); };
  return world;
}

const makeUploader = (world, extra = {}) => U.createUploader({
  server: 'https://api.test', token: 't',
  fetchImpl: world.fetchImpl, sleep: world.sleep,
  random: () => 0.5, ...extra,
});

(async () => {
  console.log('T-303 extension uploader tests');

  // ── A. Retry classifier — every branch ───────────────────────────────────
  console.log('\nA. Retry classifier (every branch)');
  const c = U.classify;
  ok(c({ status: 200 }) === 'ok', '2xx → ok');
  ok(c({ status: 204 }) === 'ok', '204 → ok');
  ok(c({ networkError: true }) === 'retry', 'network error → retry');
  ok(c({ timeout: true }) === 'retry', 'timeout → retry');
  ok(c({ status: 500 }) === 'retry', '500 → retry');
  ok(c({ status: 503 }) === 'retry', '503 → retry');
  ok(c({ status: 429 }) === 'retry', '429 → retry');
  ok(c({ status: 403, expiredSignature: true }) === 'repress',
    'an EXPIRED presigned URL re-presigns instead of counting as a failed attempt');
  ok(c({ status: 403 }) === 'fatal', 'a plain 403 is a verdict, not a blip');
  ok(c({ status: 400 }) === 'fatal', '400 → fatal');
  ok(c({ status: 404 }) === 'fatal', '404 → fatal');
  ok(c({ status: 422 }) === 'fatal', '422 → fatal');
  ok(c({}) === 'retry', 'an unknown signal is treated as transient, not fatal');

  ok(U.looksExpired(403, 'Request has expired'), 'expiry is detected from the storage body');
  ok(!U.looksExpired(403, 'Forbidden'), 'a plain forbidden body is not treated as expiry');
  ok(!U.looksExpired(500, 'expired'), 'expiry detection requires a 403');

  // ── B. Backoff ───────────────────────────────────────────────────────────
  console.log('\nB. Backoff schedule');
  const b = (n, r) => U.backoffMs(n, () => r);
  ok(b(1, 0) === 0, 'full jitter can be zero');
  ok(b(1, 0.999) < 2000, 'attempt 1 is bounded by ~2s');
  ok(b(3, 0.999) < 8000 && b(3, 0.999) > 3000, 'the ceiling grows exponentially');
  ok(b(20, 0.999) <= 60000, 'backoff is capped at 60s however many attempts');
  const spread = new Set([b(5, 0.1), b(5, 0.5), b(5, 0.9)]);
  ok(spread.size === 3, 'jitter actually varies the delay (thundering herd)');

  // ── C. CRC32C ────────────────────────────────────────────────────────────
  console.log('\nC. Checksums');
  ok(U.crc32c(Buffer.from('abc')) === 'Nks/tw==', 'CRC32C matches the standard vector for "abc"');
  ok(U.crc32c(Buffer.from('')) === 'AAAAAA==', 'CRC32C of empty is zero');
  ok(U.crc32c(Buffer.from('a')) !== U.crc32c(Buffer.from('b')), 'different bytes give different checksums');

  // ── D. Part buffering ────────────────────────────────────────────────────
  console.log('\nD. Part buffering');
  let world = mockWorld({ partSize: 1000 });
  let up = makeUploader(world);
  await up.begin({ recordingId: 'rec_1' });
  ok(up.status === 'active', 'begin opens a session');

  up.addChunk(chunk(400));
  ok(up.state.parts.size === 0, 'a part is not sealed before partSize is reached');
  up.addChunk(chunk(400));
  up.addChunk(chunk(400));
  await new Promise((r) => setTimeout(r, 20));
  ok(up.state.parts.size >= 1, 'a part seals once partSize is reached');
  const p1 = up.state.parts.get(1);
  ok(p1 && p1.size >= 1000, `the sealed part is at least partSize (got ${p1 && p1.size})`);
  ok(up.state.bufferedBytes === 0, 'the chunk crossing the boundary is included, per "seal at >= partSize"');

  // The LAST part may be any size — this is what lets a recording end anywhere.
  up.addChunk(chunk(120));
  await up.finalize({ clientDuration: 5 });
  const last = up.state.parts.get(2);
  ok(last && last.size === 120, 'finalize seals the remainder as a short final part');
  ok(up.status === 'completed', 'the upload completes');
  ok(world.storage.size === 2, 'both parts reached storage');

  // ── E. Retry behaviour end-to-end ────────────────────────────────────────
  console.log('\nE. Retry behaviour');
  world = mockWorld({ partSize: 500 });
  // Part 1 fails twice with 503, then succeeds.
  world.setPutBehaviour((n, attempt) => (n === 1 && attempt <= 2 ? { status: 503 } : { status: 200 }));
  up = makeUploader(world);
  await up.begin({ recordingId: 'rec_1' });
  up.addChunk(chunk(500));
  await up.finalize({});
  ok(up.status === 'completed', 'a part that fails transiently still completes');
  ok(up.state.parts.get(1).attempts === 2, 'exactly the failed attempts were counted');
  ok(world.sleeps.length === 2, 'the uploader backed off between attempts');
  ok(world.storage.has(1), 'the bytes ultimately landed');

  // An expired URL must NOT consume a data attempt.
  world = mockWorld({ partSize: 500 });
  let expiredOnce = false;
  world.setPutBehaviour((n) => {
    if (!expiredOnce) { expiredOnce = true; return { status: 403, body: 'Request has expired' }; }
    return { status: 200 };
  });
  up = makeUploader(world);
  await up.begin({ recordingId: 'rec_1' });
  up.addChunk(chunk(500));
  await up.finalize({});
  ok(up.status === 'completed', 'an expired URL is re-minted and the part completes');
  ok(up.state.parts.get(1).attempts === 0,
    'a re-presign does NOT count as a data attempt (docs/06 §6)');
  ok(world.calls.filter((x) => x.url.endsWith('/parts') && x.method === 'POST').length >= 2,
    'the URL was actually re-requested');

  // Fatal: a verdict must stop, not spin.
  world = mockWorld({ partSize: 500 });
  world.setPutBehaviour(() => ({ status: 400 }));
  up = makeUploader(world);
  await up.begin({ recordingId: 'rec_1' });
  up.addChunk(chunk(500));
  await up.finalize({});
  ok(up.status === 'failed', 'a fatal storage verdict fails the upload');
  ok(up.state.parts.get(1).attempts === 0, 'a fatal response is not retried at all');

  // Exhaustion → stalled, NOT failed: the session and bytes survive.
  world = mockWorld({ partSize: 500 });
  world.setPutBehaviour(() => ({ status: 503 }));
  up = makeUploader(world);
  await up.begin({ recordingId: 'rec_1' });
  up.addChunk(chunk(500));
  const out = await up.finalize({});
  ok(out.ok === false, 'finalize reports the upload is not done');
  ok(up.status === 'stalled', 'persistent failure is STALLED, not failed — the recording is not lost');
  ok(up.state.parts.get(1).attempts >= U.MAX_PART_ATTEMPTS,
    `the part was retried ${U.MAX_PART_ATTEMPTS} times before stalling`);
  ok(up.state.session !== null, 'the session is kept so a later retry can resume it');

  // ── F. R14 — offline during recording, online after stop ─────────────────
  console.log('\nF. R14 — offline during recording, online after stop');
  world = mockWorld({ partSize: 500 });
  let online = false;
  world.setPutBehaviour(() => (online ? { status: 200 } : { throw: true }));
  up = makeUploader(world);
  await up.begin({ recordingId: 'rec_1' });
  up.addChunk(chunk(500));
  up.addChunk(chunk(500));
  await new Promise((r) => setTimeout(r, 30));
  ok(up.status !== 'completed', 'nothing completes while offline');
  ok(world.storage.size === 0, 'no bytes reached storage while offline');
  online = true;                                   // network returns after Stop
  const r14 = await up.finalize({ clientDuration: 10 });
  ok(r14.ok === true, 'R14: the upload completes once the network returns after stop');
  ok(world.storage.size === 2, 'R14: every part reached storage');
  ok(up.status === 'completed', 'R14: the uploader reports completed');

  // ── G. R15 — network flaps during upload, no duplicate parts ─────────────
  console.log('\nG. R15 — network flaps during upload');
  world = mockWorld({ partSize: 500 });
  let n = 0;
  world.setPutBehaviour(() => { n += 1; return n % 3 === 0 ? { throw: true } : { status: 200 }; });
  up = makeUploader(world);
  await up.begin({ recordingId: 'rec_1' });
  for (let i = 0; i < 6; i += 1) up.addChunk(chunk(500));
  const r15 = await up.finalize({ clientDuration: 30 });
  ok(r15.ok === true, 'R15: the upload completes through a flapping network');
  ok(world.storage.size === 6, 'R15: all six parts landed');
  const partNumbers = [...world.storage.keys()].sort((a, b) => a - b);
  ok(JSON.stringify(partNumbers) === JSON.stringify([1, 2, 3, 4, 5, 6]),
    'R15: parts are numbered contiguously with NO duplicates');
  const manifestCall = world.calls.filter((x) => x.url.endsWith('/complete'));
  ok(manifestCall.length === 1, 'R15: completion is called exactly once');
  ok(world.recorded.size === 6, 'R15: each part was recorded server-side exactly once');

  // ── H. Concurrency (2 recording / 4 stopped) ─────────────────────────────
  console.log('\nH. Concurrency');
  ok(U.CONCURRENCY_RECORDING === 2 && U.CONCURRENCY_STOPPED === 4,
    'the documented 2-while-recording / 4-after-stop split');
  world = mockWorld({ partSize: 500 });
  let concurrent = 0, peakRecording = 0;
  world.setPutBehaviour(() => ({ status: 200 }));
  const trackingFetch = async (url, init) => {
    if (url.startsWith('https://storage.test/part/')) {
      concurrent += 1; peakRecording = Math.max(peakRecording, concurrent);
      const res = await world.fetchImpl(url, init);
      concurrent -= 1;
      return res;
    }
    return world.fetchImpl(url, init);
  };
  up = makeUploader(world, { fetchImpl: trackingFetch });
  await up.begin({ recordingId: 'rec_1' });
  for (let i = 0; i < 6; i += 1) up.addChunk(chunk(500));
  await new Promise((r) => setTimeout(r, 60));
  ok(peakRecording <= U.CONCURRENCY_RECORDING,
    `never more than ${U.CONCURRENCY_RECORDING} parallel PUTs while recording (peak ${peakRecording})`);
  await up.finalize({});

  // ── I. Resume diff ───────────────────────────────────────────────────────
  console.log('\nI. Resume diff');
  world = mockWorld({
    partSize: 500,
    serverParts: [{ partNumber: 1, size: 500, etag: 'etag-1' }, { partNumber: 2, size: 500, etag: 'etag-2' }],
  });
  up = makeUploader(world);
  await up.begin({ recordingId: 'rec_1' });
  const res = await up.resume('up_1');
  ok(res.ok === true, 'resume reads the server view');
  ok(res.diff.adopted.length === 2,
    'parts the server already has are ADOPTED, not re-uploaded (no completed byte is re-sent)');
  ok(up.state.parts.get(1).status === 'uploaded' && up.state.parts.get(1).etag === 'etag-1',
    'the adopted part carries the server etag');
  ok(up.state.nextPartNumber === 3, 'numbering continues after the adopted parts');

  // Local part the server does not know about → re-upload.
  world = mockWorld({ partSize: 500, serverParts: [] });
  up = makeUploader(world);
  await up.begin({ recordingId: 'rec_1' });
  up.addChunk(chunk(500));
  await new Promise((r) => setTimeout(r, 20));
  up.state.parts.get(1).status = 'pending';
  const res2 = await up.resume('up_1');
  ok(res2.diff.reupload.includes(1), 'a part the server lacks is queued for re-upload');

  // ── J. Byte ceiling ──────────────────────────────────────────────────────
  console.log('\nJ. Byte ceiling');
  const events = [];
  world = mockWorld({ partSize: 1000, byteCeiling: 100 * 1024 * 1024 });
  up = makeUploader(world, { onEvent: (e) => events.push(e.type) });
  await up.begin({ recordingId: 'rec_1' });
  const ceiling = 100 * 1024 * 1024;
  up.state.recordedBytes = Math.floor(ceiling * 0.91);
  up.addChunk(chunk(10));
  ok(events.includes('ceiling-warning'), 'the recorder is warned at 90% of the ceiling');
  up.state.recordedBytes = ceiling - U.CEILING_HEADROOM_BYTES + 1;
  up.addChunk(chunk(10));
  ok(events.includes('ceiling-reached'),
    'the stop signal fires with headroom left, so the final part still fits');
  ok(U.CEILING_HEADROOM_BYTES === 16 * 1024 * 1024, 'the documented 16 MiB headroom');

  // A presign refused for exceeding the ceiling is fatal, not retried forever.
  world = mockWorld({ partSize: 500, presignStatus: 403 });
  up = makeUploader(world);
  await up.begin({ recordingId: 'rec_1' });
  up.addChunk(chunk(500));
  await up.finalize({});
  ok(up.status === 'failed', 'a ceiling refusal at presign fails the upload rather than spinning');

  // ── K. Completion verdicts ───────────────────────────────────────────────
  console.log('\nK. Completion');
  world = mockWorld({ partSize: 500, completeStatus: 403 });
  up = makeUploader(world);
  await up.begin({ recordingId: 'rec_1' });
  up.addChunk(chunk(500));
  const rej = await up.finalize({});
  ok(rej.ok === false && up.status === 'failed', 'a 403 at completion is a plan verdict — fatal');
  ok(up.state.fatal && up.state.fatal.upgradeRequired === true,
    'the verdict carries upgradeRequired so the UI can offer an upgrade');

  world = mockWorld({ partSize: 500, completeStatus: 503 });
  up = makeUploader(world);
  await up.begin({ recordingId: 'rec_1' });
  up.addChunk(chunk(500));
  const soft = await up.finalize({});
  ok(soft.ok === false && up.status === 'stalled',
    'a 5xx at completion is retryable — the session survives for another attempt');

  // A failed session start must not pretend to succeed.
  world = mockWorld();
  world.fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' });
  up = makeUploader(world);
  const began = await up.begin({ recordingId: 'rec_1' });
  ok(began === null && up.status === 'failed', 'a failed session start reports failure');

  // ── L. Wiring ────────────────────────────────────────────────────────────
  console.log('\nL. Recorder wiring');
  const fs = require('fs');
  const recSrc = fs.readFileSync(path.join(__dirname, '..', 'extension', 'recorder.js'), 'utf8');
  ok(/chunks\.push\(e\.data\)/.test(recSrc),
    'the legacy chunk buffer is STILL filled — the save-to-device fallback survives');
  ok(/if \(streamUploadReady\) \{ try \{ streamUploader\.addChunk\(e\.data\)/.test(recSrc), 'the uploader is fed from dataavailable (T-503: inside the startRecorder effect)');
  // T-304 REPLACED the client-side newUpload flag with the server decision. The
  // safety property is unchanged and still asserted here — the new path is OFF
  // unless something explicitly turns it on — but the switch now lives on the
  // SERVER, so a client can no longer opt itself into the rollout.
  ok(!/newUpload/.test(recSrc),
    'the client-side newUpload flag is GONE — the client cannot self-select into the rollout');
  ok(/api[/]client-config/.test(recSrc), 'the new path is gated by the server client-config decision');
  ok(/cfg[.]upload[.]path !== "v1"/.test(recSrc),
    'the path is OFF unless the server explicitly answers v1');
  ok(/finishStreamingUpload/.test(recSrc) && /const form = new FormData\(\)/.test(recSrc),
    'the legacy POST remains as the fallback when streaming did not finish');
  ok(/catch \(err\) \{ streamUploadReady = false; \}/.test(recSrc),
    'an uploader fault cannot interrupt the recording');
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'extension', 'recorder.html'), 'utf8');
  ok(/uploader\.js/.test(htmlSrc), 'uploader.js is loaded by the recorder page');
  const upSrc = fs.readFileSync(path.join(__dirname, '..', 'extension', 'uploader.js'), 'utf8');
  ok(!/cloudinary/i.test(upSrc), 'the uploader contains no Cloudinary logic');
  ok(!/api\/upload['"`]/.test(upSrc), 'the uploader never posts to the legacy endpoint');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
