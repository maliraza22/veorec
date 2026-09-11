// T-401 RecorderStore tests (run: cd server && npm run test:store)
//
// fake-indexeddb in Node — a real IndexedDB implementation (transactions,
// key ranges, structured clone), not a mock. Covers docs/05 §2–§5 and §7:
// schema, persistence request, space accounting, session lifecycle and the
// heartbeat, chunk ORDERING under un-awaited concurrent appends, the
// retry-once / persist_failed / quota_exceeded contract, part bookkeeping,
// pruning only under pressure, atomic deletion and 7-day GC.
'use strict';

const path = require('path');
const fs = require('fs');
// The suite lives in tests/; the dev dependency is installed in server/.
const FAKE = path.join(__dirname, '..', 'server', 'node_modules', 'fake-indexeddb');
require(path.join(FAKE, 'auto'));
const { IDBFactory } = require(FAKE);
const S = require(path.join(__dirname, '..', 'extension', 'recorderStore.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const bytes = (n, fill = 1) => new Uint8Array(n).fill(fill);
const fresh = async (opts = {}) => S.openStore({ indexedDB: new IDBFactory(), storage: null, ...opts });

(async () => {
  console.log('T-401 RecorderStore tests');

  // ── A. Schema and open ───────────────────────────────────────────────────
  console.log('\nA. Database');
  const logs = [];
  const storageStub = { persist: async () => true, estimate: async () => ({ quota: 10 * 1024 ** 3, usage: 1 * 1024 ** 3 }) };
  const st = await fresh({ storage: storageStub, log: (level, msg, meta) => logs.push({ level, msg, meta }) });
  ok(st.db.name === 'veorec-recorder' && st.db.version === 1, 'database is veorec-recorder v1');
  ok(['sessions', 'chunks', 'parts'].every((n) => st.db.objectStoreNames.contains(n)), 'the three object stores exist');
  const tx = st.db.transaction(['sessions', 'chunks', 'parts'], 'readonly');
  ok(tx.objectStore('sessions').keyPath === 'id', 'sessions keyPath id');
  ok(JSON.stringify(tx.objectStore('chunks').keyPath) === '["sessionId","seq"]', 'chunks keyPath [sessionId, seq]');
  ok(JSON.stringify(tx.objectStore('parts').keyPath) === '["sessionId","partNumber"]', 'parts keyPath [sessionId, partNumber]');
  ok(st.persisted === true && logs.some((l) => /persistence granted/.test(l.msg)), 'persist() was requested and the grant result logged');
  const denied = await fresh({ storage: { persist: async () => false }, log: (l, m) => logs.push({ msg: m }) });
  ok(denied.persisted === false && logs.some((l) => /not granted/.test(l.msg)), 'a denied persist is logged, not fatal');
  const throwing = await fresh({ storage: { persist: async () => { throw new Error('nope'); } } });
  ok(throwing.persisted === null, 'a throwing persist() is best-effort (null), not fatal');
  const noStorage = await fresh({ storage: null });
  ok(noStorage.persisted === null, 'no StorageManager → no request, still opens');

  // ── B. Space accounting (docs/05 §4) ─────────────────────────────────────
  console.log('\nB. Space');
  const GiB = 1024 ** 3, MiB = 1024 ** 2;
  const spaceAt = async (quota, usage) => (await fresh({ storage: { estimate: async () => ({ quota, usage }) } })).checkSpace();
  ok((await spaceAt(10 * GiB, 1 * GiB)).level === 'ok', '9 GB free → ok');
  ok((await spaceAt(10 * GiB, 8.5 * GiB)).level === 'warn', '1.5 GB free → warn');
  const insufficient = await spaceAt(10 * GiB, 10 * GiB - 400 * MiB);
  ok(insufficient.level === 'insufficient_disk' && insufficient.ok === false, '400 MB free → insufficient_disk, do not start');
  ok((await spaceAt(0, 0)).level === 'ok', 'an unknown quota (0) does not block');
  ok((await (await fresh({ storage: { estimate: async () => { throw new Error('x'); } } })).checkSpace()).level === 'unknown', 'a failing estimate() is unknown and does not block');
  ok((await noStorage.checkSpace()).level === 'unknown', 'no StorageManager → unknown, does not block');

  // ── C. Sessions and the heartbeat (docs/05 §3) ───────────────────────────
  console.log('\nC. Sessions');
  let clock = 1_000_000;
  const s1 = await fresh({ now: () => clock });
  const ses = await s1.createSession({ mimeType: 'video/webm;codecs=vp9', config: { mode: 'screen' }, title: 'T', userId: 'legacy-u1' });
  ok(typeof ses.id === 'string' && ses.status === 'recording' && ses.chunkCount === 0 && ses.totalBytes === 0, 'a session starts recording with zero chunks');
  ok(ses.createdAt === clock && ses.updatedAt === clock && ses.userId === 'legacy-u1', 'timestamps and owner recorded');
  ok(ses.recordingId === null && ses.uploadSessionId === null && ses.storageUploadId === null, 'server linkage is null until known (offline start)');
  ok(JSON.stringify(await s1.getSession(ses.id)) === JSON.stringify(ses), 'getSession returns the stored row');
  ok(s1.liveness(ses, clock + 5000) === 'live', 'a session heartbeat within 15 s is live');
  ok(s1.liveness(ses, clock + 15001) === 'dead', 'a session silent for more than 15 s is dead (crashed)');
  clock += 20000;
  await s1.heartbeat(ses.id);
  ok(s1.liveness(await s1.getSession(ses.id), clock + 1000) === 'live', 'a heartbeat revives liveness');
  const linked = await s1.updateSession(ses.id, { recordingId: 'rec_1', uploadSessionId: 'up_1', storageUploadId: 'U1', partSize: 8 * MiB });
  ok(linked.recordingId === 'rec_1' && linked.uploadSessionId === 'up_1' && linked.partSize === 8 * MiB, 'server linkage is set as soon as known');
  ok((await s1.setStatus(ses.id, 'stopped')).status === 'stopped', 'status transitions');
  ok(s1.liveness(await s1.getSession(ses.id)) === 'not_recording', 'a stopped session is not a live recording');
  let threw = null; try { await s1.setStatus(ses.id, 'bogus'); } catch (e) { threw = e; }
  ok(threw && threw.code === 'invalid_status', 'an unknown status is refused');
  threw = null; try { await s1.updateSession('missing', { title: 'x' }); } catch (e) { threw = e; }
  ok(threw && threw.code === 'not_found', 'updating a missing session is not_found');
  const other = await s1.createSession({ title: 'other' });
  ok((await s1.listSessions()).map((s) => s.id).join() === [ses.id, other.id].join(), 'listSessions is ordered by creation');

  // ── D. Chunk ordering and the persist contract (docs/05 §4) ──────────────
  console.log('\nD. Chunks');
  const s2 = await fresh({ now: () => clock });
  const rec = await s2.createSession({});
  // Fire 100 appends WITHOUT awaiting — the recorder never blocks on disk.
  const pending = [];
  for (let i = 0; i < 100; i += 1) pending.push(s2.appendChunk(rec.id, bytes(10 + i, i % 256)));
  const results = await Promise.all(pending);
  ok(results.every((r, i) => r.seq === i), 'seq is assigned in arrival order under 100 un-awaited concurrent appends');
  const rows = await s2.getChunks(rec.id);
  ok(rows.length === 100 && rows.every((r, i) => r.seq === i && r.size === 10 + i), 'all 100 chunks are stored, in order, with sizes');
  const after = await s2.getSession(rec.id);
  ok(after.chunkCount === 100 && after.totalBytes === results.reduce((n, r) => n + r.size, 0), 'chunkCount and totalBytes are maintained in the same transaction');
  const slice = await s2.getChunks(rec.id, { fromSeq: 10, toSeq: 12 });
  ok(slice.length === 3 && slice[0].seq === 10 && slice[2].seq === 12, 'a seq range is inclusive and ordered');
  const blob = await s2.assembleBlob(rec.id);
  ok(blob.size === after.totalBytes, 'assembleBlob concatenates every chunk');
  const buf = new Uint8Array(await blob.arrayBuffer());
  ok(buf[0] === 0 && buf[10] === 1 && buf[10 + 11] === 2, 'assembled bytes are in seq order');
  threw = null; try { await s2.appendChunk('missing', bytes(1)); } catch (e) { threw = e; }
  ok(threw && threw.code === 'not_found', 'appending to a missing session is not_found (no retry loop)');

  // Retry-once, then persist_failed — injected via a failing transaction.
  const s3 = await fresh({ now: () => clock });
  const r3 = await s3.createSession({});
  const realTx = s3.db.transaction.bind(s3.db);
  let failures = 0;
  s3.db.transaction = (stores, mode) => {                 // fail the first write, succeed on retry
    if (mode === 'readwrite' && failures < 1) { failures += 1; const e = new Error('disk hiccup'); throw e; }
    return realTx(stores, mode);
  };
  const retried = await s3.appendChunk(r3.id, bytes(5));
  ok(retried.seq === 0 && failures === 1, 'a failed write is retried once and then succeeds');
  failures = 0;
  s3.db.transaction = (stores, mode) => { if (mode === 'readwrite') { failures += 1; throw new Error('disk gone'); } return realTx(stores, mode); };
  threw = null; try { await s3.appendChunk(r3.id, bytes(5)); } catch (e) { threw = e; }
  ok(threw && threw.code === 'persist_failed' && failures === 2, 'two failures → persist_failed (exactly one retry)');
  failures = 0;
  s3.db.transaction = (stores, mode) => { if (mode === 'readwrite') { failures += 1; const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } return realTx(stores, mode); };
  threw = null; try { await s3.appendChunk(r3.id, bytes(5)); } catch (e) { threw = e; }
  ok(threw && threw.code === 'quota_exceeded' && failures === 1, 'QuotaExceededError → quota_exceeded without a pointless retry');
  s3.db.transaction = realTx;
  ok((await s3.appendChunk(r3.id, bytes(5))).seq === 1, 'the queue survives failures and keeps assigning seq (the recording went on)');
  ok((await s3.getSession(r3.id)).chunkCount === 2, 'failed writes never advanced chunkCount');

  // ── E. Parts (docs/05 §5) ────────────────────────────────────────────────
  console.log('\nE. Parts');
  const s4 = await fresh({ now: () => clock });
  const r4 = await s4.createSession({});
  for (let i = 0; i < 6; i += 1) await s4.appendChunk(r4.id, bytes(100));
  const p1 = await s4.upsertPart(r4.id, { partNumber: 1, firstSeq: 0, lastSeq: 2, size: 300, crc32c: 'AAAA' });
  ok(p1.status === 'pending' && p1.etag === null && p1.attempts === 0, 'a sealed part is recorded pending BEFORE any PUT');
  ok((await s4.setPartStatus(r4.id, 1, { status: 'inflight', attempts: 1 })).status === 'inflight', 'inflight on start');
  const up1 = await s4.setPartStatus(r4.id, 1, { status: 'uploaded', etag: 'etag-1' });
  ok(up1.status === 'uploaded' && up1.etag === 'etag-1', 'uploaded with its etag (needed for CompleteMultipartUpload)');
  await s4.upsertPart(r4.id, { partNumber: 2, firstSeq: 3, lastSeq: 5, size: 300 });
  const parts = await s4.listParts(r4.id);
  ok(parts.length === 2 && parts[0].partNumber === 1 && parts[1].partNumber === 2, 'parts list is ordered by partNumber');
  threw = null; try { await s4.upsertPart(r4.id, { partNumber: 0 }); } catch (e) { threw = e; }
  ok(threw && threw.code === 'invalid_part', 'partNumber is 1-based');
  threw = null; try { await s4.setPartStatus(r4.id, 9, { status: 'uploaded' }); } catch (e) { threw = e; }
  ok(threw && threw.code === 'not_found', 'a missing part is not_found');
  const merged = await s4.upsertPart(r4.id, { partNumber: 1, attempts: 3 });
  ok(merged.etag === 'etag-1' && merged.status === 'uploaded' && merged.attempts === 3, 'upsert merges without losing the etag');

  // Pruning: only uploaded+etag parts, and only under pressure.
  ok((await s4.pruneChunks(r4.id)).skipped === 'no_pressure' && (await s4.getChunks(r4.id)).length === 6, 'by default nothing is pruned — local download keeps full fidelity');
  const pruned = await s4.pruneChunks(r4.id, { force: true });
  ok(pruned.pruned === 3 && (await s4.getChunks(r4.id)).length === 3, 'under pressure, chunks covered by an uploaded+etag part are pruned (3 of 6)');
  ok((await s4.getChunks(r4.id)).every((c) => c.seq >= 3), 'chunks of the not-yet-uploaded part 2 remain');
  await s4.setPartStatus(r4.id, 2, { status: 'uploaded' });             // uploaded but NO etag yet
  ok((await s4.pruneChunks(r4.id, { force: true })).pruned === 0, 'an uploaded part without an etag is NOT pruned (etag is the durable proof)');

  // ── F. Cleanup (docs/05 §7) ──────────────────────────────────────────────
  console.log('\nF. Cleanup');
  const s5 = await fresh({ now: () => clock });
  const a = await s5.createSession({ title: 'a' });
  const b = await s5.createSession({ title: 'b' });
  for (let i = 0; i < 3; i += 1) { await s5.appendChunk(a.id, bytes(10)); await s5.appendChunk(b.id, bytes(10)); }
  await s5.upsertPart(a.id, { partNumber: 1, firstSeq: 0, lastSeq: 2, size: 30 });
  await s5.upsertPart(b.id, { partNumber: 1, firstSeq: 0, lastSeq: 2, size: 30 });
  await s5.deleteSession(a.id);
  ok((await s5.getSession(a.id)) === null && (await s5.getChunks(a.id)).length === 0 && (await s5.listParts(a.id)).length === 0,
    'deleteSession removes the session, its chunks and its parts');
  ok((await s5.getSession(b.id)) && (await s5.getChunks(b.id)).length === 3 && (await s5.listParts(b.id)).length === 1,
    'and touches nothing of another session');
  await s5.deleteSession(a.id);
  ok(true, 'deleting an already-deleted session is harmless');

  // 7-day GC.
  const gcLogs = [];
  const s6 = await fresh({ now: () => clock, log: (l, m, meta) => gcLogs.push({ m, meta }) });
  const old = await s6.createSession({ title: 'old' });
  await s6.appendChunk(old.id, bytes(1));
  clock += S.GC_AGE_MS + 1000;
  const young = await s6.createSession({ title: 'young' });
  const gcd = await s6.gc();
  ok(gcd.deleted.length === 1 && gcd.deleted[0] === old.id, 'gc deletes only sessions untouched for 7 days');
  ok((await s6.getSession(young.id)) && (await s6.getChunks(old.id)).length === 0, 'the young session survives; the old one\'s chunks are gone');
  ok(gcLogs.some((l) => /garbage-collected/.test(l.m)), 'gc leaves a console notice');
  ok((await s6.gc()).deleted.length === 0, 'gc is idempotent');

  // ── G. Boundaries ────────────────────────────────────────────────────────
  console.log('\nG. Boundaries');
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'recorderStore.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');   // comments may name things code may not use
  ok(/module\.exports = factory\(\)/.test(src) && /root\.VeoRecRecorderStore = factory\(\)/.test(src), 'plain UMD, like the uploader — no build step');
  ok(!/chrome\./.test(code), 'no chrome.* API use — usable from any extension context');
  ok(!/fetch\(|XMLHttpRequest/.test(code), 'no network');
  ok(!/uploader|VeoRecUploader/i.test(code), 'knows nothing about the uploader');
  ok(S.DB_NAME === 'veorec-recorder' && S.DB_VERSION === 1 && S.HEARTBEAT_STALE_MS === 15000 && S.GC_AGE_MS === 7 * 24 * 3600 * 1000,
    'constants match docs/05');
  ok(S.SPACE_WARN_BELOW === 2 * GiB && S.SPACE_REFUSE_BELOW === 500 * MiB, 'space thresholds match docs/05 §4');

  for (const s of [st, denied, throwing, noStorage, s1, s2, s3, s4, s5, s6]) s.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
