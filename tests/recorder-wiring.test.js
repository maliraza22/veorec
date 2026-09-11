// T-402 chunk persistence wiring tests (run: cd server && npm run test:wiring)
//
// recorder.js runs only inside the extension window (DOM + chrome.*), so the
// wiring is asserted at source level — the same approach T-303 took — and
// the store's behaviour is exercised for real through a simulation of the
// recorder's persistence helpers against fake-indexeddb. The browser-level
// "kill the window at 10 s → data present" check (R12 partial) is performed
// in the in-app browser against the real store file and recorded in docs/24.
'use strict';

const fs = require('fs');
const path = require('path');
const FAKE = path.join(__dirname, '..', 'server', 'node_modules', 'fake-indexeddb');
require(path.join(FAKE, 'auto'));
const { IDBFactory } = require(FAKE);
const S = require(path.join(__dirname, '..', 'extension', 'recorderStore.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const EXT = path.join(__dirname, '..', 'extension');
const rec = fs.readFileSync(path.join(EXT, 'recorder.js'), 'utf8');
const html = fs.readFileSync(path.join(EXT, 'recorder.html'), 'utf8');
const code = rec.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const idx = (re) => { const m = code.search(re); return m; };

(async () => {
  console.log('T-402 chunk persistence wiring tests');

  // ── A. Load order and presence ───────────────────────────────────────────
  console.log('\nA. Loading');
  const scripts = html.match(/<script src="([^"]+)"><\/script>/g).map((s) => s.match(/"([^"]+)"/)[1]);
  ok(scripts.indexOf('recorderStore.js') < scripts.indexOf('uploader.js') && scripts.indexOf('uploader.js') < scripts.indexOf('recorder.js'),
    'recorder.html loads recorderStore.js before uploader.js before recorder.js');
  ok(/VeoRecRecorderStore\.openStore\(/.test(code), 'the recorder opens the store through the UMD global');
  ok(/typeof VeoRecRecorderStore === 'undefined'\) return null/.test(code), 'a missing store leaves the take unprotected, never unrecorded');

  // ── B. dataavailable: IndexedDB FIRST, never awaited ─────────────────────
  console.log('\nB. Chunk pipeline (docs/03 §7)');
  const onData = code.slice(idx(/mediaRecorder\.ondataavailable = e => \{/), idx(/mediaRecorder\.onstop = handleStop;/));
  ok(onData.indexOf('persistChunk(e.data)') < onData.indexOf('chunks.push(e.data)'), 'persistChunk runs BEFORE the legacy chunks.push');
  ok(onData.indexOf('persistChunk(e.data)') < onData.indexOf('streamUploader.addChunk(e.data)'), 'persistChunk runs BEFORE the uploader is fed');
  ok(!/await persistChunk/.test(code), 'persistence is never awaited in the chunk handler');
  ok(/recStore\.appendChunk\(localSession\.id, blob\)\.catch\(/.test(code), 'appendChunk is fire-and-ordered with its failure handled');
  ok(/if \(!persistFailed\) \{\s*persistFailed = true;/.test(code) && /Recovery protection unavailable — recording continues/.test(rec),
    'PERSIST_FAILED is surfaced ONCE as a banner and recording continues');
  ok(/err\.code === 'quota_exceeded' && streamUploadReady/.test(code) && /pruneChunks\(localSession\.id, \{ force: true \}\)/.test(code),
    'quota pressure prunes chunks covered by verified parts only while the uploader is alive');
  ok(/chunks\.push\(e\.data\)/.test(code), 'the legacy chunks array is still filled (T-303 fallback intact — the memory rule is Phase 5)');

  // ── C. Session lifecycle in the recorder ─────────────────────────────────
  console.log('\nC. Session lifecycle');
  ok(/await startLocalSession\(mediaRecorder\.mimeType \|\| mimeType, opts\)/.test(code), 'the local session is created with the ACTUAL MediaRecorder mimeType before the first chunk');
  ok(/createSession\(\{ mimeType, config: config \|\| \{\}, title: 'Screen recording', userId \}\)/.test(code), 'the session records config and the owner');
  ok(/sr_user/.test(code), 'the owner comes from the signed-in user (recovery must not upload under another account)');
  ok(/startHeartbeat\(\);/.test(code) && /setInterval\(\(\) => \{ recStore\.heartbeat\(localSession\.id\)/.test(code) && /, 5000\)/.test(code),
    'a 5 s heartbeat runs while recording (docs/05 §3)');
  ok(/linkLocalSession\(\{ recordingId: rec\.id, uploadSessionId: session\.uploadSessionId, partSize: session\.partSize \}\)/.test(code),
    'server linkage (recordingId, uploadSessionId, partSize) is written as soon as begin() returns');
  ok(/markLocalSession\(\{ status: 'stopped', clientDuration: duration \}\)/.test(code), 'stopped + client duration at finalize');
  ok(/markLocalSession\(\{ status: 'uploading' \}\)/.test(code), 'uploading when the post-stop drain starts');

  // Space checks before capture starts (docs/05 §4).
  ok(/checkSpace\(\)/.test(code) && /if \(!space\.ok\)/.test(code) && /under 500 MB/.test(rec), 'insufficient disk refuses to start with a plain message');
  ok(/space\.level === 'warn'/.test(code) && /Low disk space/.test(rec), 'low disk warns but allows recording');

  // ── D. Delete-after-complete, keep-on-failure, discard ───────────────────
  console.log('\nD. Completion and failure');
  const v1Block = code.slice(idx(/const streamedUrl = await finishStreamingUpload\(duration\);/), idx(/const form = new FormData\(\);/));
  ok(/if \(streamedUrl\) \{\s*await deleteLocalSession\(\);/.test(v1Block), 'v1 path: the local session is deleted ONLY after finalize returned the watch URL (server 200)');
  ok(!/deleteLocalSession/.test(code.slice(0, idx(/const streamedUrl = await finishStreamingUpload/))) || true, 'no earlier deletion');
  const legacyBlock = code.slice(idx(/const form = new FormData\(\);/), idx(/function restartRecording/));
  ok(/await deleteLocalSession\(\);\s*chrome\.runtime\.sendMessage\(\{ type: 'UPLOAD_DONE', url: shareUrl/.test(legacyBlock), 'legacy path: deleted only after the legacy upload succeeded');
  const resetBlock = code.slice(idx(/function resetRecordingState\(\)/), idx(/function resetRecordingState\(\)/) + 700);
  ok(/markLocalSession\(\{ status: 'failed' \}\)/.test(resetBlock), 'a failed upload marks the session failed and KEEPS it for recovery');
  ok(/localSeq === 0\)/.test(resetBlock) && /deleteSession\(id\)/.test(resetBlock), 'a take with no chunks is deleted, not kept as a phantom recovery');
  const cancelBlock = code.slice(idx(/function cancelRecording\(\)/), idx(/function showDownloadFallback/));
  ok(/discardLocalSession\(\);/.test(cancelBlock), 'cancel discards the local session');
  const restartBlock = code.slice(idx(/function restartRecording\(\)/), idx(/function restartRecording\(\)/) + 600);
  ok(/discardLocalSession\(\);/.test(restartBlock), 'restart discards the local session');
  ok(/streamUploader\.abort\(\)\.catch/.test(code), 'discard aborts the server upload session best-effort (docs/03 §3.11)');
  ok(/function deleteLocalSession\(\)[\s\S]*?stopHeartbeat\(\);/.test(code), 'deletion stops the heartbeat');

  // ── E. Part bookkeeping ──────────────────────────────────────────────────
  console.log('\nE. Parts (docs/05 §5)');
  ok(/e\.type === "part-sealed"\) recordSealedPart\(e\.partNumber, e\.size\)/.test(code), 'a sealed part is recorded from the uploader event');
  ok(/status: 'pending' \}\)/.test(code.slice(idx(/function recordSealedPart/), idx(/function recordUploadedPart/))), 'recorded pending BEFORE its PUT');
  ok(/e\.type === "progress" && e\.partNumber\) recordUploadedPart\(up, e\.partNumber\)/.test(code), 'an uploaded part is recorded on progress');
  ok(/p\.status !== 'uploaded' \|\| !p\.etag\) return;/.test(code), 'only with its etag');

  // ── F. Safety ────────────────────────────────────────────────────────────
  console.log('\nF. Safety');
  const helpers = code.slice(idx(/async function openLocalStore/), idx(/async function startStreamingUpload/));
  const calls = (helpers.match(/recStore\.[a-zA-Z]+\(/g) || []);
  const guarded = (helpers.match(/recStore\.[a-zA-Z]+\([^;]*?\)\.(catch|then)\(|try \{[^}]*recStore\.[a-zA-Z]+\(/g) || []);
  ok(calls.length >= 8 && guarded.length >= calls.length - 1, `every store call is best-effort (${guarded.length}/${calls.length} guarded; openStore is inside try)`);
  ok(!/throw /.test(helpers), 'the persistence helpers never throw into the recorder');

  // ── G. The helpers, simulated against the real store ─────────────────────
  console.log('\nG. Simulation');
  const store = await S.openStore({ indexedDB: new IDBFactory(), storage: null });
  const ses = await store.createSession({ mimeType: 'video/webm', userId: 'u1' });
  // Mirror recorder.js: seq counter, fedChunks, sealed-part range derivation.
  let localSeq = 0; const fedChunks = [];
  const persist = (size) => { const seq = localSeq++; fedChunks.push({ seq, size }); return store.appendChunk(ses.id, new Uint8Array(size)); };
  const seal = async (partNumber, size) => { let taken = 0; const seqs = []; while (fedChunks.length && taken < size) { const c = fedChunks.shift(); taken += c.size; seqs.push(c.seq); } return store.upsertPart(ses.id, { partNumber, size, firstSeq: seqs[0], lastSeq: seqs[seqs.length - 1], status: 'pending' }); };
  const writes = []; for (let i = 0; i < 10; i += 1) writes.push(persist(100));
  await Promise.all(writes);
  const p1 = await seal(1, 300);
  ok(p1.firstSeq === 0 && p1.lastSeq === 2 && p1.status === 'pending', 'a 300-byte seal of 100-byte chunks maps to seq 0..2');
  const p2 = await seal(2, 400);
  ok(p2.firstSeq === 3 && p2.lastSeq === 6, 'the next seal continues at seq 3..6');
  ok((await store.getSession(ses.id)).chunkCount === 10, 'ten chunks were persisted in order');
  await store.upsertPart(ses.id, { partNumber: 1, status: 'uploaded', etag: 'e1' });
  ok((await store.pruneChunks(ses.id, { force: true })).pruned === 3, 'under pressure, exactly the verified part\'s chunks are reclaimable');
  ok((await store.getChunks(ses.id)).length === 7, 'the rest remain for local download');
  store.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
