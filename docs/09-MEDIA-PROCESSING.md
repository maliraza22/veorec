# 09 — Media Processing Pipeline

> FFprobe/FFmpeg workers that turn an uploaded source into playable, seekable, thumbnailed assets. Replaces Cloudinary transforms (`01` §3.6) and the fire-and-forget post-upload hook. Queue mechanics in `10`; job list there — this doc is the media logic.

---

## 1. Pipeline overview

```mermaid
flowchart LR
    UP["upload complete\n(recording.status=uploaded)"] --> PR[probe]
    PR -->|valid| T1[transcode mp4]
    PR -->|valid| TH[thumbnail + poster + preview_gif]
    PR -->|"duration > 5min OR >1080p"| HLS[hls]
    PR -->|valid| AX[audio extract]
    AX --> ST[transcribe → AI chain — 15]
    PR -->|invalid| FAIL["recording.status=failed\nfailure_code=probe_invalid"]
    T1 --> RDY{"mp4 ready AND poster ready?"}
    TH --> RDY
    RDY -->|yes| READY["recording.status=ready"]
    HLS -.->|optional, never gates ready| READY
    ST -.->|never gates ready| READY
```

`ready` requires exactly: a `ready` MP4 asset + a `ready` poster. HLS, preview gif, transcription, AI are enhancements that attach later (invariant #14 generalized: nothing optional gates availability).

## 2. Probe & verification (`probe` job)

The first worker to touch every source. **Client metadata is never trusted** — this job establishes the facts.

1. Download `sources/{recordingId}/…` to worker scratch (stream to disk, never RAM).
2. `ffprobe -v error -show_format -show_streams -of json`.
3. Validate:
   - container ∈ {webm, matroska, mp4, mov}; ≥1 video stream; video codec ∈ {vp8, vp9, av1, h264, hevc}; audio codec (if any) ∈ {opus, vorbis, aac, mp3, pcm_*};
   - `duration` finite and > 0.5s (WebM from MediaRecorder may report duration only in the container after fixWebmDuration, or not at all → fall back to `ffprobe -count_packets` / decode-to-end duration: `ffmpeg -i in -f null -` and read the last pts — slower path, only when format duration is missing);
   - dimensions sane (16 ≤ w,h ≤ 7680); size matches `upload_sessions` recorded size.
4. Write facts in one tx: `recordings.duration/width/height`, source `video_assets` row updated (`codec_*`, `container`, `duration`, `status='ready'`).
5. **Post-probe entitlement check** (the authoritative duration check): `canRecord(user, probedDuration)` with the +30s grace. Over limit → `recording.status='rejected_limit'`, `failure_code='recording_limit'`, notify client on next status poll; 7-day grace before source deletion (upgrade rescues it → `reprocess`).
6. Fan out the derived jobs (idempotent enqueue by dedupe key).

Failure (unreadable/corrupt): `status='failed'`, `failure_code='probe_invalid'`; the client's local chunks still exist (recovery UI keeps offering Download until the user discards — `05`).

### 2.1 As implemented (T-701)

`worker/src/media/probe.js` — `createProber({ ffprobeBin, ffmpegBin })`: `probeFile(path)` runs `ffprobe -v error -show_format -show_streams -of json`, takes the container duration, else a stream duration, else **decodes to the end** (`ffmpeg -i in -f null -`, last `time=`) — the MediaRecorder-WebM-without-a-duration case, verified with a `-live 1` fixture; `validate(facts, { expectedSize })` applies every rule above in order (container ∈ webm/matroska/mp4/mov from ffprobe's `format_name` list; ≥ 1 video stream; codec sets incl. `pcm_*`; duration > 0.5 s; 16 ≤ w,h ≤ 7680; stored size = `recordings.size_bytes` from the completion). `worker/src/media/exec.js` runs every binary with a timeout + the job's AbortSignal (SIGKILL — no zombie ffmpeg) and resolves `FFMPEG_BIN`/`FFPROBE_BIN` → the static npm binaries (local dev/test) → PATH. The processor (`worker/src/processors/media.js`, queue `media`, 5-min timeout) HEADs the object, applies the scratch disk guard (`fs.statfs`, 2× source), streams the source to `/tmp/veorec-scratch/{jobId}/` (removed in `finally`), writes the facts in **one transaction** (`recordings.duration/width/height/size_bytes`, `uploaded → processing` — a `ready` recording is never demoted; the source `video_assets` row gets `codec_video/codec_audio/container/duration/width/height`, `status='ready'`), runs the **post-probe entitlement** (`maxRecordingDurationSeconds` from the one plan catalog via the T-602 resolver, **+30 s grace**; over → `rejected_limit` + `failure_code='recording_limit'`, facts kept, no fan-out; a re-probe with a higher plan — `reprocess` after an upgrade — clears it), then fans out `transcode:{id}:mp4`, `thumb:{id}`, `audio:{id}` and `hls:{id}` (only when duration > 5 min or the source exceeds 1080p) — idempotent by dedupe key, with settled derived rows requeued so a re-probe re-derives. Invalid sources: `failed(probe_invalid)` on the recording AND a terminal job failure (`probe_invalid: <rule>`) so the case sits in the dead-letter set for triage; a missing object, a missing source row and a size mismatch are all `probe_invalid`. Transient: storage/head/download errors, `ffprobe` missing, timeouts, scratch full. **Not yet:** `maybe_mark_ready` and the derived jobs themselves (T-702+) — the fan-out rows wait in the transport (a worker without their processors defers them without burning an attempt).

## 3. Normalization & transcoding (`transcode` job)

Target: universal playback + instant seek. One MP4 rendition at source resolution capped at 1080p:

```
ffmpeg -y -i source.webm
  -c:v libx264 -preset veryfast -crf 23 -profile:v high -level 4.1
  -vf "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"
  -r 30 -pix_fmt yuv420p
  -c:a aac -b:a 128k -ar 48000 -ac 2
  -movflags +faststart
  derived/{recordingId}/{assetId}/video.mp4
```

- `+faststart` puts the moov atom first → the watch page seeks instantly (kills the Infinity-duration hack in `VideoPlayer.jsx:44-47`).
- Missing audio stream → produce video-only MP4 (do not synthesize silence).
- Variable-frame-rate WebM (MediaRecorder is VFR): `-r 30` + default `fps` filter behavior normalizes; A/V sync guard: `-async 1` not used (deprecated) — rely on `aresample=async=1:first_pts=0` if drift is detected in QA.
- Progress: parse `-progress pipe:1` → `processing_jobs.result.progress` (drives editor/watch progress UI).
- Output verified with a second ffprobe (duration within 2% of source; non-empty streams) before the asset row flips `ready` — a worker never publishes an unverified asset.

### 3.1 As implemented (T-702)

`worker/src/media/transcode.js` — `createTranscoder({ ffmpegBin, prober })` builds exactly the command above (`-an` instead of the aac chain for a video-only source), streams `-progress pipe:1` into a callback (0–99 % from `out_time` vs the probed source duration, 100 after verification) and **verifies before returning**: second ffprobe → h264 video present, audio present iff the source had audio, even dimensions, ≤ 1080p, duration within 2 % of the source facts, and `moov` before `mdat` (a top-level box scan — `+faststart` actually happened). The `transcode` processor (`worker/src/processors/media.js`) requires a probed, ready source and a processable recording (never `failed`/`rejected_limit`), applies **check-before-do** (a ready MP4 whose object exists is skipped — only `maybe_mark_ready` runs — unless `payload.force`), owns one `video_assets` row per recording (`kind='mp4'`, `variant='main'`, `counts_toward_quota=false`, `immutable=false`) whose **asset-id-scoped key** `derived/{recordingId}/{assetId}/video.mp4` a re-run overwrites (idempotent), persists progress on the job row every 5 % (`processing_jobs.result.progress`), uploads the verified file as a stream with its exact length, and publishes + promotes in ONE transaction: asset facts → `ready`, then `maybe_mark_ready`. Failure classes: ffmpeg exit / output verification / storage / scratch / timeout are transient (job retries, 3×); attempts exhausted → the job's `onSettled` hook sets `recordings.failed(transcode_failed)` with the **source kept** so a retry (reprocess) can try again. CPU rule (`§9`): `transcode`/`hls`/`render` are serialised **per worker process** by a runner semaphore (`TYPE_CONCURRENCY`); scale by adding workers.

**`maybe_mark_ready` (`worker/src/media/ready.js`)** — the only place `status='ready'` is set. Runs inside the caller's transaction after `SELECT … FOR UPDATE` on the recording (`recordings.getForUpdateSystem`, which refuses to run outside a transaction): promotes a `processing`/`uploaded` recording when a ready MP4 exists AND (a ready poster exists OR the `thumb:{id}` job failed terminally — the `§4` placeholder rule, logged at error level); never touches `ready`, `failed`, `rejected_limit` or deleted rows. Both transcode and thumbnail (T-703) call it, so whichever finishes second promotes.

## 4. Thumbnails, posters, previews (`thumbnail` job)

- **Poster** (watch page, og:image): frame at `min(2s, 10% of duration)` — not frame 0 (black/blank first frames are common in screen recordings; Cloudinary `so_0` today produces those): `ffmpeg -ss <t> -i src -frames:v 1 -vf scale=1280:-2 poster.jpg` (q=2).
- **Thumbnail** (library grid): same frame at 640w → `thumb.jpg`.
- **Preview gif/webp** (hover animation, replaces `animatedThumbnail` behavior): 3 clips of 1s at 10/50/90% → `preview.webp` (animated webp, ~400KB budget), only for recordings ≥ 10s.
- Custom uploaded thumbnails (Pro) become a `thumbnail` asset with `variant='custom'`; presence overrides generated in reads.

### 4.1 As implemented (T-703)

`worker/src/media/thumbnail.js` — `createThumbnailer({ ffmpegBin, prober })`: the poster frame is `min(2 s, 10 % of duration)` **checked for darkness** (`signalstats` YAVG < 24 = black) and stepped forward in 1 s increments (≤ 4 steps, never past the end) until a non-black frame is found — the "black first frames" case is verified with a 3 s black lead-in fixture; an all-black source falls back to the base frame and is flagged (`dark:true`, warn log). Outputs: poster `scale='min(1280,iw)':-2` q=2 (a smaller source is never upscaled), thumbnail 640 w, the **play-overlay poster variant** (`poster`/`variant='play'`, for email embeds) composited from an in-process PNG icon (`worker/src/media/play-icon.js` — no font, no external asset), and for recordings ≥ 10 s the hover preview: 3 × 1 s clips at 10/50/90 % (clamped so a clip fits) → 320 w, 10 fps animated **WebP** (`libwebp_anim`, q 60, re-encoded at q 35 once if over the 400 KB budget; the RIFF/WEBP header is verified). The `thumbnail` processor (`worker/src/processors/media.js`, media queue, not serialised) requires a probed ready source, creates **one row per produced image** (`poster`, `poster/play`, `thumbnail`, `preview_gif` with `container='webp'` — the legacy-named kind holds the animated preview; the key contract gained `keys.image(…,'preview_webp')` → `derived/{recordingId}/{assetId}/preview.webp`), uploads each with its content type and exact length, flips the rows `ready` with facts in one transaction and calls `maybe_mark_ready` there; a custom `variant='custom'` thumbnail is never touched. Attempts exhausted → the `onSettled` hook runs `maybe_mark_ready` so an already-transcoded recording is promoted with the placeholder poster (`§4` rule) instead of sticking in `processing`. `POST /api/v1/recordings/:id/reprocess` (`08` §5) requeues the probe row (attempts reset), which re-derives everything through the fan-out.

## 5. HLS (`hls` job — recordings > 5 min or source > 1080p)

```
ffmpeg -i source -filter_complex [splits] \
  renditions: 1080p@5M (if source ≥1080), 720p@2.8M, 480p@1.2M
  -c:v h264 -c:a aac 128k -hls_time 4 -hls_playlist_type vod
  -hls_segment_type fmp4 -master_pl_name master.m3u8
```
Uploaded under `derived/{recordingId}/{assetId}/hls/`. The player prefers HLS when present (`11` §3). Asset `kind='hls'` with the master playlist as `storage_key`; segments are addressed relative to it (signing strategy for segments in `12` §5.2).

## 6. Audio extraction (`audio_extract` job)

`ffmpeg -i source -vn -c:a aac -b:a 96k audio/{recordingId}/audio.m4a` — the STT input (replaces the Cloudinary mp3-derivative URL). Also 16kHz mono WAV generated transiently inside the transcribe worker (as `transcription.js` does today).

## 7. Captions (`captions` job, post-transcription)

Generate WebVTT from `transcript_segments` → asset `kind='captions_vtt'`; the player attaches it as a real `<track>` (replacing the JS caption overlay when available). Re-generated whenever the transcript changes (dedupe key includes transcript updated_at).

### 7.1 As implemented (T-704)

**Audio extract** — `worker/src/media/audio.js` runs the §6 command (`-vn -c:a aac -b:a 96k`, `+faststart`) and verifies the output with ffprobe (aac stream, no video, duration within 2 % of the probed source). The `audio_extract` processor (media queue, fan-out from the probe) requires a probed ready source, **skips video-only sources** (`{skipped:'no_audio'}`, no row), owns one `audio` asset row per recording at `audio/{recordingId}/audio.m4a` (`container='m4a'`, not billed), uploads as `audio/mp4` with the exact length and flips the row `ready` with duration/codec facts. `stt.transcribe` (T-603) already prefers a ready `audio` asset over the source, so whichever lands first is used — the transcript is identical either way. No chaining from here: the upload completion enqueues `transcribe` (T-603 auto chain) and `stt:{id}` dedupes.

**Captions** — `worker/src/media/captions.js` builds WebVTT from the segments (cues sorted by start, VTT-unsafe text escaped, zero-length cues widened to 10 ms, millisecond-exact timestamps, `Language:`/`Title:` headers) and validates the document structurally before publishing. `stt.transcribe` enqueues `captions:{recordingId}:{transcript.updated_at ms}` inside the transaction that stores the transcript (no cue → no job), so every transcript version gets its own captions job while the `captions_vtt` **asset row is reused** and its object overwritten (`derived/{recordingId}/{assetId}/captions.vtt`, `text/vtt`, `container='vtt'`; the key contract gained `keys.captions`). The processor is terminal without a completed transcript (`transcript_required`). The watch page (`11` §3, T-801) serves it as `captionsUrl` for a native `<track kind=captions>`.

## 8. Edit renders

Render jobs (trim/splice/silence-cut) are specified in `14` §5 — they run in the same worker fleet, consume **source or MP4 assets** (never mutate them), and publish `render_output` assets. Concat strategy: same-source segment cuts use stream-copy where cut points align with keyframes (`-ss/-to -c copy` per segment + concat demuxer) and re-encode otherwise; cross-video composition always re-encodes on a common canvas (letterbox pad — port the logic and MAX_EDGE lessons from `index.js:1204-1240`).

## 9. Worker architecture & resource rules

- Concurrency per worker process: transcode/hls/render = 1 (CPU-bound; scale by adding worker replicas); probe/thumbnail/audio = 4; transcribe = 1 with Groq rate-limit group (`10` §6).
- **CPU-first fleet**: every job in this document runs on CPU FFmpeg workers (`worker-1..n`, horizontally scaled) — no GPU is required for core product operations. GPU workers, when introduced for genuinely GPU-bound workloads (heavy compositing, AI video, high-res exports), consume a separate `render-gpu` queue under the identical job contract (`02` §2.2, `10` §2) — never a permanent monolithic render server.
- Scratch space: `/scratch/{jobId}/` — created at start, **always removed in `finally`**; startup sweep deletes orphans older than 24h. Disk guard: refuse jobs when free scratch < 2× source size (job → delayed retry). **Quota rule:** scratch files and any not-yet-promoted outputs are temporary processing storage — they never touch the user's quota ledger (`16` §4.1); only `ready` assets with `counts_toward_quota=true` (the recording's primary media) count, and platform-derived assets (MP4/HLS/posters/captions) are always `counts_toward_quota=false`.
- Timeouts: probe 5min; transcode/hls/render `max(10min, 3× duration)`; thumbnail 3min. On timeout the process tree is killed (`SIGKILL` after `SIGTERM` grace) — no zombie ffmpeg.
- Idempotency: outputs are written to asset-id-scoped keys; re-running a job overwrites its own outputs and re-upserts the same asset row (dedupe key prevents concurrent doubles; a retried job after partial upload simply re-uploads).
- Cost/priority: `priorityProcessingEnabled` (Pro) → higher BullMQ priority, not separate infrastructure.

## 10. Storage lifecycle & cleanup (`cleanup` jobs)

- Soft-deleted recordings: hard purge after 30 days — delete R2 objects listed from `video_assets`, then rows.
- `rejected_limit` sources: purge after 7-day grace.
- Orphan scan (weekly): list R2 prefixes vs `video_assets`; objects with no row and age > 7d → delete (report first run, delete after manual confirmation during migration). *(T-602: implemented report-only in `maintenance.cleanup` — `cleanup:orphans:<ISO week>` job, result carries counts + a 50-key sample; deletion stays manual until confirmed.)*
- Scratch + incomplete multiparts as in `06` §11.

## 11. What Cloudinary did that we must not forget to replace

| Cloudinary feature in current code | Replacement |
|---|---|
| `so_0` jpg thumbnail URL rewriting (`index.js:498`) | poster/thumb assets |
| `fl_attachment` download URLs (`Watch.jsx:652-654`) | signed GET with `response-content-disposition=attachment` |
| mp3 derivative for STT (`index.js:347`) | `audio_extract` job |
| splice transforms for trim/compose/stitch | render jobs (`14`) |
| Gmail play-button composite image (`gmail.js:15-20`) | pre-rendered `poster_play.jpg` variant produced by the thumbnail job (poster + ▶ overlay via ffmpeg drawtext/overlay), so email HTML keeps working |
| eventual-consistency workarounds | gone — Postgres reads |
