// Speech-to-text pipeline (docs/15 §2–§3, §8) — relocated from
// server/transcription.js (T-603) with the same VAD/multi-language algorithm:
//
//   ffmpeg → 16 kHz mono WAV → silencedetect → speech chunks (pad 0.15 s, merge
//   < 3 s, cap 40 s, ≤ 40 chunks) → pass 1: per-chunk INDEPENDENT language
//   auto-detect on Groq whisper-large-v3 (that is the mixed-language fix — one
//   up-front detect locked the whole file) → pass 2: languages under 15 % of the
//   audio re-transcribed FORCED to the dominant one → merge with absolute
//   offsets, dropping Whisper's hallucination signature → whole-file fallback
//   when there are no usable pauses.
//
// What changed for the worker:
//   • every binary, URL, key and tuning value is injected (env by default) — no
//     module-level globals, so tests run against a Groq mock and a fake
//     whisper-cli, and a process can host several configurations;
//   • Groq 429 honours Retry-After (bounded) instead of failing the chunk;
//   • a persistent Groq failure falls back to whisper.cpp WITHIN the attempt
//     when a model is present (docs/15 §8), otherwise the error is transient
//     and the job retries;
//   • every Groq call passes the shared rate gate (docs/10 §3 limiter);
//   • an AbortSignal stops the pipeline between steps and kills ffmpeg.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { TransientError, TerminalError } = require('../errors');
const { silentLogger } = require('../logger');

const CHUNK_PAD_SEC = 0.15;   // pad into surrounding silence so boundary words aren't clipped

// Whisper returns the language as a lowercase NAME; map → ISO code so we can FORCE
// the dominant language on a mis-detected chunk (pass 2).
const WHISPER_NAME_TO_CODE = {
  english: 'en', urdu: 'ur', hindi: 'hi', arabic: 'ar', persian: 'fa', farsi: 'fa',
  chinese: 'zh', mandarin: 'zh', cantonese: 'yue', spanish: 'es', castilian: 'es',
  french: 'fr', german: 'de', japanese: 'ja', korean: 'ko', portuguese: 'pt',
  russian: 'ru', italian: 'it', turkish: 'tr', dutch: 'nl', flemish: 'nl', polish: 'pl',
  indonesian: 'id', malay: 'ms', ukrainian: 'uk', hebrew: 'he', greek: 'el',
  czech: 'cs', romanian: 'ro', moldovan: 'ro', danish: 'da', hungarian: 'hu',
  tamil: 'ta', norwegian: 'no', nynorsk: 'nn', thai: 'th', vietnamese: 'vi',
  bengali: 'bn', telugu: 'te', marathi: 'mr', gujarati: 'gu', kannada: 'kn',
  malayalam: 'ml', punjabi: 'pa', panjabi: 'pa', swahili: 'sw', pashto: 'ps', pushto: 'ps',
  nepali: 'ne', sinhala: 'si', sinhalese: 'si', swedish: 'sv', finnish: 'fi',
  catalan: 'ca', valencian: 'ca', serbian: 'sr', croatian: 'hr', bulgarian: 'bg',
  slovak: 'sk', hausa: 'ha', amharic: 'am', somali: 'so', azerbaijani: 'az',
  kazakh: 'kk', uzbek: 'uz', sindhi: 'sd', tagalog: 'tl',
};

