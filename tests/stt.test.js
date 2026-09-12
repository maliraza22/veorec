// T-603 transcription as a job (run: cd worker && npm run test:stt)
//
// A. pure helpers (no infrastructure); B. the relocated pipeline against a
// scriptable Groq MOCK + real ffmpeg (ffmpeg-static) on synthetic audio —
// multi-language passes, Retry-After on 429, chunk skips, whole-file fallback,
// whisper.cpp fallback (fake whisper-cli), abort, shared rate gate; C. the LLM
// helper against the mock; D. the processors end-to-end on real PostgreSQL +
// MinIO + Redis, incl. the chain, the DEFAULT_TITLES guard, no_speech,
// idempotent re-run, translation cache and a worker SIGKILLed mid-job;
// E. the legacy server wires the async router and no longer transcribes in
// process for v1.
//
// The REAL Groq key is never used: the transcriber is pointed at the mock.
// SKIPS LOUDLY without infrastructure; STT_TESTS_REQUIRED=1 makes that a failure.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const W = require(path.join(ROOT, 'worker', 'src', 'index.js'));
const IORedis = require(path.join(ROOT, 'worker', 'node_modules', 'ioredis'));
const { createGroqMock } = require('./fixtures/groq-mock');
const { loadEnv, createPool, createClient, createRepositories, withTransaction: rawTx } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.STT_TESTS_REQUIRED === '1';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6380';
const MINIO = process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100';
const RUN = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silent = W.silentLogger();
const REASON = 'T-603 stt test';
const FAKE_WHISPER = path.join(__dirname, 'fixtures', 'fake-whisper-cli.js');

let FFMPEG = process.env.FFMPEG_BIN || null, FFPROBE = process.env.FFPROBE_BIN || null;
try { FFMPEG = FFMPEG || require(path.join(ROOT, 'worker', 'node_modules', 'ffmpeg-static')); } catch {}
try { FFPROBE = FFPROBE || require(path.join(ROOT, 'worker', 'node_modules', 'ffprobe-static')).path; } catch {}

