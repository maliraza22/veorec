// LLM helper (docs/15 §5–§6) — relocated from server/ai.js (T-603) with the
// same prompts and fallbacks: Groq chat completions (openai/gpt-oss-20b) for
// summary / chapters / title / translation, extractive fallbacks when no key.
// Injectable key/URL/model/fetch so tests run against a mock; every call goes
// through the shared rate gate when one is supplied.
'use strict';

const { silentLogger } = require('../logger');

function configFromEnv(env = process.env) {
  return {
    apiKey: env.GROQ_API_KEY || '',
    model: env.GROQ_MODEL || 'openai/gpt-oss-20b',
    baseUrl: (env.GROQ_BASE_URL || 'https://api.groq.com').replace(/\/+$/, ''),
  };
}

function createAi({ config = {}, rateGate = null, fetchImpl = globalThis.fetch, logger = silentLogger() } = {}) {
  const cfg = { ...configFromEnv(), ...config };
  const url = `${cfg.baseUrl}/openai/v1/chat/completions`;
  const stats = { calls: 0, errors: 0 };

  function isLLMConfigured() { return !!cfg.apiKey; }

  async function chat(messages, { maxTokens = 700, temperature = 0.3, signal = null } = {}) {
    if (!cfg.apiKey) throw Object.assign(new Error('LLM not configured'), { code: 'no_llm', retryable: false });
    if (rateGate) await rateGate.acquire({ signal });
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 30000);
    const onAbort = () => ac.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    stats.calls += 1;
    try {
      const r = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model, messages, max_tokens: maxTokens, temperature }),
        signal: ac.signal,
      });
      if (!r.ok) { stats.errors += 1; throw Object.assign(new Error(`Groq ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`), { code: r.status === 429 ? 'rate_limited' : 'llm_error', status: r.status }); }
      const j = await r.json();
      return String(j.choices?.[0]?.message?.content || '').trim();
    } catch (e) {
      if (!e.code) { stats.errors += 1; e.code = 'llm_network'; }
      throw e;
    } finally { clearTimeout(to); if (signal) signal.removeEventListener('abort', onAbort); }
  }

  // ── Extractive fallback (no LLM, no key) ────────────────────────────────
  function extractiveSummary(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (clean.length < 40) return null;
    const sentences = clean.split(/(?<=[.!?])\s+/).filter((s) => s.split(' ').length >= 4);
    if (!sentences.length) return clean.slice(0, 240);
    const first = sentences[0];
    const rest = sentences.slice(1).sort((a, b) => b.length - a.length).slice(0, 2);
    const picked = [first, ...rest].filter((s, i, a) => a.indexOf(s) === i);
    return picked.join(' ').slice(0, 480);
  }

  async function summarize(transcriptText, { signal } = {}) {
    const text = String(transcriptText || '').trim();
    if (text.length < 40) return null;
    if (isLLMConfigured()) {
      try {
        const out = await chat([
          { role: 'system', content: 'You summarize screen-recording transcripts for a video library. Write 2–4 clear sentences in plain language. No preamble, no "this video", no markdown — just the summary.' },
          { role: 'user', content: `Transcript:\n\n${text.slice(0, 12000)}` },
        ], { maxTokens: 300, signal });
        if (out) return out;
      } catch (e) { if (e && e.code === 'aborted') throw e; logger.warn({ err: { message: e.message } }, 'LLM summary failed — extractive fallback'); }
    }
    return extractiveSummary(text);
  }

  // ── Chapters ────────────────────────────────────────────────────────────
  function titleFromText(text) {
    const words = String(text || '').replace(/[^\w\s']/g, ' ').split(/\s+/).filter(Boolean).slice(0, 6);
    return words.length ? words.join(' ').slice(0, 60) : null;
  }
  function heuristicChapters(segments, duration) {
    const N = Math.min(6, Math.max(3, Math.round(duration / 120)));
    const step = duration / N;
    const out = [];
    for (let i = 0; i < N; i += 1) {
      const t = Math.round(i * step);
      const seg = segments.find((s) => s.start >= t) || segments[Math.min(i, segments.length - 1)] || segments[0];
      out.push({ t, title: titleFromText(seg && seg.text) || `Part ${i + 1}` });
    }
    return out.filter((c, i, a) => i === 0 || c.t > a[i - 1].t);
  }
  function safeParseChapters(raw) {
    try {
      const arr = JSON.parse(String(raw || '').replace(/```json|```/g, '').trim());
      if (!Array.isArray(arr)) return [];
      return arr.map((c) => ({ t: Math.max(0, Math.round(Number(c.t) || 0)), title: String(c.title || '').slice(0, 80).trim() }))
        .filter((c) => c.title).sort((a, b) => a.t - b.t)
        .filter((c, i, a) => i === 0 || c.t !== a[i - 1].t);
    } catch { return []; }
  }
  async function generateChapters(segments, { signal } = {}) {
    const arr = (Array.isArray(segments) ? segments : []).filter((s) => s && s.text);
    if (arr.length < 3) return [];
    const duration = arr[arr.length - 1].end || arr[arr.length - 1].start || 0;
    if (duration < 60) return [];   // too short to chapter
    if (isLLMConfigured()) {
      try {
        const lines = arr.map((s) => `[${Math.round(s.start)}s] ${s.text}`).join('\n').slice(0, 12000);
        const out = await chat([
          { role: 'system', content: 'Split this timestamped video transcript into 3–8 chapters. Reply with ONLY a JSON array of {"t": <seconds int>, "title": "<short title>"}, ordered by time, first at t=0. No prose, no code fences.' },
          { role: 'user', content: lines },
        ], { maxTokens: 500, temperature: 0.2, signal });
        const parsed = safeParseChapters(out);
        if (parsed.length) { if (parsed[0].t > 0) parsed.unshift({ t: 0, title: 'Intro' }); return parsed.slice(0, 8); }
      } catch (e) { if (e && e.code === 'aborted') throw e; logger.warn({ err: { message: e.message } }, 'LLM chapters failed — heuristic fallback'); }
    }
    return heuristicChapters(arr, duration);
  }

  // ── Title (LLM, multilingual): title the SUMMARY, not the raw transcript ─
  async function generateTitle(transcriptText, precomputedSummary, { signal } = {}) {
    const text = String(transcriptText || '').trim();
    if (text.length < 12 || !isLLMConfigured()) return null;
    let basis = String(precomputedSummary || '').trim();
    if (!basis) { try { basis = String(await summarize(text, { signal }) || '').trim(); } catch (e) { if (e && e.code === 'aborted') throw e; } }
    if (!basis) basis = text;
    try {
      const out = await chat([
        { role: 'system', content: 'Output ONLY a clear, specific 4–7 word English video title in Title Case for the content below. No quotes, no preamble, no trailing punctuation, no "this video".' },
        { role: 'user', content: basis.slice(0, 1500) },
      ], { maxTokens: 20, temperature: 0.2, signal });
      const title = String(out || '').split('\n')[0].replace(/\s+/g, ' ').replace(/^["'“”\s]+|["'“”.\s]+$/g, '').slice(0, 80).trim();
      return title || null;
    } catch (e) { if (e && e.code === 'aborted') throw e; return null; }
  }

  // ── Translation (LLM-only, numbered-line protocol) ──────────────────────
  async function translateSegments(segments, targetLang, { signal } = {}) {
    const arr = (Array.isArray(segments) ? segments : []).filter((s) => s && s.text);
    if (!arr.length) return [];
    if (!isLLMConfigured()) throw Object.assign(new Error('Translation needs the AI key (set GROQ_API_KEY).'), { code: 'no_llm', retryable: false });
    const numbered = arr.map((s, i) => `${i + 1}. ${s.text}`).join('\n').slice(0, 12000);
    const out = await chat([
      { role: 'system', content: `Translate each numbered line into ${targetLang}. Return the SAME numbered list — one translation per line, same numbers, nothing else.` },
      { role: 'user', content: numbered },
    ], { maxTokens: 2000, temperature: 0.2, signal });
    const map = {};
    String(out).split('\n').forEach((line) => { const m = line.match(/^\s*(\d+)[.)]\s*(.+)$/); if (m) map[+m[1]] = m[2].trim(); });
    return arr.map((s, i) => ({ ...s, text: map[i + 1] || s.text }));
  }

  return { isLLMConfigured, chat, summarize, extractiveSummary, generateChapters, generateTitle, translateSegments, config: cfg, stats };
}

module.exports = { createAi, configFromEnv };