/** Configuration from the environment (every value overridable per instance). */
function configFromEnv(env = process.env) {
  const modelPath = env.WHISPER_MODEL_PATH || path.join(__dirname, '..', '..', '..', 'server', 'models', 'ggml-base.bin');
  return {
    ffmpegBin: env.FFMPEG_BIN || 'ffmpeg',
    ffprobeBin: env.FFPROBE_BIN || 'ffprobe',
    whisperBin: env.WHISPER_BIN || 'whisper-cli',
    // Leading arguments for the whisper binary (e.g. WHISPER_BIN=node
    // WHISPER_ARGS=/path/shim.js) — how the tests substitute a fake whisper-cli.
    whisperArgs: env.WHISPER_ARGS ? String(env.WHISPER_ARGS).split(/\s+/).filter(Boolean) : [],
    modelPath,
    whisperThreads: env.WHISPER_THREADS || '',
    whisperLanguage: env.WHISPER_LANGUAGE || (/\.en\.bin$/.test(modelPath) ? '' : 'auto'),
    groqApiKey: env.GROQ_API_KEY || '',
    groqSttModel: env.GROQ_STT_MODEL || 'whisper-large-v3',   // NOT turbo — accuracy wins for Urdu
    groqBaseUrl: (env.GROQ_BASE_URL || 'https://api.groq.com').replace(/\/+$/, ''),
    vadNoise: env.STT_VAD_NOISE || '-30dB',
    vadMinSil: Number(env.STT_VAD_MIN_SIL || 0.5),
    chunkMaxSec: Number(env.STT_CHUNK_MAX || 40),
    chunkMinSec: Number(env.STT_CHUNK_MIN || 3),
    dominantMinShare: Number(env.STT_DOMINANT_SHARE || 0.15),
    maxChunks: Number(env.STT_MAX_CHUNKS || 40),
    chunkGapMs: Number(env.STT_CHUNK_GAP_MS || 3100),          // ≥ 3 s spacing → under Groq's 20 RPM
    maxRetryAfterMs: Number(env.STT_MAX_RETRY_AFTER_MS || 60000),
    chunkRetries: Number(env.STT_CHUNK_RETRIES || 2),
  };
}

// verbose_json → {text, language, segments:[{start,end,text}]} (Groq is already in SECONDS).
function mapGroqJson(j, offsetSec = 0) {
  const segments = (j.segments || [])
    // Whisper's own silence/low-confidence signature — drops garbage repeated lines.
    .filter((s) => !((s.no_speech_prob > 0.6) && (s.avg_logprob < -1)))
    .map((s) => ({
      start: Math.round(((s.start || 0) + offsetSec) * 100) / 100,
      end: Math.round(((s.end || 0) + offsetSec) * 100) / 100,
      text: String(s.text || '').trim(),
    }))
    .filter((s) => s.text);
  return { text: segments.map((s) => s.text).join(' ').trim(), language: j.language || 'auto', segments };
}

// Invert silences → speech chunks; pad into silence; merge slivers; cap length.
function buildSpeechChunks(silences, duration, { chunkMinSec = 3, chunkMaxSec = 40, padSec = CHUNK_PAD_SEC } = {}) {
  if (!duration || duration <= 0) return [];
  let chunks = [], cursor = 0;
  for (const s of silences) {
    if (s.start > cursor) chunks.push({ start: cursor, end: Math.min(s.start, duration) });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < duration) chunks.push({ start: cursor, end: duration });
  chunks = chunks.map((c) => ({ start: Math.max(0, c.start - padSec), end: Math.min(duration, c.end + padSec) }));
  const merged = [];
  for (const c of chunks) {
    const prev = merged[merged.length - 1];
    if (prev && (c.end - c.start < chunkMinSec)) prev.end = c.end;   // fold a sliver into the previous chunk
    else merged.push({ ...c });
  }
  const capped = [];
  for (const c of merged) {
    let s = c.start;
    while (c.end - s > chunkMaxSec) { capped.push({ start: s, end: s + chunkMaxSec }); s += chunkMaxSec; }
    if (c.end - s > 0.05) capped.push({ start: s, end: c.end });
  }
  return capped;
}

/** Pairwise-merge until ≤ maxChunks Groq calls (rate-limit safety). */
function capChunkCount(chunks, maxChunks) {
  let out = chunks;
  while (out.length > maxChunks) {
    const merged = [];
    for (let i = 0; i < out.length; i += 2) { const a = out[i], b = out[i + 1]; merged.push(b ? { start: a.start, end: b.end } : a); }
    out = merged;
  }
  return out;
}

/** silencedetect stderr → [{start,end}] */
function parseSilences(stderr) {
  const sils = [];
  const re = /silence_start:\s*([\d.]+)|silence_end:\s*([\d.]+)/g;
  let m, cur = null;
  while ((m = re.exec(String(stderr || '')))) {
    if (m[1] !== undefined) cur = { start: parseFloat(m[1]), end: null };
    else if (m[2] !== undefined && cur) { cur.end = parseFloat(m[2]); sils.push(cur); cur = null; }
  }
  return sils;
}