/** 16 kHz mono PCM16 WAV: [{sec, tone}] — tone = 440 Hz at −10 dBFS, else digital silence. */
function writeWav(file, pattern) {
  const rate = 16000;
  const total = Math.round(pattern.reduce((s, p) => s + p.sec, 0) * rate);
  const data = Buffer.alloc(total * 2);
  let i = 0;
  for (const p of pattern) {
    const n = Math.round(p.sec * rate);
    for (let k = 0; k < n; k += 1, i += 1) {
      const v = p.tone ? Math.round(Math.sin(2 * Math.PI * 440 * (i / rate)) * 0.3 * 32767) : 0;
      data.writeInt16LE(v, i * 2);
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

(async () => {
  console.log('T-603 transcription-as-a-job tests');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't603-'));
  const modelFile = path.join(tmp, 'ggml-base.bin'); fs.writeFileSync(modelFile, 'fake model');
  const noModel = path.join(tmp, 'missing.bin');
  // 3 speech chunks (each ≥ 3 s after padding): 4 s | 1 s pause | 3.8 s | 1 s pause | 3.5 s = 13.3 s
  const SPEECH = writeWav(path.join(tmp, 'speech.wav'), [{ sec: 4, tone: true }, { sec: 1, tone: false }, { sec: 3.8, tone: true }, { sec: 1, tone: false }, { sec: 3.5, tone: true }]);
  const CONTINUOUS = writeWav(path.join(tmp, 'continuous.wav'), [{ sec: 5, tone: true }]);
  const CORRUPT = path.join(tmp, 'corrupt.webm'); fs.writeFileSync(CORRUPT, 'this is not media');

  // ── A. Pure helpers ────────────────────────────────────────────────────────
  console.log('\nA. Pure helpers');
  {
    const c = W.buildSpeechChunks([{ start: 4, end: 5 }, { start: 8.8, end: 9.8 }], 13);
    ok(c.length === 3 && c[0].start === 0 && Math.abs(c[0].end - 4.15) < 1e-9 && Math.abs(c[1].start - 4.85) < 1e-9 && c[2].end === 13, 'silences invert to padded speech chunks (0.15 s into the pause)');
    const sliver = W.buildSpeechChunks([{ start: 4, end: 5 }, { start: 6, end: 7 }], 12);
    ok(sliver.length === 2 && sliver[0].end > 6, 'a chunk under 3 s folds into the previous one');
    const capped = W.buildSpeechChunks([], 100);
    ok(capped.length === 3 && capped[0].end === 40 && capped[1].start === 40 && capped[2].end === 100, 'no pauses → 40 s caps');
    ok(W.buildSpeechChunks([], 0).length === 0, 'unknown duration → no chunks (whole-file fallback)');
    ok(W.capChunkCount(Array.from({ length: 90 }, (_, i) => ({ start: i, end: i + 1 })), 40).length <= 40, 'pairwise merge caps the Groq call count at 40');
    const sil = W.parseSilences('[silencedetect] silence_start: 4.0125\n[silencedetect] silence_end: 5.02 | silence_duration: 1.0\n[silencedetect] silence_start: 8.8\n');
    ok(sil.length === 1 && sil[0].start === 4.0125 && sil[0].end === 5.02, 'silencedetect stderr parses; an unclosed silence is ignored');
    const m = W.mapGroqJson({ language: 'urdu', segments: [{ start: 0, end: 1, text: ' سلام ', no_speech_prob: 0.1, avg_logprob: -0.3 }, { start: 1, end: 2, text: 'garbage', no_speech_prob: 0.7, avg_logprob: -1.2 }, { start: 2, end: 3, text: '  ', no_speech_prob: 0.1, avg_logprob: -0.1 }] }, 30);
    ok(m.segments.length === 1 && m.segments[0].start === 30 && m.segments[0].end === 31 && m.language === 'urdu' && m.text === 'سلام', 'verbose_json → segments with absolute offsets; hallucination signature and empty text dropped');
    ok(W.WHISPER_NAME_TO_CODE.urdu === 'ur' && W.WHISPER_NAME_TO_CODE.english === 'en' && W.WHISPER_NAME_TO_CODE.korean === 'ko', 'the language-name → ISO map is intact');
    ok(W.generateTitle('Okay so today I am going to show you how to configure the billing dashboard for your team.') === 'Configure the Billing Dashboard for Your Team', 'the heuristic title strips openers and title-cases');
    ok(W.generateTitle('hi') === null && W.generateTitle('') === null, 'too little text → no title');
    const cfg = W.sttConfigFromEnv({});
    ok(cfg.chunkGapMs === 3100 && cfg.groqSttModel === 'whisper-large-v3' && cfg.groqBaseUrl === 'https://api.groq.com' && cfg.dominantMinShare === 0.15 && cfg.maxChunks === 40 && cfg.chunkMaxSec === 40 && cfg.chunkMinSec === 3 && cfg.vadNoise === '-30dB', 'env defaults are the legacy tuning values');
    const over = W.sttConfigFromEnv({ STT_CHUNK_GAP_MS: '10', GROQ_BASE_URL: 'http://x/', WHISPER_BIN: 'node', WHISPER_ARGS: '/a/b.js --x' });
    ok(over.chunkGapMs === 10 && over.groqBaseUrl === 'http://x' && over.whisperArgs.join(' ') === '/a/b.js --x', 'every tuning value is env-overridable');
    ok(W.isDefaultTitle('Screen recording') && W.isDefaultTitle(' untitled recording ') && W.isDefaultTitle('') && !W.isDefaultTitle('My demo'), 'DEFAULT_TITLES guard');
    const gate = W.createRateGate({ max: 2, windowMs: 300 });
    const t0 = Date.now(); await gate.acquire(); await gate.acquire(); await gate.acquire();
    ok(Date.now() - t0 >= 250 && gate.stats.waited >= 1 && gate.kind === 'memory', 'the in-memory rate gate admits `max` per window then waits');
    const ac = new AbortController(); ac.abort();
    let threw = null; try { await W.createRateGate({ max: 0, windowMs: 1000 }).acquire({ signal: ac.signal }); } catch (e) { threw = e; }
    ok(threw && threw.code === 'aborted', 'an aborted signal stops waiting on the gate');
  }

  if (!FFMPEG || !FFPROBE) {
    console.log('\n  SKIPPED B–D — no ffmpeg/ffprobe (install worker devDependencies or set FFMPEG_BIN/FFPROBE_BIN)');
    if (REQUIRED) { fail += 1; console.log('  FAIL: STT_TESTS_REQUIRED=1 but ffmpeg is unavailable'); }
  } else {
    const mock = createGroqMock();
    const mockUrl = await mock.listen();
    const reset = (cfg) => fetch(`${mockUrl}/__mock/reset`, { method: 'POST', body: JSON.stringify(cfg || {}) });
    const calls = async () => (await fetch(`${mockUrl}/__mock/calls`)).json();
    const base = { ffmpegBin: FFMPEG, ffprobeBin: FFPROBE, groqApiKey: 'test-key-not-real', groqBaseUrl: mockUrl, chunkGapMs: 15, maxRetryAfterMs: 1500, chunkRetries: 2, modelPath: noModel, whisperBin: process.execPath, whisperArgs: [FAKE_WHISPER] };
    const mk = (over = {}, extra = {}) => W.createTranscriber({ config: { ...base, ...over }, logger: silent, ...extra });

    // ── B. Pipeline ──────────────────────────────────────────────────────────
    console.log('\nB. Pipeline against the Groq mock + real ffmpeg');
    await reset({ languages: ['english', 'korean', 'english'] });
    let r = await mk({ dominantMinShare: 0.4 }).transcribeFile(SPEECH);
    let c = await calls();
    ok(r.source === 'groq' && r.stats.chunks === 3 && c.stt.length === 4, 'three VAD chunks → three auto-detect calls + one forced re-transcription');
    ok(c.stt.slice(0, 3).every((x) => x.language === null && x.format === 'verbose_json' && /chunk_\d\.flac/.test(x.fileName)) && c.stt[3].language === 'en' && c.stt[3].fileName === 'rechunk.flac', 'pass 1 sends no language; pass 2 forces the dominant ISO code on the minority chunk');
    ok(r.language === 'english' && r.stats.forced === 1 && r.segments.every((s) => s.language === 'english'), 'the minority language (korean, 31 % < 40 % share) is suppressed');
    ok(r.segments.length === 3 && r.segments[1].start > 4.5 && r.segments[1].start < 5.5 && r.segments[2].start > 9 && r.segments.every((s) => !/garbage/.test(s.text)), 'segments carry absolute offsets, sorted, hallucinations dropped');
    ok(/forced english/.test(r.text) && /hello from english chunk 0/.test(r.text) && !/korean/.test(r.text), 'the merged text uses the forced result for the re-transcribed chunk');

    await reset({ languages: ['english', 'korean', 'english'] });
    r = await mk({ dominantMinShare: 0.15 }).transcribeFile(SPEECH);
    ok(r.stats.forced === 0 && (await calls()).stt.length === 3 && r.segments.some((s) => s.language === 'korean'), 'a language above the share threshold is kept (mixed-language transcript)');

    await reset({ stt: { plan: [{ status: 429, retryAfter: 1 }] } });
    const t429 = Date.now();
    r = await mk().transcribeFile(SPEECH);
    ok(r.stats.groq429 === 1 && r.stats.chunkSkips === 0 && Date.now() - t429 >= 900 && (await calls()).stt.length === 4, 'a 429 honours Retry-After (1 s) and the chunk is retried, not skipped');

    await reset({ stt: { plan: Array.from({ length: 6 }, () => ({ status: 429 })) } });
    r = await mk({ chunkRetries: 2 }).transcribeFile(SPEECH);
    ok(r.stats.chunkSkips === 1 && r.segments.length === 2 && r.stats.groq429 === 6, 'a chunk that stays rate-limited past the retry budget is skipped and the rest survive');

    await reset({});
    r = await mk().transcribeFile(CONTINUOUS);
    c = await calls();
    ok(r.wholeFile === true && c.stt.length === 1 && c.stt[0].fileName === 'audio.mp3' && r.segments.length === 1, 'continuous speech (no pauses) → one whole-file mp3 call');

    await reset({ stt: { plan: Array.from({ length: 12 }, () => ({ status: 500 })) } });
    r = await mk({ modelPath: modelFile }).transcribeFile(SPEECH);
    ok(r.source === 'whisper_cpp' && r.stats.fallback === 'groq_error' && r.segments.length === 2 && /whisper cpp segment one/.test(r.text), 'persistent Groq 5xx → whisper.cpp fallback within the same attempt');
    await reset({ stt: { plan: Array.from({ length: 12 }, () => ({ status: 500 })) } });
    let threw = null; try { await mk().transcribeFile(SPEECH); } catch (e) { threw = e; }
    ok(threw && threw.retryable === true && threw.code === 'groq_error', 'without a whisper model the persistent failure is TRANSIENT (the job retries)');

    r = await mk({ groqApiKey: '', modelPath: modelFile }).transcribeFile(SPEECH, { language: 'ur' });
    ok(r.source === 'whisper_cpp' && r.language === 'ur' && r.stats.groqCalls === 0, 'no key + model → whisper.cpp directly, honouring the language override');
    process.env.FAKE_WHISPER_FAIL = '1';
    threw = null; try { await mk({ groqApiKey: '', modelPath: modelFile }).transcribeFile(SPEECH); } catch (e) { threw = e; } finally { delete process.env.FAKE_WHISPER_FAIL; }
    ok(threw && threw.code === 'whisper_failed' && threw.retryable === true, 'a failing whisper-cli is a transient failure');
    threw = null; try { await mk({ groqApiKey: '' }).transcribeFile(SPEECH); } catch (e) { threw = e; }
    ok(threw && threw.code === 'transcription_unconfigured' && threw.retryable === false, 'no key and no model → terminal unconfigured');
    threw = null; try { await mk().transcribeFile(CORRUPT); } catch (e) { threw = e; }
    ok(threw && threw.code === 'audio_decode_failed' && threw.retryable === false && /stderr tail/.test(W.formatError(threw)), 'undecodable media → terminal audio_decode_failed with the ffmpeg stderr tail');
    threw = null; try { await mk({ ffmpegBin: path.join(tmp, 'no-ffmpeg.exe') }).transcribeFile(SPEECH); } catch (e) { threw = e; }
    ok(threw && threw.code === 'ffmpeg_missing' && threw.retryable === true, 'a missing ffmpeg binary is transient (deployment problem, not the media)');

    await reset({ delayMs: 400 });
    const ac = new AbortController();
    const p = mk().transcribeFile(SPEECH, { signal: ac.signal }).then(() => null, (e) => e);
    setTimeout(() => ac.abort(), 150);
    const aborted = await p;
    ok(aborted && aborted.code === 'aborted', 'an abort signal stops the pipeline');
    await reset({});
    const shared = W.createRateGate({ max: 2, windowMs: 400 });
    const tg = Date.now();
    r = await mk({ chunkGapMs: 0 }, { rateGate: shared }).transcribeFile(SPEECH);
    ok(shared.stats.admitted === 3 && shared.stats.waited >= 1 && Date.now() - tg >= 300, 'every Groq call passes the shared rate gate');

    // ── C. LLM helper ────────────────────────────────────────────────────────
    console.log('\nC. LLM helper against the mock');
    await reset({});
    const ai = W.createAi({ config: { apiKey: 'test-key-not-real', baseUrl: mockUrl }, logger: silent });
    const longText = 'This is the first sentence of the demo which explains everything. Then the second sentence goes deeper into the topic at hand. Finally the third sentence wraps up the whole recording nicely.';
    ok((await ai.summarize(longText)) === 'A mock summary of the recording. It covers the demo end to end.', 'summary via the LLM');
    const title = await ai.generateTitle(longText, null);
    c = await calls();
    ok(title === 'Mock Generated Title' && c.chat.length === 3 && /summarize/i.test(c.chat[1].system) && /title/i.test(c.chat[2].system) && /mock summary/.test(c.chat[2].user), 'the title is generated from the SUMMARY, not the raw transcript');
    const ch = await ai.generateChapters([{ start: 0, end: 30, text: 'a b c' }, { start: 30, end: 70, text: 'd e f' }, { start: 70, end: 130, text: 'g h i' }]);
    ok(ch.length === 3 && ch[0].t === 0 && ch[2].t === 120, 'chapters parsed from the LLM JSON');
    await reset({ chat: { plan: [{ content: '[{"t":30,"title":"Late"}]' }] } });
    const ch2 = await ai.generateChapters([{ start: 0, end: 30, text: 'a b c' }, { start: 30, end: 70, text: 'd e f' }, { start: 70, end: 130, text: 'g h i' }]);
    ok(ch2[0].t === 0 && ch2[0].title === 'Intro', 'a first chapter after t=0 gets the Intro guarantee');
    ok((await ai.generateChapters([{ start: 0, end: 10, text: 'short' }, { start: 10, end: 20, text: 'x' }, { start: 20, end: 30, text: 'y' }])).length === 0, 'under 60 s → no chapters');
    const tr = await ai.translateSegments([{ start: 0, end: 1, text: 'hello' }, { start: 1, end: 2, text: 'world' }], 'es');
    ok(tr.length === 2 && tr[0].text === '[tr] hello' && tr[1].text === '[tr] world' && tr[1].start === 1, 'translation keeps the numbered-line protocol and timings');
    await reset({ chat: { plan: [{ status: 500 }] } });
    ok((await ai.summarize(longText)) === ai.extractiveSummary(longText), 'an LLM failure falls back to the extractive summary');
    const noKey = W.createAi({ config: { apiKey: '' }, logger: silent });
    threw = null; try { await noKey.translateSegments([{ start: 0, end: 1, text: 'x' }], 'es'); } catch (e) { threw = e; }
    ok(threw && threw.code === 'no_llm' && (await noKey.generateTitle(longText)) === null, 'no key → translate refuses (no_llm) and the LLM title yields null (heuristic takes over in the job)');

    // ── D. Processors end-to-end ─────────────────────────────────────────────
    let env = null, pgUp = false, redisUp = false, storageUp = false, pool = null;
    try { env = loadEnv({ appEnv: 'test' }); } catch (e) { console.log('  env:', e.message); }
    if (env) { pool = createPool({ env, max: 8 }); try { await pool.query('select 1'); pgUp = true; } catch {} }
    try { const cc = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 1500, lazyConnect: true }); await cc.connect(); redisUp = (await cc.ping()) === 'PONG'; await cc.quit(); } catch {}
    try { storageUp = (await fetch(`${MINIO}/minio/health/live`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
    if (!pgUp || !redisUp || !storageUp) {
      console.log(`\n  SKIPPED D — ${[!pgUp && 'PostgreSQL unreachable', !redisUp && `no Redis at ${REDIS_URL}`, !storageUp && `no object storage at ${MINIO}`].filter(Boolean).join(', ')}`);
      if (REQUIRED) { fail += 1; console.log('  FAIL: STT_TESTS_REQUIRED=1 but infrastructure is unavailable'); }
    } else {
      console.log('\nD. Processors on real PostgreSQL + MinIO + Redis');
      const db = createClient(pool);
      const repositories = () => createRepositories(db);
      const repos = repositories();
      const withTransaction = (fn) => rawTx(fn, db);
      const storage = require(path.join(ROOT, 'storage', 'src', 'index.js')).createStorageProvider({ appEnv: 'test' });
      const U = `usr_t603_${RUN}`;
      const rid = (k) => `rec_t603_${k}_${RUN}`;
      await db.execute(sql`INSERT INTO users (id,email,name,password_hash) VALUES (${U}, ${`t603-${RUN}@example.com`}, 'T603', 'x')`);
      const mkRec = async (k, { title = 'Screen recording', withSource = true, status = 'uploaded' } = {}) => {
        await db.execute(sql`INSERT INTO recordings (id,user_id,title,status,source_kind,privacy,duration) VALUES (${rid(k)}, ${U}, ${title}, ${status}, 'extension', 'unlisted', 12)`);
        if (withSource) {
          const key = `sources/${rid(k)}/source.webm`;
          await storage.putObject(key, fs.readFileSync(SPEECH), { contentType: 'video/webm' });
          await db.execute(sql`INSERT INTO video_assets (id,recording_id,kind,storage_key,status,size_bytes,counts_toward_quota) VALUES (${`ast_${k}_${RUN}`}, ${rid(k)}, 'source', ${key}, 'ready', ${fs.statSync(SPEECH).size}, true)`);
        }
        return rid(k);
      };
      const rowOf = async (id) => repos.jobs.findByDedupeKey(id);
      const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };
      const transcript = async (id) => repos.transcripts.getForPublicWatch(id);
      const recording = async (id) => repos.recordings.getSystem(id, REASON);
      const prefix = `t603${RUN}`;
      const mkQueue = () => W.createBullJobQueue({ redisUrl: REDIS_URL, prefix, logger: silent, stalledIntervalMs: 500, lockDurationMs: 1000, backoff: () => 50 });
      const config = W.loadWorkerConfig({ REDIS_URL, QUEUE_PREFIX: prefix, OUTBOX_INTERVAL_MS: '100', RECONCILE_INTERVAL_MS: '600000', WORKER_SCHEDULER: 'false', WORKER_DEFER_MS: '100' }, { appEnv: 'test' });
      const transcriber = mk({ chunkGapMs: 5 });
      const deps = { withTransaction, storage, transcriber, ai, resolveLimits: async () => ({}) };
      const enqueue = (type, key, recordingId, payload) => repos.jobs.enqueue({ queue: type, dedupeKey: key, recordingId, payload, maxAttempts: 3 }).then((r) => r.job);
      const q = mkQueue();
      try {
        await reset({ languages: ['english', 'english', 'english'] });
        const app = W.createWorkerApp({ config, logger: silent, repositories, jobQueue: q, registry: W.createDefaultRegistry({ maintenance: false, media: false, editing: false }), deps });
        await app.start();
        ok(app.status().queues.sort().join() === 'ai,stt', 'the stt/ai processors subscribe to their own queues (isolated from media)');

        // Happy path + chain.
        const A = await mkRec('a');
        await enqueue('transcribe', `stt:${A}`, A, { recordingId: A, language: '', trigger: 'auto', aiDocs: true });
        ok(await until(async () => (await transcript(A) || {}).status === 'done'), 'stt.transcribe completes: transcript done');
        const tA = await transcript(A);
        const segs = await repos.transcripts.listSegments(tA.id);
        ok(tA.source === 'groq' && tA.language === 'english' && segs.length === 3 && segs[0].idx === 0 && Number(segs[1].startS) > 4 && tA.text.length > 10 && tA.error === null, 'segments persisted relationally with absolute offsets; source and language recorded');
        ok(await until(async () => { const r0 = await recording(A); return r0.aiStatus === 'done'; }), 'the ai chain finishes (ai_status done)');
        const rA = await recording(A);
        const jobsA = await repos.jobs.listByRecordingSystem(A, REASON);
        ok(rA.title === 'Mock Generated Title' && rA.description === 'A mock summary of the recording. It covers the demo end to end.' && ['ai_title', 'ai_summary', 'ai_chapters'].every((t) => jobsA.some((j) => j.queue === t && j.status === 'completed')), 'chain: title (LLM via summary) + summary written; chapters job completed (too short for chapters)');
        ok((jobsA.find((j) => j.queue === 'transcribe')).result.segments === 3 && (jobsA.find((j) => j.queue === 'transcribe')).result.source === 'groq', 'the transcribe job result carries counts and the source');
        ok(rA.status === 'uploaded', 'recordings.status is never touched by transcription (invariant #14)');

        // DEFAULT_TITLES guard.
        const B = await mkRec('b', { title: 'My own title' });
        await enqueue('transcribe', `stt:${B}`, B, { recordingId: B, trigger: 'auto', aiDocs: false });
        ok(await until(async () => { const r0 = await recording(B); return r0.aiStatus === 'done'; }), 'auto chain without AI docs finishes');
        const jobsB = await repos.jobs.listByRecordingSystem(B, REASON);
        ok((await recording(B)).title === 'My own title' && jobsB.find((j) => j.queue === 'ai_title').result.skipped === 'user_set_title' && !jobsB.some((j) => j.queue === 'ai_summary'), 'a user-set title is never overwritten on auto; no summary/chapters without AI docs');
        await repos.jobs.requeueSystem(jobsB.find((j) => j.queue === 'ai_title').id, REASON, { resetAttempts: true, fromStatuses: ['completed'] });
        await db.execute(sql`update processing_jobs set payload = ${JSON.stringify({ recordingId: B, trigger: 'manual' })}::jsonb where dedupe_key = ${`ai_title:${B}`}`);
        ok(await until(async () => (await recording(B)).title === 'Mock Generated Title'), 'a MANUAL title trigger overwrites');

        // Idempotent re-run: same transcript row, segments replaced, single row.
        const beforeId = tA.id;
        await repos.jobs.requeueSystem((await rowOf(`stt:${A}`)).id, REASON, { resetAttempts: true, fromStatuses: ['completed'] });
        ok(await until(async () => (await rowOf(`stt:${A}`)).status === 'completed' && (await rowOf(`stt:${A}`)).attempts === 1), 're-run completes');
        const tA2 = await transcript(A);
        const count = (await db.execute(sql`select count(*)::int n from transcripts where recording_id = ${A}`)).rows[0].n;
        ok(tA2.id === beforeId && count === 1 && (await repos.transcripts.listSegments(tA2.id)).length === 3, 'idempotent: one transcript row per recording, segments replaced in place');
        ok(await until(async () => (await rowOf(`ai_title:${A}`)).status === 'completed' && (await rowOf(`ai_title:${A}`)).attempts === 1), 'the chain re-ran for the new transcript (settled chain rows requeued)');

        // Translation cache.
        await enqueue('translate', `translate:${A}:es`, A, { recordingId: A, lang: 'es' });
        ok(await until(async () => (await rowOf(`translate:${A}:es`)).status === 'completed'), 'translate job completes');
        const cached = await repos.transcripts.getTranslation(tA.id, 'es');
        ok(cached && cached.segments.length === 3 && /\[tr\]/.test(cached.segments[0].text) && (await rowOf(`translate:${A}:es`)).result.cached === false, 'the translation is cached on the transcript');
        await repos.jobs.requeueSystem((await rowOf(`translate:${A}:es`)).id, REASON, { resetAttempts: true, fromStatuses: ['completed'] });
        ok(await until(async () => (await rowOf(`translate:${A}:es`)).status === 'completed' && (await rowOf(`translate:${A}:es`)).attempts === 1) && (await rowOf(`translate:${A}:es`)).result.cached === true, 'a second run serves the cache — no LLM call');

        // no_speech is a valid outcome.
        await reset({ stt: { plan: Array.from({ length: 8 }, () => ({ status: 200, segments: [] })) } });
        const Cn = await mkRec('c');
        await enqueue('transcribe', `stt:${Cn}`, Cn, { recordingId: Cn, trigger: 'manual', aiDocs: true });
        ok(await until(async () => (await rowOf(`stt:${Cn}`)).status === 'completed') && (await transcript(Cn)).status === 'done', 'no speech → transcript done, job completed');
        ok((await repos.transcripts.listSegments((await transcript(Cn)).id)).length === 0 && (await rowOf(`stt:${Cn}`)).result.note === 'no_speech' && !(await rowOf(`ai_title:${Cn}`)), 'zero segments, note no_speech, and no AI chain is started');
        await reset({});

        // Terminal: no source.
        const D = await mkRec('d', { withSource: false });
        await enqueue('transcribe', `stt:${D}`, D, { recordingId: D, trigger: 'manual' });
        ok(await until(async () => (await rowOf(`stt:${D}`)).status === 'failed'), 'a recording without media fails terminally');
        ok((await transcript(D)).status === 'failed' && (await transcript(D)).error === 'no_source' && (await recording(D)).aiStatus === 'failed' && (await recording(D)).status === 'uploaded', 'transcript failed(no_source), ai_status failed, recordings.status untouched');

        // Transient → transcript visibly queued between attempts, then done.
        await reset({ stt: { plan: Array.from({ length: 6 }, () => ({ status: 500 })) } });
        const E = await mkRec('e');
        await enqueue('transcribe', `stt:${E}`, E, { recordingId: E, trigger: 'manual' });
        ok(await until(async () => (await rowOf(`stt:${E}`)).status === 'completed', 30000), 'after a transient Groq failure the retry (mock recovered) completes the job');
        ok((await rowOf(`stt:${E}`)).attempts === 2 && (await transcript(E)).status === 'done' && (await transcript(E)).error === null, 'attempts=2 (one transient failure, one success); the transcript is done with no error left behind');

        await app.stop();

        // Restart safety: a worker killed mid-transcription.
        console.log('\n   restart-safety: SIGKILL a worker holding the transcribe job');
        const F = await mkRec('f');
        const fj = await enqueue('transcribe', `stt:${F}`, F, { recordingId: F, trigger: 'manual' });
        // app.stop() closed `q`; the relay needs a live transport.
        const relayQ = mkQueue();
        const relay = W.createOutboxRelay({ repositories, jobQueue: relayQ, logger: silent });
        const relayed = await relay.relayOnce();
        // Other suites may leave unstamped rows behind; what matters is THIS row reaching the transport.
        ok(relayed.relayed >= 1 && !!(await rowOf(`stt:${F}`)).enqueuedAt, `the transcribe row was handed to the transport (relayed ${relayed.relayed})`);
        const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'hang-worker.js')], {
          env: { ...process.env, APP_ENV: 'test', DATABASE_URL_TEST: env.databaseUrl, REDIS_URL, QUEUE_PREFIX: prefix, HANG_TYPE: 'transcribe', WORKER_STALLED_INTERVAL_MS: '500', WORKER_LOCK_DURATION_MS: '1000', WORKER_SCHEDULER: 'false', LOG_LEVEL: 'silent' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { out += d.toString(); });
        ok(await until(async () => out.includes(`STARTED ${fj.id}`), 15000), 'the doomed worker took the transcribe job');
        child.kill('SIGKILL');
        await new Promise((r0) => child.once('exit', r0));
        const app2 = W.createWorkerApp({ config, logger: silent, repositories, jobQueue: mkQueue(), registry: W.createDefaultRegistry({ maintenance: false, media: false }), deps });
        await app2.start();
        ok(await until(async () => (await transcript(F) || {}).status === 'done', 25000), 'the surviving worker re-runs the job from scratch and the transcript lands');
        ok((await rowOf(`stt:${F}`)).attempts === 2 && (await repos.transcripts.listSegments((await transcript(F)).id)).length === 3, 'attempts=2, one transcript, full segment set');
        await app2.stop();
        await relayQ.close();
      } finally {
        const qq = mkQueue(); await qq.obliterate().catch(() => {}); await qq.close().catch(() => {});
        for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) await storage.deleteObject(`sources/${rid(k)}/source.webm`).catch(() => {});
        await db.execute(sql`delete from users where id = ${U}`);
        await pool.end().catch(() => {});
      }
    }
    await mock.close();
  }

  // ── E. Legacy wiring ───────────────────────────────────────────────────────
  console.log('\nE. Legacy server wiring');
  const idx = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  ok(/createAiRouter\(\{/.test(idx) && /autoProcess:\s*\{/.test(idx) && /configured: \(\) => transcription\.isConfigured\(\)/.test(idx), 'the legacy server mounts the async AI router and the upload auto-chain behind V1_UPLOAD_API');
  ok(fs.existsSync(path.join(ROOT, 'server', 'transcription.js')) && /app\.post\('\/api\/recordings\/:id\/transcribe'/.test(idx), 'the LEGACY synchronous transcribe route is untouched (legacy recordings, until the Phase 8 read cutover)');
  const wsrc = fs.readFileSync(path.join(ROOT, 'worker', 'src', 'stt', 'transcription.js'), 'utf8');
  ok(!/api\.groq\.com[^'"]*\/audio/.test(wsrc.replace(/groqBaseUrl:[^\n]*/g, '')) && /GROQ_BASE_URL/.test(wsrc), 'the worker pipeline has no hardcoded provider URL (injectable base URL)');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
