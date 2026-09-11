// T-402 chunk persistence wiring tests (run: cd server && npm run test:wiring)
//
// recorder.js runs only inside the extension window (DOM + chrome.*), so the
// wiring is asserted at source level — the same approach T-303 took — and
// the store's behaviour is exercised for real through a simulation of the
// recorder's persistence helpers against fake-indexeddb. Since T-503 the
// recorder is a renderer of RecorderMachine projections: the persistence
// obligations now live in the machine's EFFECTS (createSession, startRecorder,
// finalize, complete, cleanup, download) and are asserted there.
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
const idx = (re) => code.search(re);
const section = (startRe, endRe) => { const a = idx(startRe); const b = code.slice(a + 1).search(endRe); return b < 0 ? code.slice(a) : code.slice(a, a + 1 + b); };

(async () => {
  console.log('T-402 chunk persistence wiring tests');

  // ── A. Load order and presence ───────────────────────────────────────────
  console.log('\nA. Loading');
  const scripts = html.match(/<script src="([^"]+)"><\/script>/g).map((s) => s.match(/"([^"]+)"/)[1]);
  ok(scripts.indexOf('recorderStore.js') < scripts.indexOf('uploader.js') && scripts.indexOf('uploader.js') < scripts.indexOf('recorder.js'),
    'recorder.html loads recorderStore.js before uploader.js before recorder.js');
  ok(/VeoRecRecorderStore\.openStore\(/.test(code), 'the recorder opens the store through the UMD global');
  ok(/typeof VeoRecRecorderStore === 'undefined'\) return null/.test(code), 'a missing store leaves the take unprotected, never unrecorded');

  // ── B. dataavailable: IndexedDB FIRST, never awaited (docs/03 §7) ────────
  console.log('\nB. Chunk pipeline (docs/03 §7)');
  const onData = section(/mediaRecorder\.ondataavailable = \(e\) => \{/, /mediaRecorder\.onstop =/);
  ok(onData.indexOf('persistChunk(e.data)') < onData.indexOf('chunks.push(e.data)'), 'persistChunk runs BEFORE the legacy chunks.push');
  ok(onData.indexOf('persistChunk(e.data)') < onData.indexOf('streamUploader.addChunk(e.data)'), 'persistChunk runs BEFORE the uploader is fed');
  ok(onData.indexOf('streamUploader.addChunk(e.data)') < onData.indexOf("machine.send({ type: 'CHUNK'"), 'the machine\'s limit clock is fed last');
  ok(!/await persistChunk/.test(code), 'persistence is never awaited in the chunk handler');
  ok(/recStore\.appendChunk\(localSession\.id, blob\)\.catch\(/.test(code), 'appendChunk is fire-and-ordered with its failure handled');
  ok(/if \(!persistFailed\) \{\s*persistFailed = true;/.test(code) && /Recovery protection unavailable — recording continues/.test(rec),
    'PERSIST_FAILED is surfaced ONCE as a banner and recording continues');
  ok(/err\.code === 'quota_exceeded' && streamUploadReady/.test(code) && /pruneChunks\(localSession\.id, \{ force: true \}\)/.test(code),
    'quota pressure prunes chunks covered by verified parts only while the uploader is alive');
  ok(/chunks\.push\(e\.data\)/.test(code), 'the legacy chunks array is still filled (T-303 fallback intact — the memory rule is a Phase 5 follow-up)');

  // ── C. Session lifecycle in the machine's effects ────────────────────────
  console.log('\nC. Session lifecycle');
  const effectsSrc = section(/const effects = \{/, /const machine = VeoRecMachine\.createMachine/);
  ok(/createSession\(\) \{[\s\S]*?startLocalSession\(mime, opts\)/.test(effectsSrc), 'the createSession effect creates the local row (the machine calls it BEFORE startRecorder — docs/03 §3.4 step 1)');
  ok(/startLocalSession\(mediaRecorder|startLocalSession\(mime/.test(code) && /linkLocalSession\(\{ mimeType: mediaRecorder\.mimeType \}\)/.test(code), 'the session records the ACTUAL MediaRecorder mimeType once the recorder exists');
  ok(/createSession\(\{ mimeType, config: config \|\| \{\}, title: 'Screen recording', userId \}\)/.test(code), 'the session records config and the owner');
  ok(/sr_user/.test(code), 'the owner comes from the signed-in user (recovery must not upload under another account)');
  ok(/startHeartbeat\(\);/.test(effectsSrc) && /setInterval\(\(\) => \{ recStore\.heartbeat\(localSession\.id\)/.test(code) && /, 5000\)/.test(code),
    'a 5 s heartbeat runs while recording (docs/05 §3)');
  ok(/linkLocalSession\(\{ recordingId: rec\.id, uploadSessionId: session\.uploadSessionId, partSize: session\.partSize \}\)/.test(code),
    'server linkage (recordingId, uploadSessionId, partSize) is written as soon as begin() returns');
  ok(/finalize\(ctx\) \{[\s\S]*?markLocalSession\(\{ status: 'stopped', clientDuration: duration \}\)/.test(effectsSrc), 'stopped + client duration at finalize');
  ok(/startUpload\(ctx\) \{[\s\S]*?markLocalSession\(\{ status: 'uploading' \}\)/.test(effectsSrc), 'uploading when the post-stop drain starts');
  ok(/persist\(patch\) \{ markLocalSession\(patch\); \}/.test(effectsSrc), 'the machine\'s persist effect writes every status transition (docs/03 §1 rule 2)');

  // Space checks before START (docs/05 §4).
  const startSrc = section(/async function startRecording\(\)/, /mainBtn\.addEventListener/);
  ok(/checkSpace\(\)/.test(startSrc) && /if \(!space\.ok\)/.test(startSrc) && /under 500 MB/.test(rec), 'insufficient disk refuses to start with a plain message');
  ok(/space\.level === 'warn'/.test(startSrc) && /Low disk space/.test(rec), 'low disk warns but allows recording');

  // ── D. Delete-after-complete, keep-on-failure, discard ───────────────────
  console.log('\nD. Completion and failure');
  ok(/complete\(ctx\) \{[\s\S]*?await deleteLocalSession\(\);/.test(effectsSrc), 'the complete effect deletes the local session — the machine enters completed ONLY on UPLOAD_COMPLETE');
  const uploadSrc = section(/async function runUpload\(ctx\)/, /const captureManager =/);
  ok(/if \(streamedUrl\) return machine\.send\(\{ type: 'UPLOAD_COMPLETE'/.test(uploadSrc), 'v1 path: UPLOAD_COMPLETE only after finalize returned the watch URL (server 200)');
  ok(/if \(!res\.ok\) \{[\s\S]*?UPLOAD_FAILED[\s\S]*?\}\s*return machine\.send\(\{ type: 'UPLOAD_COMPLETE', recordingId: data\.id/.test(uploadSrc), 'legacy path: UPLOAD_COMPLETE only after the legacy upload succeeded, UPLOAD_FAILED otherwise');
  ok(!/deleteLocalSession/.test(uploadSrc), 'the upload drain itself never deletes local data');
  ok(/upload_failed\(\) \{ persist\(\{ status: 'failed' \}\); \}/.test(fs.readFileSync(path.join(EXT, 'machine.js'), 'utf8')) && /keepLocalSessionForRecovery\(\)/.test(code),
    'a failed upload marks the session failed and KEEPS it for recovery');
  const keepSrc = section(/function keepLocalSessionForRecovery\(\)/, /async function loadQuotaPreflight/);
  ok(/localSeq === 0\)/.test(keepSrc) && /deleteSession\(id\)/.test(keepSrc), 'a take with no chunks is deleted, not kept as a phantom recovery');
  ok(/cleanup\(ctx\) \{[\s\S]*?discardLocalSession\(\);/.test(effectsSrc), 'cancel/restart (the cleanup effect) discards the local session');
  ok(/discard\(\) \{ discardLocalSession\(\); \}/.test(effectsSrc), 'an explicit DISCARD discards it');
  ok(/streamUploader\.abort\(\)\.catch/.test(code), 'discard aborts the server upload session best-effort (docs/03 §3.11)');
  ok(/async function deleteLocalSession\(\) \{\s*stopHeartbeat\(\);/.test(code), 'deletion stops the heartbeat');
  ok(/if \(machine\.state === 'upload_failed'\) \{[\s\S]*?keepLocalSessionForRecovery\(\);\s*window\.location\.reload\(\);/.test(code), 'Start from upload_failed keeps the take and relaunches (the scan offers recovery)');

  // ── E. Part bookkeeping ──────────────────────────────────────────────────
  console.log('\nE. Parts (docs/05 §5)');
  ok(/e\.type === "part-sealed"\) recordSealedPart\(e\.partNumber, e\.size\)/.test(code), 'a sealed part is recorded from the uploader event');
  ok(/status: 'pending' \}\)/.test(section(/function recordSealedPart/, /function recordUploadedPart/)), 'recorded pending BEFORE its PUT');
  ok(/e\.type === "progress" && e\.partNumber\) recordUploadedPart\(up, e\.partNumber\)/.test(code), 'an uploaded part is recorded on progress');
  ok(/p\.status !== 'uploaded' \|\| !p\.etag\) return;/.test(code), 'only with its etag');

  // ── F. Safety ────────────────────────────────────────────────────────────
  console.log('\nF. Safety');
  const helpers = section(/async function openLocalStore/, /async function loadQuotaPreflight/);
  const calls = (helpers.match(/recStore\.[a-zA-Z]+\(/g) || []);
  const guarded = (helpers.match(/recStore\.[a-zA-Z]+\([^;]*?\)\.(catch|then)\(|try \{[^}]*recStore\.[a-zA-Z]+\(/g) || []);
  ok(calls.length >= 8 && guarded.length >= calls.length - 1, `every store call is best-effort (${guarded.length}/${calls.length} guarded; openStore is inside try)`);
  ok(!/throw /.test(helpers), 'the persistence helpers never throw into the recorder');

  // ── G. The helpers, simulated against the real store ─────────────────────
  console.log('\nG. Simulation');
  const store = await S.openStore({ indexedDB: new IDBFactory(), storage: null });
  const ses = await store.createSession({ mimeType: 'video/webm', userId: 'u1' });
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