/**
 * @param {object} [o]
 * @param {object} [o.config]        overrides of configFromEnv()
 * @param {object} [o.rateGate]      { acquire({signal}) } shared Groq budget
 * @param {Function} [o.fetchImpl]
 * @param {object} [o.logger]
 * @param {(ms:number)=>Promise} [o.sleep]
 */
function createTranscriber({ config = {}, rateGate = null, fetchImpl = globalThis.fetch, logger = silentLogger(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const cfg = { ...configFromEnv(), ...config };
  const sttUrl = `${cfg.groqBaseUrl}/openai/v1/audio/transcriptions`;

  function hasWhisperModel() { try { return fs.existsSync(cfg.modelPath); } catch { return false; } }
  function isConfigured() { return !!cfg.groqApiKey || hasWhisperModel(); }

  // Child processes: killed on abort; a timeout SIGKILLs too.
  function sh(cmd, args, { timeout, signal } = {}) {
    return new Promise((resolve, reject) => {
      let p;
      try { p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return reject(e); }
      let out = '', err = '', done = false;
      const finish = (fn, v) => { if (done) return; done = true; if (timer) clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); fn(v); };
      const onAbort = () => { try { p.kill('SIGKILL'); } catch { /* gone */ } finish(reject, Object.assign(new Error(`${path.basename(cmd)} aborted`), { code: 'aborted' })); };
      const timer = timeout ? setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } finish(reject, new Error(`${path.basename(cmd)} timed out`)); }, timeout) : null;
      if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', (e) => finish(reject, e));
      p.on('close', (code) => {
        if (code === 0) finish(resolve, { out, err });
        else finish(reject, Object.assign(new Error(`${path.basename(cmd)} exited ${code}: ${err.slice(-400)}`), { code: 'tool_failed', stderrTail: err.slice(-2048) }));
      });
    });
  }

  const checkAbort = (signal) => { if (signal && signal.aborted) throw Object.assign(new Error('transcription aborted'), { code: 'aborted' }); };

  async function probeDuration(filePath, signal) {
    try {
      const { out } = await sh(cfg.ffprobeBin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { timeout: 30_000, signal });
      const d = parseFloat(String(out).trim());
      return Number.isFinite(d) ? d : 0;
    } catch (e) { if (e && e.code === 'aborted') throw e; return 0; }
  }

  async function detectSilences(filePath, signal) {
    let err = '';
    try {
      const res = await sh(cfg.ffmpegBin, ['-hide_banner', '-nostats', '-nostdin', '-i', filePath, '-af', `silencedetect=noise=${cfg.vadNoise}:d=${cfg.vadMinSil}`, '-f', 'null', '-'], { timeout: 180_000, signal });
      err = res.err;
    } catch (e) { if (e && e.code === 'aborted') throw e; err = String((e && e.message) || ''); }   // defensive — parse whatever we captured
    return parseSilences(err);
  }

  async function toWav(inPath, wavPath, signal) {
    try {
      await sh(cfg.ffmpegBin, ['-nostdin', '-y', '-i', inPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath], { timeout: 120_000, signal });
    } catch (e) {
      if (e && e.code === 'aborted') throw e;
      if (e && e.code === 'ENOENT') throw new TransientError('ffmpeg_missing', `ffmpeg not found at ${cfg.ffmpegBin}`);
      // A file ffmpeg cannot decode will not decode next time either.
      throw new TerminalError('audio_decode_failed', e.message, { stderrTail: e.stderrTail });
    }
  }

  // ── Groq (with Retry-After, rate gate, bounded retries) ───────────────────
  const stats = () => ({ groqCalls: 0, groq429: 0, groqErrors: 0, chunkSkips: 0, chunks: 0, fallback: null });

  async function groqTranscribeFile(filePath, fileName, language, st, signal) {
    const buf = fs.readFileSync(filePath);
    for (let attempt = 0; ; attempt += 1) {
      checkAbort(signal);
      if (rateGate) await rateGate.acquire({ signal });
      const form = new FormData();
      form.append('file', new Blob([buf]), fileName);      // filename drives Groq's format sniffing
      form.append('model', cfg.groqSttModel);
      form.append('response_format', 'verbose_json');      // REQUIRED for timestamped segments
      form.append('temperature', '0');                     // deterministic → avoids repeated-line hallucination
      form.append('timestamp_granularities[]', 'segment');
      if (language) form.append('language', language);     // pass 2 only: force the dominant language
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 180_000);
      const onAbort = () => ac.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      let r;
      st.groqCalls += 1;
      try {
        r = await fetchImpl(sttUrl, { method: 'POST', headers: { Authorization: `Bearer ${cfg.groqApiKey}` }, body: form, signal: ac.signal });
      } catch (e) {
        st.groqErrors += 1;
        if (signal && signal.aborted) throw Object.assign(new Error('transcription aborted'), { code: 'aborted' });
        throw new TransientError('groq_network', `Groq STT request failed: ${e.message}`);
      } finally { clearTimeout(to); if (signal) signal.removeEventListener('abort', onAbort); }
      if (r.status === 429) {
        st.groq429 += 1;
        const ra = Number(r.headers.get('retry-after'));
        const waitMs = Math.min(cfg.maxRetryAfterMs, Number.isFinite(ra) && ra > 0 ? ra * 1000 : cfg.chunkGapMs * 2);
        if (attempt >= cfg.chunkRetries) throw new TransientError('rate_limited', 'Transcription is busy right now — please try again shortly.');
        logger.warn({ attempt, wait_ms: waitMs }, 'Groq 429 — honouring Retry-After');
        await sleep(waitMs);
        continue;
      }
      if (!r.ok) {
        st.groqErrors += 1;
        const body = (await r.text().catch(() => '')).slice(-300);
        throw new TransientError('groq_error', `Groq STT ${r.status}: ${body}`);
      }
      return r.json();
    }
  }

  async function transcribeViaGroq(inPath, tmp, st, signal) {
    const wavPath = path.join(tmp, 'audio.wav');
    await toWav(inPath, wavPath, signal);
    const duration = await probeDuration(wavPath, signal);
    const silences = await detectSilences(wavPath, signal);
    let chunks = buildSpeechChunks(silences, duration, { chunkMinSec: cfg.chunkMinSec, chunkMaxSec: cfg.chunkMaxSec });

    // FALLBACK: no usable pauses → single whole-file auto-detect call.
    if (!chunks.length || (chunks.length === 1 && (!duration || chunks[0].end - chunks[0].start >= duration - 0.5))) {
      const mp3Path = path.join(tmp, 'whole.mp3');
      await sh(cfg.ffmpegBin, ['-nostdin', '-y', '-i', wavPath, '-c:a', 'libmp3lame', '-b:a', '64k', mp3Path], { timeout: 120_000, signal });
      st.chunks = 1;
      return { ...mapGroqJson(await groqTranscribeFile(mp3Path, 'audio.mp3', null, st, signal)), wholeFile: true };
    }
    chunks = capChunkCount(chunks, cfg.maxChunks);
    st.chunks = chunks.length;

    // ── Pass 1: independent auto-detect per chunk ──────────────────────────
    const results = [], langDur = {};
    for (let i = 0; i < chunks.length; i += 1) {
      checkAbort(signal);
      const c = chunks[i];
      const flac = path.join(tmp, `chunk_${String(i).padStart(3, '0')}.flac`);
      await sh(cfg.ffmpegBin, ['-nostdin', '-y', '-ss', String(c.start), '-to', String(c.end), '-i', wavPath, '-ac', '1', '-ar', '16000', '-c:a', 'flac', flac], { timeout: 60_000, signal });
      let j;
      try { j = await groqTranscribeFile(flac, `chunk_${i}.flac`, null, st, signal); }
      catch (e) {
        if (e && e.code === 'aborted') throw e;
        // The per-chunk skip of the legacy pipeline: one more try after a gap, then keep the rest.
        await sleep(cfg.chunkGapMs * 2);
        try { j = await groqTranscribeFile(flac, `chunk_${i}.flac`, null, st, signal); }
        catch (e2) { if (e2 && e2.code === 'aborted') throw e2; st.chunkSkips += 1; logger.warn({ chunk: i, err: { message: e2.message } }, 'chunk skipped'); continue; }
      }
      const lang = String(j.language || 'auto').toLowerCase();
      langDur[lang] = (langDur[lang] || 0) + (c.end - c.start);
      results.push({ chunk: c, flac, lang, segments: mapGroqJson(j, c.start).segments });
      if (i < chunks.length - 1) await sleep(cfg.chunkGapMs);      // pace under 20 RPM
    }
    if (!results.length && chunks.length) throw new TransientError('groq_error', 'every chunk failed');

    // ── Pass 2: suppress spurious languages ────────────────────────────────
    const totalDur = Object.values(langDur).reduce((a, b) => a + b, 0) || 1;
    const dominant = Object.keys(langDur).sort((a, b) => langDur[b] - langDur[a])[0] || 'auto';
    const legit = new Set(Object.keys(langDur).filter((l) => langDur[l] >= cfg.dominantMinShare * totalDur));
    legit.add(dominant);
    const domCode = WHISPER_NAME_TO_CODE[dominant];
    let forced = 0;
    if (domCode) {
      for (const r of results) {
        if (legit.has(r.lang)) continue;
        checkAbort(signal);
        try {
          const j = await groqTranscribeFile(r.flac, 'rechunk.flac', domCode, st, signal);   // force the dominant language
          r.segments = mapGroqJson(j, r.chunk.start).segments;
          r.lang = dominant;
          forced += 1;
          await sleep(cfg.chunkGapMs);
        } catch (e) { if (e && e.code === 'aborted') throw e; /* keep the pass-1 result on failure */ }
      }
    }

    // ── Merge (absolute offsets already applied per chunk) ─────────────────
    const allSegs = [];
    for (const r of results) for (const s of r.segments) allSegs.push({ ...s, language: r.lang });
    allSegs.sort((a, b) => a.start - b.start);
    st.forced = forced;
    return { text: allSegs.map((s) => s.text).join(' ').trim(), language: dominant, segments: allSegs, wholeFile: false };
  }

  // ── whisper.cpp path (no key, or Groq fell over) ──────────────────────────
  async function transcribeViaWhisperCli(inPath, tmp, language, signal) {
    const wavPath = path.join(tmp, 'audio.wav');
    const outPrefix = path.join(tmp, 'out');
    await toWav(inPath, wavPath, signal);
    const args = [...cfg.whisperArgs, '-m', cfg.modelPath, '-f', wavPath, '-oj', '-of', outPrefix, '-np'];
    if (cfg.whisperThreads) args.push('-t', String(cfg.whisperThreads));
    const forceLang = (language && language !== 'auto') ? language : cfg.whisperLanguage;
    if (forceLang) args.push('-l', forceLang);
    try { await sh(cfg.whisperBin, args, { timeout: 1000 * 60 * 30, signal }); }
    catch (e) {
      if (e && e.code === 'aborted') throw e;
      throw new TransientError('whisper_failed', e.message, { stderrTail: e.stderrTail });
    }
    const j = JSON.parse(fs.readFileSync(`${outPrefix}.json`, 'utf8'));
    const segments = (j.transcription || [])
      .map((s) => ({
        start: Math.round(((s.offsets?.from ?? 0) / 1000) * 100) / 100,   // whisper.cpp gives ms → s
        end: Math.round(((s.offsets?.to ?? 0) / 1000) * 100) / 100,
        text: String(s.text || '').trim(),
      }))
      .filter((s) => s.text);
    return {
      text: segments.map((s) => s.text).join(' ').trim(),
      language: j.result?.language || j.params?.language || (cfg.modelPath.includes('.en') ? 'en' : 'auto'),
      segments,
    };
  }

  /**
   * Transcribe a local media file.
   * @returns {{text, language, segments:[{start,end,text,language?}], source:'groq'|'whisper_cpp', stats}}
   */
  async function transcribeFile(inPath, { language = '', signal = null } = {}) {
    if (!isConfigured()) throw new TerminalError('transcription_unconfigured', 'Transcription is not available: no GROQ_API_KEY and no whisper model');
    const st = stats();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'veorec-stt-'));
    try {
      // Groq's multi-language VAD pipeline ignores `language` on purpose (one
      // behaviour = native mixed "Original"); whisper.cpp honours it.
      if (cfg.groqApiKey) {
        try {
          const r = await transcribeViaGroq(inPath, tmp, st, signal);
          return { ...r, source: 'groq', stats: st };
        } catch (e) {
          if (e && (e.code === 'aborted' || e.retryable === false)) throw e;
          if (!hasWhisperModel()) throw e;
          // docs/15 §8: persistent Groq failure → whisper.cpp within the same attempt.
          logger.warn({ err: { message: e.message }, code: e.code }, 'Groq path failed — falling back to whisper.cpp');
          st.fallback = e.code || 'groq_error';
          const r = await transcribeViaWhisperCli(inPath, tmp, language, signal);
          return { ...r, source: 'whisper_cpp', stats: st };
        }
      }
      const r = await transcribeViaWhisperCli(inPath, tmp, language, signal);
      return { ...r, source: 'whisper_cpp', stats: st };
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* scratch */ }
    }
  }

  return { isConfigured, hasWhisperModel, transcribeFile, config: cfg, sttUrl };
}

