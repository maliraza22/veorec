// T-704 audio extract + captions VTT (run: cd worker && npm run test:audio)
//
// A. pure: WebVTT building (ordering, escaping, zero-length cues, timestamp
//    carry) and validation; B. real ffmpeg: aac extraction verified within
//    2 %, a mismatching duration is rejected, abort; C. the processors on
//    PostgreSQL + MinIO + Redis: audio_extract publishes `audio/{id}/audio.m4a`
//    as a ready `audio` asset (video-only → skipped, no row), a finished
//    transcript enqueues a `captions` job keyed by the transcript version,
//    the captions job publishes a `captions_vtt` asset the player can attach
//    as a `<track>`, re-transcription produces a new captions version that
//    reuses the row and overwrites the object, guards; D. wiring.
//
// SKIPS LOUDLY without infrastructure; AUDIO_TESTS_REQUIRED=1 makes that a failure.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const W = require(path.join(ROOT, 'worker', 'src', 'index.js'));
const C = require(path.join(ROOT, 'worker', 'src', 'media', 'captions.js'));
const AUD = require(path.join(ROOT, 'worker', 'src', 'media', 'audio.js'));
const IORedis = require(path.join(ROOT, 'worker', 'node_modules', 'ioredis'));
const { loadEnv, createPool, createClient, createRepositories, withTransaction: rawTx } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.AUDIO_TESTS_REQUIRED === '1';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6380';
const MINIO = process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100';
const RUN = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silent = W.silentLogger();
const REASON = 'T-704 audio/captions test';
const within = (a, b, pct) => Math.abs(Number(a) - Number(b)) / Number(b) <= pct;

