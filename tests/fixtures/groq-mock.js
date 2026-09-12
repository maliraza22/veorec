// A scriptable Groq mock (T-603 tests): the two endpoints the worker uses,
// with a control surface to inject 429s / 5xx and to read back every call.
//
//   POST /openai/v1/audio/transcriptions   (multipart: file, model, language?)
//   POST /openai/v1/chat/completions       (JSON)
//   POST /__mock/reset  { stt: { plan:[...] }, chat: { plan:[...] }, languages:[...] }
//   GET  /__mock/calls  → { stt:[{n, fileName, bytes, language, model}], chat:[{n, system, user}] }
//
// A "plan" is a list of responses consumed in order for the next calls:
//   { status: 429, retryAfter: 1 } | { status: 500 } | { status: 200, language, segments } | { status:200, content }
// When the plan is exhausted, STT answers with the language from `languages`
// (indexed by chunk order, default 'english') and one segment per call; chat
// answers with canned content by prompt kind.
'use strict';

const http = require('http');

function createGroqMock() {
  const state = { stt: { plan: [] }, chat: { plan: [] }, languages: [], calls: { stt: [], chat: [] }, delayMs: 0 };

  function parseMultipart(buf, contentType) {
    const m = /boundary=(.+)$/.exec(contentType || '');
    if (!m) return {};
    const boundary = Buffer.from(`--${m[1]}`);
    const fields = {};
    let pos = buf.indexOf(boundary);
    while (pos !== -1) {
      const next = buf.indexOf(boundary, pos + boundary.length);
      if (next === -1) break;
      const part = buf.subarray(pos + boundary.length + 2, next - 2);       // strip CRLF both ends
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const header = part.subarray(0, headerEnd).toString('utf8');
        const body = part.subarray(headerEnd + 4);
        const name = /name="([^"]+)"/.exec(header);
        const file = /filename="([^"]+)"/.exec(header);
        if (name) fields[name[1]] = file ? { fileName: file[1], bytes: body.length } : body.toString('utf8');
      }
      pos = next;
    }
    return fields;
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const buf = Buffer.concat(chunks);
      const json = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
      if (req.url === '/__mock/reset' && req.method === 'POST') {
        const cfg = buf.length ? JSON.parse(buf.toString('utf8')) : {};
        state.stt.plan = (cfg.stt && cfg.stt.plan) || [];
        state.chat.plan = (cfg.chat && cfg.chat.plan) || [];
        state.languages = cfg.languages || [];
        state.delayMs = cfg.delayMs || 0;
        state.calls = { stt: [], chat: [] };
        return json(200, { ok: true });
      }
      if (req.url === '/__mock/calls') return json(200, state.calls);
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));

      if (req.url === '/openai/v1/audio/transcriptions' && req.method === 'POST') {
        if (!/^Bearer .+/.test(req.headers.authorization || '')) return json(401, { error: 'no key' });
        const f = parseMultipart(buf, req.headers['content-type']);
        const n = state.calls.stt.length;
        const call = { n, fileName: f.file && f.file.fileName, bytes: f.file && f.file.bytes, language: f.language || null, model: f.model, format: f.response_format };
        state.calls.stt.push(call);
        const planned = state.stt.plan.shift();
        if (planned && planned.status !== 200) return json(planned.status, { error: { message: `mock ${planned.status}` } }, planned.retryAfter ? { 'retry-after': String(planned.retryAfter) } : {});
        const chunkIdx = Number((/chunk_(\d+)/.exec(call.fileName || '') || [])[1]);
        const language = (planned && planned.language) || (f.language ? { en: 'english', ur: 'urdu', ko: 'korean', es: 'spanish' }[f.language] || f.language : (Number.isFinite(chunkIdx) && state.languages[chunkIdx]) || 'english');
        const segments = planned && planned.segments !== undefined ? planned.segments : [
          { start: 0, end: 1.2, text: f.language ? `forced ${language} ${Number.isFinite(chunkIdx) ? chunkIdx : 'whole'}` : `hello from ${language} chunk ${Number.isFinite(chunkIdx) ? chunkIdx : 'whole'}`, no_speech_prob: 0.05, avg_logprob: -0.2 },
          { start: 1.2, end: 1.9, text: 'garbage', no_speech_prob: 0.9, avg_logprob: -1.5 },   // hallucination signature → filtered
        ];
        return json(200, { language, text: segments.map((s) => s.text).join(' '), segments });
      }
      if (req.url === '/openai/v1/chat/completions' && req.method === 'POST') {
        if (!/^Bearer .+/.test(req.headers.authorization || '')) return json(401, { error: 'no key' });
        const body = JSON.parse(buf.toString('utf8') || '{}');
        const system = (body.messages || []).find((m) => m.role === 'system');
        const user = (body.messages || []).find((m) => m.role === 'user');
        state.calls.chat.push({ n: state.calls.chat.length, system: system && system.content, user: user && user.content, model: body.model });
        const planned = state.chat.plan.shift();
        if (planned && planned.status && planned.status !== 200) return json(planned.status, { error: { message: `mock ${planned.status}` } }, planned.retryAfter ? { 'retry-after': String(planned.retryAfter) } : {});
        let content = planned && planned.content;
        if (content === undefined) {
          const s = String(system && system.content || '');
          if (/summarize/i.test(s)) content = 'A mock summary of the recording. It covers the demo end to end.';
          else if (/chapters/i.test(s)) content = '[{"t":0,"title":"Intro"},{"t":65,"title":"Middle"},{"t":120,"title":"End"}]';
          else if (/title/i.test(s)) content = 'Mock Generated Title';
          else if (/Translate/i.test(s)) content = String(user && user.content || '').split('\n').map((l) => l.replace(/^(\s*\d+[.)]\s*)(.+)$/, '$1[tr] $2')).join('\n');
          else content = 'ok';
        }
        return json(200, { choices: [{ message: { role: 'assistant', content } }] });
      }
      json(404, { error: 'unknown route' });
    });
  });

  return {
    state,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

module.exports = { createGroqMock };
