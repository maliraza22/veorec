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

### 2.1 As implemented (T-603)

`worker/src/stt/transcription.js` — `createTranscriber({ config, rateGate, fetchImpl, logger })`, config from env (`FFMPEG_BIN`, `FFPROBE_BIN`, `WHISPER_BIN` + `WHISPER_ARGS`, `WHISPER_MODEL_PATH`, `GROQ_API_KEY`, `GROQ_STT_MODEL`, `GROQ_BASE_URL`, the `STT_*` tuning values) and overridable per instance — no module globals, so the tests run the whole pipeline against a scriptable Groq mock and a fake `whisper-cli` with real ffmpeg on synthetic audio. The algorithm is the one above, verbatim: 16 kHz WAV → `silencedetect` → padded/merged/capped chunks → pass 1 per-chunk auto-detect → pass 2 forced dominant language → merge with absolute offsets and the hallucination filter → whole-file fallback. **Changed for the worker (all covered by `tests/stt.test.js`)**: a 429 honours `Retry-After` (bounded by `STT_MAX_RETRY_AFTER_MS`, `STT_CHUNK_RETRIES` per chunk) before the legacy "retry once then skip the chunk" rule; a persistent Groq failure falls back to whisper.cpp **within the same attempt** when a model is present, otherwise the job fails *transiently* and retries; every Groq call passes the shared rate gate (`10` §3); an `AbortSignal` stops the pipeline between steps and kills ffmpeg; the result carries `source` (`groq` | `whisper_cpp`) and per-run stats (calls, 429s, skips, forced chunks, fallback). `worker/src/stt/ai.js` is the LLM helper with the same prompts, the summary-first title and the extractive/heuristic fallbacks.

## 3. Language detection & VAD

As above (per-chunk auto-detect is the language detection mechanism; there is deliberately no single up-front detection — that was the original mixed-language bug: one detect locks the whole file, `transcription.js:34-38`). Config via env: `STT_VAD_NOISE, STT_VAD_MIN_SIL, STT_CHUNK_MAX/MIN, STT_DOMINANT_SHARE, STT_MAX_CHUNKS, STT_CHUNK_GAP_MS` — all preserved.

## 4. Timestamped segments & captions

Segments `{idx, start_s, end_s, text, language}`; consumed by: transcript tab (search + follow-along), captions VTT asset (`09` §7), silence-removal ranges (`14` §7), chapter generation. *(T-704: the captions asset is regenerated from these rows for every transcript version — `09` §7.1.)* Segment times refer to the **current active video timeline**; after an overwrite render, transcripts are flagged stale (`14` §4).

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
- *(T-1103, as implemented:)* the OWNER of a v1 recording gets an **AI status strip** on the watch page (`client/src/pages/watch/AiStatus.jsx`, hook `useAiStatus.js`, pure `client/src/lib/aiStatus.mjs`) driven by `GET /api/v1/recordings/:id/status` (`transcript {status,error,note}` + `ai {status, failed[], active[]}`, the latest row per AI queue): the transcript and each AI job (title / summary / chapters / captions / translation) with its real state and progress, the `18` §8 taxonomy turned into owner copy (`no_speech` is a valid outcome, not a retry; provider trouble is retryable; configuration failures are not) and a **Retry** that routes to the existing manual trigger (202 + poll). Polling happens only while a fact says work is in flight (or a trigger is pending); the strip renders only when there is something to say. The transcript tab shows a failed transcript's reason; the dashboard card carries an `AI failed` / `AI…` badge from `ai_status`. Tests: `tests/ai-status-page.test.js` (20), `tests/ai-api.test.js` §G.
- Manual triggers return `202 {jobId}`; UI polls. Failures show a retry affordance with the taxonomy message (`18` §8). *(T-603: `POST /api/v1/recordings/:id/transcribe` → 202 and `transcripts.status='queued'`; a repeat while queued/running reuses the job; a repeat after completion requeues the same logical job with attempts reset; `GET /recordings/:id/transcript` exposes `none | queued | running | done | failed` (+ `note:'no_speech'`, `error`, `source`, `spokenLang`); `GET /recordings/:id/status` projects jobs/assets/transcript/`aiStatus`. `ai_status` is settled by the worker after each job row is marked, so it is race-free across concurrent chain jobs. The LEGACY synchronous `/api/recordings/:id/transcribe` stays for legacy (Cloudinary/JSON) recordings until the Phase 8 read cutover.)*

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