(async () => {
  console.log('T-704 audio extract + captions tests');

  // ── A. WebVTT ─────────────────────────────────────────────────────────────
  console.log('\nA. WebVTT builder');
  const vtt = C.buildVtt([{ idx: 1, start: 1.5, end: 3.25, text: 'b <second> & more --> x' }, { idx: 0, start: 0, end: 0, text: 'first\nline' }, { idx: 2, start: 5, end: 4, text: '  ' }], { language: 'en', title: 'Demo' });
  ok(vtt.startsWith('WEBVTT\nLanguage: en\nTitle: Demo\n\n'), 'header with language and title');
  ok(vtt.includes('1\n00:00:00.000 --> 00:00:00.010\nfirst line\n') && vtt.includes('2\n00:00:01.500 --> 00:00:03.250\nb &lt;second&gt; &amp; more → x\n'), 'cues sorted by start, zero-length widened to 10 ms, newlines flattened, VTT-unsafe text escaped');
  ok(!vtt.includes('3\n'), 'an empty-text segment yields no cue');
  ok(C.ts(59.9996) === '00:01:00.000' && C.ts(3661.5) === '01:01:01.500' && C.ts(-1) === '00:00:00.000', 'timestamps carry milliseconds into seconds/minutes and never go negative');
  ok(C.validateVtt(vtt).ok && C.validateVtt(vtt).cues === 2, 'the document validates with 2 cues');
  ok(C.validateVtt('nope').ok === false && C.validateVtt('WEBVTT\n\n1\n00:00:02.000 --> 00:00:01.000\nx\n').ok === false, 'missing header / inverted timings are rejected');
  ok(C.buildVtt([]).trim() === 'WEBVTT' && C.validateVtt(C.buildVtt([])).cues === 0, 'no segments → an empty but valid document');
  ok(AUD.buildArgs('in', 'out').join(' ') === '-hide_banner -nostdin -y -i in -vn -c:a aac -b:a 96k -movflags +faststart out', 'docs/09 §6 command');

  const bins = W.resolveBinaries();
  let ffmpegOk = false;
  try { await W.runTool(bins.ffmpegBin, ['-version'], { timeout: 10000 }); await W.runTool(bins.ffprobeBin, ['-version'], { timeout: 10000 }); ffmpegOk = true; } catch {}
  if (!ffmpegOk) {
    console.log('\n  SKIPPED B–C — no ffmpeg/ffprobe');
    if (REQUIRED) { fail += 1; console.log('  FAIL: AUDIO_TESTS_REQUIRED=1 but ffmpeg is unavailable'); }
  } else {
    console.log('\nB. Real ffmpeg');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't704-'));
    const f = (n) => path.join(dir, n);
    const gen = (out, a) => W.runTool(bins.ffmpegBin, ['-hide_banner', '-nostdin', '-y', ...a, out], { timeout: 120000 });
    await gen(f('src.webm'), ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '4', '-c:v', 'libvpx', '-b:v', '200k', '-c:a', 'libopus']);
    await gen(f('vo.webm'), ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-t', '2', '-c:v', 'libvpx', '-b:v', '200k', '-an']);
    const prober = W.createProber({ ffprobeBin: bins.ffprobeBin, ffmpegBin: bins.ffmpegBin, logger: silent });
    const ax = AUD.createAudioExtractor({ ffmpegBin: bins.ffmpegBin, prober, logger: silent });
    const sf = await prober.probeFile(f('src.webm'));
    const r = await ax.extract(f('src.webm'), f('audio.m4a'), { sourceFacts: sf });
    ok(r.facts.audio.codec === 'aac' && !r.facts.video && within(r.facts.durationSec, sf.durationSec, 0.02) && r.bytes > 1000 && r.facts.container === 'mp4', 'opus → aac m4a, audio only, duration within 2 %');
    let threw = null; try { await ax.extract(f('src.webm'), f('bad.m4a'), { sourceFacts: { ...sf, durationSec: 40 } }); } catch (e) { threw = e; }
    ok(threw && threw.code === 'output_invalid', 'a duration mismatch fails verification');
    threw = null; try { await ax.extract(f('vo.webm'), f('vo.m4a'), { sourceFacts: await prober.probeFile(f('vo.webm')) }); } catch (e) { threw = e; }
    ok(threw && (threw.code === 'tool_failed' || threw.code === 'output_invalid'), 'a video-only source cannot be extracted (the processor skips it before calling)');
    const ac = new AbortController(); ac.abort();
    threw = null; try { await ax.extract(f('src.webm'), f('x.m4a'), { sourceFacts: sf, signal: ac.signal }); } catch (e) { threw = e; }
    ok(threw && threw.code === 'aborted', 'an aborted signal stops extraction');
    threw = null; try { AUD.createAudioExtractor({ ffmpegBin: 'x' }); } catch (e) { threw = e; }
    ok(threw && /prober/.test(threw.message), 'an extractor without a prober cannot exist');

    // ── C. Processors ───────────────────────────────────────────────────────
    let env = null, pgUp = false, redisUp = false, storageUp = false, pool = null;
    try { env = loadEnv({ appEnv: 'test' }); } catch (e) { console.log('  env:', e.message); }
    if (env) { pool = createPool({ env, max: 8 }); try { await pool.query('select 1'); pgUp = true; } catch {} }
    try { const c = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 1500, lazyConnect: true }); await c.connect(); redisUp = (await c.ping()) === 'PONG'; await c.quit(); } catch {}
    try { storageUp = (await fetch(`${MINIO}/minio/health/live`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
    if (!pgUp || !redisUp || !storageUp) {
      console.log(`\n  SKIPPED C — ${[!pgUp && 'PostgreSQL unreachable', !redisUp && `no Redis at ${REDIS_URL}`, !storageUp && `no object storage at ${MINIO}`].filter(Boolean).join(', ')}`);
      if (REQUIRED) { fail += 1; console.log('  FAIL: AUDIO_TESTS_REQUIRED=1 but infrastructure is unavailable'); }
    } else {
      console.log('\nC. Processors on real PostgreSQL + MinIO + Redis');
      const db = createClient(pool);
      const repositories = () => createRepositories(db);
      const repos = repositories();
      const withTransaction = (fn) => rawTx(fn, db);
      const storagePkg = require(path.join(ROOT, 'storage', 'src', 'index.js'));
      const storage = storagePkg.createStorageProvider({ appEnv: 'test' });
      const keys = storagePkg.keys;
      const U = `usr_t704_${RUN}`;
      await db.execute(sql`INSERT INTO users (id,email,name,password_hash) VALUES (${U}, ${`t704-${RUN}@example.com`}, 'T704', 'x')`);
      const rid = (k) => `rec_t704_${k}_${RUN}`;
      const created = [];
      const mkRec = async (k, file) => {
        const bytes = fs.readFileSync(f(file));
        await db.execute(sql`INSERT INTO recordings (id,user_id,title,status,source_kind,privacy,size_bytes) VALUES (${rid(k)}, ${U}, ${k}, 'uploaded', 'extension', 'unlisted', ${bytes.length})`);
        const key = `sources/${rid(k)}/source.webm`;
        await storage.putObject(key, bytes, { contentType: 'video/webm' });
        await db.execute(sql`INSERT INTO video_assets (id,recording_id,kind,storage_key,status,size_bytes,counts_toward_quota) VALUES (${`ast_t704_${k}_${RUN}`}, ${rid(k)}, 'source', ${key}, 'ready', ${bytes.length}, true)`);
        created.push(rid(k));
        return rid(k);
      };
      const rowOf = (key) => repos.jobs.findByDedupeKey(key);
      const assetsOf = (id) => repos.assets.listByRecordingSystem(id, REASON);
      const jobsOf = (id) => repos.jobs.listByRecordingSystem(id, REASON);
      const until = async (fn, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(150); } return false; };
      const registry = W.createRegistry();
      W.registerMediaProcessors(registry);
      W.registerSttProcessors(registry);
      const fakeTranscriber = { isConfigured: () => true, hasWhisperModel: () => false, transcribeFile: async () => ({ text: 'hello world again', language: 'english', source: 'groq', stats: {}, segments: [{ start: 0, end: 1.2, text: 'hello', language: 'english' }, { start: 1.2, end: 2.6, text: 'world', language: 'english' }, { start: 2.6, end: 3.9, text: 'again', language: 'english' }] }) };
      const deps = { storage, withTransaction, prober, audioExtractor: ax, keys, transcriber: fakeTranscriber, ai: null, resolveLimits: async () => ({ planSlug: 'pro', maxRecordingDurationSeconds: 36000 }) };
      const direct = async (type, dedupe, recordingId, payload = {}) => {
        let job = await rowOf(dedupe);
        if (!job) job = (await repos.jobs.enqueue({ queue: type, dedupeKey: dedupe, recordingId, payload: { recordingId, ...payload } })).job;
        job = await repos.jobs.markActiveSystem(job.id, REASON);
        try {
          const result = await registry.get(type).handler({ payload: { ...job.payload, ...payload }, job, signal: new AbortController().signal, logger: silent, deps, repositories });
          await repos.jobs.markCompletedSystem(job.id, result, REASON);
          return { result, job };
        } catch (e) { await repos.jobs.markFailedSystem(job.id, e.message, REASON, { terminal: e.retryable === false }); throw e; }
      };

      try {
        // audio_extract through the real worker app (media-only registry).
        const A = await mkRec('a', 'src.webm');
        const prefix = `t704${RUN}`;
        const q = W.createBullJobQueue({ redisUrl: REDIS_URL, prefix, logger: silent, stalledIntervalMs: 500, lockDurationMs: 1000 });
        const config = W.loadWorkerConfig({ REDIS_URL, QUEUE_PREFIX: prefix, OUTBOX_INTERVAL_MS: '100', RECONCILE_INTERVAL_MS: '600000', WORKER_SCHEDULER: 'false', WORKER_DEFER_MS: '100' }, { appEnv: 'test' });
        const app = W.createWorkerApp({ config, logger: silent, repositories, jobQueue: q, registry: W.createDefaultRegistry({ maintenance: false, stt: false }), deps: { ...deps, transcoder: W.createTranscoder({ ffmpegBin: bins.ffmpegBin, prober, logger: silent }), thumbnailer: W.createThumbnailer({ ffmpegBin: bins.ffmpegBin, prober, logger: silent }) } });
        await app.start();
        await repos.jobs.enqueue({ queue: 'probe', dedupeKey: `probe:${A}`, recordingId: A, payload: {} });
        ok(await until(async () => { const j = await rowOf(`audio:${A}`); return j && j.status === 'completed'; }, 120000), 'probe fans out and audio_extract completes through the real pipeline');
        const audioA = (await assetsOf(A)).find((a) => a.kind === 'audio');
        ok(audioA && audioA.status === 'ready' && audioA.storageKey === keys.audio(A) && audioA.codecAudio === 'aac' && audioA.container === 'm4a' && audioA.countsTowardQuota === false && Number(audioA.sizeBytes) > 0 && within(audioA.duration, 4, 0.05), 'the audio asset row is ready at audio/{id}/audio.m4a with facts, not billed');
        const head = await storage.headObject(audioA.storageKey);
        ok(head.contentType === 'audio/mp4' && head.contentLength === Number(audioA.sizeBytes), 'the object is stored as audio/mp4 with the recorded size');
        await app.stop();
        const qq = W.createBullJobQueue({ redisUrl: REDIS_URL, prefix, logger: silent }); await qq.obliterate(); await qq.close();
        // Idempotent re-run: same row.
        const r2 = await direct('audio_extract', `audio:${A}`, A);
        ok(r2.result.assetId === audioA.id && (await assetsOf(A)).filter((a) => a.kind === 'audio').length === 1, 're-running audio_extract reuses the same asset row');

        // Video-only → skipped, no row.
        const B = await mkRec('b', 'vo.webm');
        await direct('probe', `probe:${B}`, B);
        const rB = await direct('audio_extract', `audio:${B}`, B);
        ok(rB.result.skipped === 'no_audio' && !(await assetsOf(B)).some((a) => a.kind === 'audio'), 'a video-only source has nothing to extract (skipped, no audio row)');

        // Transcript → captions chain.
        const before = new Set((await jobsOf(A)).map((j) => j.dedupeKey));
        const rT = await direct('transcribe', `stt:${A}`, A, { recordingId: A, trigger: 'manual', aiDocs: false, chain: false });
        ok(rT.result.segments === 3, 'the (fake) transcription stored 3 segments');
        const capJob = (await jobsOf(A)).find((j) => j.queue === 'captions');
        const tA = await repos.transcripts.getForPublicWatch(A);
        ok(capJob && !before.has(capJob.dedupeKey) && capJob.dedupeKey === `captions:${A}:${new Date(tA.updatedAt).getTime()}` && capJob.status === 'queued' && capJob.payload.transcriptId === tA.id, 'a finished transcript enqueues a captions job keyed by the transcript version (even with chain:false — captions are part of the media pipeline)');
        const rC = await direct('captions', capJob.dedupeKey, A, capJob.payload);
        const cap = (await assetsOf(A)).find((a) => a.kind === 'captions_vtt');
        ok(cap && cap.status === 'ready' && cap.storageKey === keys.captions(A, cap.id) && cap.container === 'vtt' && rC.result.cues === 3 && rC.result.language === 'english', 'the captions asset is ready with 3 cues under an asset-id-scoped .vtt key');
        const obj = await storage.getObjectBuffer(cap.storageKey);
        const text = obj.body.toString('utf8');
        ok(obj.contentType === 'text/vtt' && text.startsWith('WEBVTT') && C.validateVtt(text).cues === 3 && /00:00:01\.200 --> 00:00:02\.600\nworld/.test(text), 'the object is text/vtt and the player can attach it as a <track>');
        // Re-transcription → a new captions version, same asset row, object overwritten.
        await sleep(20);
        fakeTranscriber.transcribeFile = async () => ({ text: 'only one', language: 'english', source: 'groq', stats: {}, segments: [{ start: 0, end: 2, text: 'only one', language: 'english' }] });
        await repos.jobs.requeueSystem((await rowOf(`stt:${A}`)).id, REASON, { resetAttempts: true, fromStatuses: ['completed'] });
        await direct('transcribe', `stt:${A}`, A, { recordingId: A, trigger: 'manual', aiDocs: false, chain: false });
        const capJobs = (await jobsOf(A)).filter((j) => j.queue === 'captions');
        ok(capJobs.length === 2 && capJobs.some((j) => j.status === 'queued'), 'a new transcript version gets its own captions job (dedupe key carries updated_at)');
        const cj2 = capJobs.find((j) => j.status === 'queued');
        await direct('captions', cj2.dedupeKey, A, cj2.payload);
        const cap2 = (await assetsOf(A)).filter((a) => a.kind === 'captions_vtt');
        ok(cap2.length === 1 && cap2[0].id === cap.id && C.validateVtt((await storage.getObjectBuffer(cap.storageKey)).body.toString('utf8')).cues === 1, 'the captions row is reused and the object overwritten with the new version');
        // Guards.
        const D = await mkRec('d', 'src.webm');
        let threw2 = null; try { await direct('captions', `captions:${D}:0`, D, { recordingId: D }); } catch (e) { threw2 = e; }
        ok(threw2 && threw2.code === 'transcript_required' && threw2.retryable === false, 'captions without a done transcript → terminal transcript_required');
        threw2 = null; try { await direct('audio_extract', `audio:${D}`, D); } catch (e) { threw2 = e; }
        ok(threw2 && threw2.code === 'probe_required', 'audio_extract before probe → probe_required');
        await db.execute(sql`update recordings set deleted_at = now() where id = ${D}`);
        threw2 = null; try { await direct('audio_extract', `audio:${D}`, D); } catch (e) { threw2 = e; }
        ok(threw2 && threw2.code === 'recording_gone', 'a deleted recording is a terminal no-op');
        // No-speech transcript → no captions job.
        const E = await mkRec('e', 'src.webm');
        fakeTranscriber.transcribeFile = async () => ({ text: '', language: 'english', source: 'groq', stats: {}, segments: [] });
        await direct('transcribe', `stt:${E}`, E, { recordingId: E, trigger: 'manual', chain: false });
        ok(!(await jobsOf(E)).some((j) => j.queue === 'captions'), 'no speech → no captions job');
      } finally {
        for (const id of created) {
          for (const p of [`derived/${id}/`, `audio/${id}/`, `sources/${id}/`]) { const list = await storage.listObjects(p).catch(() => ({ objects: [] })); for (const o of list.objects) await storage.deleteObject(o.key).catch(() => {}); }
        }
        await db.execute(sql`delete from users where id = ${U}`);
        await pool.end().catch(() => {});
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── D. Wiring ─────────────────────────────────────────────────────────────
  console.log('\nD. Wiring');
  const reg = W.createDefaultRegistry();
  ok(reg.has('audio_extract') && reg.has('captions') && reg.get('audio_extract').queue === 'media' && reg.get('captions').queue === 'media', 'audio_extract and captions are registered on the media queue');
  const keysPkg = require(path.join(ROOT, 'storage', 'src', 'keys.js')).keys;
  ok(keysPkg.captions('rec_x', 'ast_y') === 'derived/rec_x/ast_y/captions.vtt' && keysPkg.audio('rec_x') === 'audio/rec_x/audio.m4a', 'the key contract has captions and audio keys');
  const main = fs.readFileSync(path.join(ROOT, 'worker', 'src', 'main.js'), 'utf8');
  ok(/createAudioExtractor\(/.test(main), 'main.js builds the audio extractor');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