// ── Heuristic title (100 % free, no LLM) — ported verbatim ───────────────────
const STOP = new Set((
  'a an the and or but if then so to of in on at for with as by is are am was were be been being this that these those it its i you he she they we me my your our their him her them us ' +
  'do does did have has had will would can could should may might must not no yes ok okay um uh uhh ah er hmm well like just gonna wanna actually basically literally really very much many some any all one two ' +
  'get got go going goes make made making see seen say said saying know now here there what when where which who whom how why also into out up down over under from about than then once too even more most other another such only ' +
  'fill filled fills filling upload uploaded uploads search searched click clicked type typed add added adding put putting open opened use using used show showed shown showing look looked looking want wanted need needed try tried let lets ' +
  'thing things stuff kind sort lot bit way ways guys everyone today right alright hi hey hello welcome video tutorial recording screen ' +
  'going theres im were youre lets dont cant wont thats heres'
).split(/\s+/));
const OPENER_RE = /^(ok(ay)?|so|um|uh|hi|hey|hello|alright|right|welcome|today|now|guys|everyone|let'?s|i'?m going to|i'?m gonna|i will|i'?m|we'?re going to|we will|we'?re|in this (video|tutorial|recording)|first of all|first)\b[ ,]*/i;

function titleCase(s) {
  return s.replace(/\w[\w']*/g, (w) => /^(of|the|a|an|and|or|to|in|on|at|for|with|by|vs)$/i.test(w)
    ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function generateTitle(text) {
  let clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 8) return null;
  for (let n = 0; n < 4 && OPENER_RE.test(clean); n += 1) clean = clean.replace(OPENER_RE, '').trim();
  const tokens = (clean.toLowerCase().match(/[a-z][a-z']{2,}/g) || []).filter((w) => !STOP.has(w));
  if (!tokens.length) return null;
  const freq = {}, firstAt = {};
  tokens.forEach((w, idx) => { freq[w] = (freq[w] || 0) + 1; if (firstAt[w] === undefined) firstAt[w] = idx; });
  const ranked = [...new Set(tokens)].sort((a, b) => (freq[b] - freq[a]) || (a.length > 3) - (b.length > 3) || (firstAt[a] - firstAt[b]));
  const keywordTitle = ranked.slice(0, 4).sort((a, b) => firstAt[a] - firstAt[b]).join(' ');
  const firstSentence = (clean.split(/(?<=[.!?])\s/)[0] || clean);
  const fsTokens = firstSentence.split(' ').filter((w) => /[a-z']/i.test(w));
  let i = 0;
  while (i < fsTokens.length && STOP.has(fsTokens[i].toLowerCase().replace(/[^a-z']/g, ''))) i += 1;
  const fsTitle = fsTokens.slice(i, i + 9).join(' ').replace(/[\s.,!?;:'"-]+$/, '').trim();
  const fsSignificant = fsTitle.toLowerCase().split(' ').filter((w) => !STOP.has(w.replace(/[^a-z']/g, '')) && w.length > 2).length;
  let title = (fsSignificant >= 3 && fsTitle.length >= 14 && fsTokens.length - i <= 11) ? fsTitle : keywordTitle;
  title = titleCase(title).slice(0, 70).replace(/[\s,;:-]+$/, '').trim();
  return title || titleCase(keywordTitle) || null;
}

module.exports = { createTranscriber, configFromEnv, mapGroqJson, buildSpeechChunks, capChunkCount, parseSilences, generateTitle, WHISPER_NAME_TO_CODE, CHUNK_PAD_SEC };
