# 15 — Transcription & AI

> Speech-to-text, translation, and generative features (title/summary/chapters). The existing pipeline logic is good and is **kept** (`server/transcription.js`, `server/ai.js` — audited `01` §3.7); this doc relocates it into workers with explicit statuses, retries, and the hard rule: **AI never prevents a video from being playable** (invariant #14).

---

## 1. Providers

- **Primary STT**: Groq `whisper-large-v3` (multilingual accuracy, esp. Urdu/Hindi — the reason it was adopted; see commit history around `f020c38`).
- **Fallback STT**: self-hosted whisper.cpp (`ggml-base`, baked into the worker Docker image exactly as the current server Dockerfile does). Used when `GROQ_API_KEY` absent or Groq hard-fails.
- **LLM**: Groq chat completions (`openai/gpt-oss-20b` default) for title/summary/chapters/translation, with the existing extractive fallbacks when unconfigured (`ai.js:32-42, 64-74`).
- `isConfigured()` semantics preserved: no provider → endpoints return 501 `transcription_unconfigured`.

## 2. Transcription pipeline (per `stt.transcribe` job)

Ported verbatim from `transcription.js` with its tuning env vars:

1. Input: `audio` asset (`09` §6) downloaded to scratch (no more Cloudinary mp3 URL).
2. ffmpeg → 16kHz mono WAV.
3. **VAD chunking** (the multi-language core): ffmpeg `silencedetect` (noise −30dB, min 0.5s) → speech chunks padded 0.15s, merged < 3s slivers, capped at 40s, max 40 chunks (pairwise-merge overflow).
4. Pass 1: each chunk transcribed with **independent language auto-detect** (verbose_json, temperature 0, segment timestamps), 3.1s pacing under Groq's 20 RPM; per-chunk single retry then skip.
5. Pass 2: languages covering < 15% of audio are re-transcribed **forced to the dominant language** (name→ISO map kept) — suppresses spurious per-chunk misdetection.
6. Merge segments with absolute offsets; filter Whisper hallucination signature (`no_speech_prob > .6 && avg_logprob < −1`).
7. Whole-file fallback when no usable pauses.
8. Language override (`spoken_lang_override`) honored on the whisper.cpp path; Groq path stays auto (matching current intent, `transcription.js:299-303`).

**Changes from current:**
- Persist to `transcripts` + `transcript_segments` rows (not a blob inside meta.json).
- Status transitions `queued → running → done|failed` visible to the UI (today the UI cannot tell "processing" from "none" — `index.js:760-771` only knows done/none).
- Rate-limit budget is enforced by the queue's limiter group (`10` §3) so multiple workers can exist without exceeding Groq quotas; chunk pacing remains inside the job.
- Restart-safe: a killed job re-runs from scratch (idempotent — transcript upsert keyed by recording).

## 3. Language detection & VAD

As above (per-chunk auto-detect is the language detection mechanism; there is deliberately no single up-front detection — that was the original mixed-language bug: one detect locks the whole file, `transcription.js:34-38`). Config via env: `STT_VAD_NOISE, STT_VAD_MIN_SIL, STT_CHUNK_MAX/MIN, STT_DOMINANT_SHARE, STT_MAX_CHUNKS, STT_CHUNK_GAP_MS` — all preserved.

## 4. Timestamped segments & captions

Segments `{idx, start_s, end_s, text, language}`; consumed by: transcript tab (search + follow-along), captions VTT asset (`09` §7), silence-removal ranges (`14` §7), chapter generation. Segment times refer to the **current active video timeline**; after an overwrite render, transcripts are flagged stale (`14` §4).

## 5. Translation (`stt.translate` job)

LLM numbered-line protocol from `ai.js:126-138` (kept). New: results cached in `transcript_translations (transcript_id, lang)` — today every language switch re-burns LLM tokens. Cache invalidated when the transcript is regenerated. No provider → 501 `no_llm` (as today).

## 6. Title / Summary / Chapters (`ai.*` jobs)

- **Title**: keep the two-step insight — summarize first, title the summary (raw non-English transcripts made the small model hallucinate; `ai.js:106-114` + commit `5b2978d`). Heuristic extractive title as fallback (`transcription.generateTitle` kept). Never overwrites a user-set title (DEFAULT_TITLES guard, `index.js:339-342`).
- **Summary**: LLM 2–4 sentences → `recordings.description`; extractive fallback.
- **Chapters**: LLM JSON array with `t=0` intro guarantee + heuristic time-sliced fallback (`ai.js:84-101` kept); stored `recordings.chapters`.
- **Auto-processing chain** after upload (replaces `autoProcessRecording`): `transcribe → captions → title (always, free tier included) → summary + chapters (if aiDocsEnabled)`, each its own job, each independently retryable, gated by `AUTO_PROCESS_ON_UPLOAD` equivalent config and `duration ≥ 3s`.

## 7. Status model & UI contract

- `recordings.ai_status`: `none → queued → running → done|failed` — aggregate for the "AI is working" spinner.
- `transcripts.status` separately (`08` §12 responses).
- Manual triggers return `202 {jobId}`; UI polls. Failures show a retry affordance with the taxonomy message (`18` §8).

## 8. Retries & failure isolation

| Failure | Policy |
|---|---|
| Groq 429 | retry with Retry-After backoff, job stays `running` between chunk retries as today; job-level retry 3× |
| Groq 5xx / network | chunk retry once (existing), then job retry |
| Groq persistent failure | fall back to whisper.cpp path within the same job attempt |
| No speech detected | `transcripts.status='done'` with 0 segments + `note:'no_speech'` (today: 422 error — make it a valid outcome so auto-processing doesn't look broken) |
| LLM failure | extractive fallbacks (existing); if both fail → `ai_status='failed'`, silent for auto-trigger |
| Audio extract failed | transcript `failed(audio_extract_failed)`; retry re-runs extraction |

**Isolation guarantees:** AI/STT jobs run in separate queues from media; their failures never touch `recordings.status`; their workers can be scaled to zero and the product still ships videos. A recording is `ready` before any AI work completes.

## 9. Cost controls

Per-user rate limits on manual AI endpoints (10/h — `08` §1); auto-processing skips recordings < 3s (as today); translation cache (§5); admin metric: Groq calls/day and failure rate (`19` §4). Model ids/env config unchanged so a future provider swap is config-only.
