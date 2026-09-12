// ─────────────────────────────────────────────────────────────────────────────
// T-1103 — AI status surfaces (docs/15 §7, docs/18 §8).
//
// Pure helpers over the owner's `GET /api/v1/recordings/:id/status` payload:
// the transcript's state and reason, each AI job's state (title / summary /
// chapters / captions / translation) with a human message and whether a retry
// makes sense. The page renders these; it never guesses from timers.
// ─────────────────────────────────────────────────────────────────────────────

/** queue → what the owner sees, and the manual trigger that retries it (docs/08 §12). */
export const AI_KINDS = Object.freeze({
  transcribe: { kind: 'transcribe', label: 'Transcript', retryPath: 'transcribe' },
  ai_title: { kind: 'title', label: 'Title', retryPath: 'title/auto' },
  ai_summary: { kind: 'summary', label: 'Summary', retryPath: 'summary' },
  ai_chapters: { kind: 'chapters', label: 'Chapters', retryPath: 'chapters' },
  captions: { kind: 'captions', label: 'Captions', retryPath: null },
  translate: { kind: 'translate', label: 'Translation', retryPath: null },
});

export const BUSY = new Set(['queued', 'active', 'running']);

/** docs/18 §8 taxonomy → a sentence the owner can act on, and whether retrying can help. */
export function aiFailureCopy(code) {
  const c = String(code || '').split(':')[0].trim();
  switch (c) {
    case 'no_speech': return { message: 'No speech was detected in the audio.', retryable: false };
    case 'no_source': return { message: 'The video has no media to transcribe yet.', retryable: true };
    case 'transcription_unconfigured': return { message: 'Transcription is not set up on this server yet.', retryable: false };
    case 'transcript_required': return { message: 'This needs a finished transcript first.', retryable: true };
    case 'audio_decode_failed': return { message: 'The audio could not be decoded.', retryable: false };
    case 'audio_extract_failed': return { message: 'Extracting the audio failed.', retryable: true };
    case 'ffmpeg_missing': return { message: 'The media tools are unavailable on the worker.', retryable: true };
    case 'rate_limited': return { message: 'The AI provider is busy right now.', retryable: true };
    case 'groq_error': case 'groq_network': return { message: 'The AI provider could not be reached.', retryable: true };
    case 'whisper_failed': return { message: 'Speech recognition failed on this audio.', retryable: true };
    case 'no_llm': return { message: 'No language model is configured on this server.', retryable: false };
    case 'storage_unavailable': return { message: 'Storage was unavailable — please try again.', retryable: true };
    case 'recording_gone': return { message: 'The recording no longer exists.', retryable: false };
    case 'aborted': case 'timeout': return { message: 'The job was interrupted.', retryable: true };
    default: return { message: c ? `Failed (${c}).` : 'Failed.', retryable: true };
  }
}

/** The latest job row per AI queue (the API lists every job; the newest wins). */
export function latestByQueue(jobs) {
  const out = {};
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (!AI_KINDS[j.queue]) continue;
    const prev = out[j.queue];
    if (!prev || (j.id || '') > (prev.id || '')) out[j.queue] = j;
  }
  return out;
}

/**
 * The status payload → what the panel shows.
 * @returns {{ transcript: {state, message, retryable, note}, items: Array<{kind,label,state,message,retryable,progress,retryPath}>, busy: boolean, failed: number, show: boolean }}
 */
export function summarizeAiStatus(status) {
  if (!status) return { transcript: { state: 'none', message: null, retryable: false, note: null }, items: [], busy: false, failed: 0, show: false };
  const t = status.transcript || {};
  const tCopy = t.status === 'failed' ? aiFailureCopy(t.error) : { message: null, retryable: false };
  const transcript = { state: t.status || 'none', message: t.status === 'failed' ? tCopy.message : (t.note === 'no_speech' ? 'No speech was detected.' : null), retryable: t.status === 'failed' ? tCopy.retryable : false, note: t.note || null };
  const latest = latestByQueue(status.jobs);
  const items = [];
  for (const [queue, spec] of Object.entries(AI_KINDS)) {
    if (queue === 'transcribe') continue;
    const j = latest[queue];
    if (!j) continue;
    const state = j.status === 'completed' ? 'done' : j.status === 'failed' ? 'failed' : BUSY.has(j.status) ? (j.status === 'active' ? 'running' : 'queued') : j.status;
    const copy = state === 'failed' ? aiFailureCopy(j.error) : { message: null, retryable: false };
    items.push({ kind: spec.kind, label: spec.label, state, message: copy.message, retryable: state === 'failed' && copy.retryable && !!spec.retryPath, progress: typeof j.progress === 'number' ? j.progress : null, retryPath: spec.retryPath });
  }
  const busy = BUSY.has(transcript.state) || BUSY.has(status.aiStatus) || items.some((i) => i.state === 'queued' || i.state === 'running');
  const failed = (transcript.state === 'failed' ? 1 : 0) + items.filter((i) => i.state === 'failed').length;
  return { transcript, items, busy, failed, show: busy || failed > 0 };
}

/** Poll delay while AI work is in flight (docs/15 §7: the UI polls). */
export const aiPollDelay = (attempt) => Math.min(6000, 3000 + attempt * 500);
