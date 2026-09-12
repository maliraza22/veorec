// WebVTT captions from transcript segments (docs/09 §7, docs/15 §4, T-704).
//
// One cue per segment: `HH:MM:SS.mmm --> HH:MM:SS.mmm`, text escaped for
// VTT (& < >), zero-length cues widened by 10 ms, overlapping starts kept in
// order. The player attaches the file as a real `<track kind=captions>`.
'use strict';

function ts(sec) {
  // Round to whole milliseconds FIRST so 59.9996 carries into the minute.
  const total = Math.max(0, Math.round((Number(sec) || 0) * 1000));
  const h = Math.floor(total / 3600000), m = Math.floor((total % 3600000) / 60000), s = Math.floor((total % 60000) / 1000), ms = total % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function escapeText(t) {
  // `-->` first (a cue-timing token inside text would break the parser), then the entities.
  return String(t || '').replace(/-->/g, '→').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, ' ').trim();
}

/**
 * @param {Array<{idx?:number,start:number,end:number,text:string,language?:string}>} segments
 * @param {{language?:string, title?:string}} [meta]
 * @returns {string} WebVTT document
 */
function buildVtt(segments, meta = {}) {
  const lines = ['WEBVTT'];
  if (meta.language) lines.push(`Language: ${meta.language}`);
  if (meta.title) lines.push(`Title: ${escapeText(meta.title)}`);
  lines.push('');
  const cues = (Array.isArray(segments) ? segments : [])
    .map((s, i) => ({ idx: s.idx ?? i, start: Number(s.start ?? s.startS), end: Number(s.end ?? s.endS), text: escapeText(s.text) }))
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.text)
    .sort((a, b) => a.start - b.start || a.idx - b.idx);
  let n = 0;
  for (const c of cues) {
    const end = c.end > c.start ? c.end : c.start + 0.01;
    n += 1;
    lines.push(String(n), `${ts(c.start)} --> ${ts(end)}`, c.text, '');
  }
  return `${lines.join('\n')}\n`;
}

/** Minimal structural check used before publishing (and by tests). */
function validateVtt(text) {
  const s = String(text || '');
  if (!s.startsWith('WEBVTT')) return { ok: false, reason: 'missing WEBVTT header' };
  const cueLines = s.split('\n').filter((l) => /-->/.test(l));
  for (const l of cueLines) {
    const m = /^(\d\d:\d\d:\d\d\.\d{3}) --> (\d\d:\d\d:\d\d\.\d{3})$/.exec(l.trim());
    if (!m) return { ok: false, reason: `bad timing line: ${l}` };
    if (m[2] <= m[1]) return { ok: false, reason: `cue end not after start: ${l}` };
  }
  return { ok: true, cues: cueLines.length };
}

module.exports = { buildVtt, validateVtt, ts, escapeText };
