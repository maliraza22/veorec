# 14 — Video Editor

> Editing system: trim, split, delete-range, reorder, multi-clip stitching, silence removal. Keeps the existing timeline UX (`Editor.jsx`, audited `01` §6) and replaces the synchronous Cloudinary splice backend with edit sessions + render jobs. Source immutability is absolute (invariant #13).

---

## 1. Concepts

- **Virtual edit** — `trim_start/trim_end/segments` on the recording; the player skips gaps client-side. Instant, free, reversible. Unchanged from today.
- **Edit session** (`edit_sessions`) — a draft timeline: ordered clips `[{recordingId, start, end}]`, possibly spanning multiple owned recordings. This is the **edit decision list (EDL)**: edits are structured operations over an immutable source, previewed client-side instantly (virtual skip in the player/editor) — the expensive server render happens **only** on explicit export/save, never on every timeline change.
- **Render job** — bakes a timeline into a real file via FFmpeg (worker), producing a `render_output` asset. `mode: 'overwrite'` (result becomes the recording's active video) or `'copy'` (result becomes a new recording).
- **Immutability**: the `source` asset is never modified or deleted by editing. "Overwrite" re-points which derived asset the player serves — the original bytes remain until the recording itself is deleted. This converts today's scary rename-over-original (`index.js:1150-1167`) into a reversible pointer swap.

## 2. Editor operations

| Op | Timeline effect | Persisted as |
|---|---|---|
| trim | clip.in/out change | op `{type:'trim', clipIdx, in, out}` |
| split at playhead | clip → two clips at offset | `{type:'split', clipIdx, at}` |
| delete range / delete clip | remove clip | `{type:'delete', clipIdx}` |
| reorder (drag) | move clip | `{type:'reorder', from, to}` |
| add clip (gallery/upload) | append `{recordingId,0,dur}` | `{type:'add_clip', recordingId}` — uploads go through the standard upload protocol (`06` §12), then processing, then become addable |
| remove silences | replace base clips with keep-ranges | `{type:'apply_ranges', ranges}` (ranges from the silence job, §7) |

Constraints: ≤ 40 clips (as `index.js:1196`); clip bounds validated against the **probed** duration of each referenced recording; every referenced recording must be owned (`authorize` per clip) and `status='ready'`.

## 3. Edit session lifecycle & undo/redo

```mermaid
stateDiagram-v2
    [*] --> draft : POST /edit-sessions
    draft --> draft : PATCH ops (append edit_operations)
    draft --> rendering : POST /render
    rendering --> applied : render done (overwrite)
    rendering --> draft : render failed (timeline kept)
    draft --> discarded : discard
    applied --> [*]
```

- Undo/redo is client-side over the op list; each PATCH stores the op (`edit_operations`) so a session reopens exactly where it was left and the history is auditable. Server keeps the **current** timeline materialized on the session row (ops are the log, timeline is the state — no replay needed to read).
- Only one `rendering` session per recording at a time (409 otherwise).
- Multi-clip timelines (any clip ≠ base recording) require Pro `clipStitchEnabled` — checked at render, matching today's gate.
- Output-duration entitlement: `canRecord(user, timelineDuration)` at render enqueue (as today at `index.js:1104-1105`).

## 4. Saving semantics

- **Pure virtual save** (single-recording timeline, no renders wanted): PATCH `/recordings/:id/meta {segments|trimStart|trimEnd}` — unchanged instant path. Full-length timeline clears virtual edits (as `Editor.jsx:226-231`).
- **Render — copy**: new recording row (`source_kind='render'`, status `processing`), render job output registered as its primary asset (`counts_toward_quota=true`). **Quota**: a copy render takes the same atomic reservation as an upload at render enqueue (`16` §4.3, via `storage_reservations.render_job_id`) — 403 `storage_limit`/`video_limit` before any rendering happens; reconciled to the real output size in the completion tx. Title: `"<base title> (edited)"`.
- **Render — overwrite**: render output becomes the recording's active `mp4` asset (old derived assets kept 7 days then cleaned); virtual edits cleared; `duration/size_bytes` updated from the render's probe; usage delta = new − old active. Transcript/chapters are marked stale (`transcripts.status` unchanged but a `stale=true` flag surfaces "re-transcribe?" in the UI — cheaper and more honest than silently keeping timestamps that no longer align).

## 5. Render job (FFmpeg — worker; job contract in `10` §3)

1. Resolve each clip to its recording's best asset (prefer normalized MP4; source if MP4 missing).
2. Plan:
   - **Single-source, cuts only**: try keyframe-aligned stream copy (`-ss/-to -c copy` per segment → concat demuxer). If cut points aren't within 250ms of keyframes, re-encode that segment only (mixed concat), else full re-encode fallback. This makes the common trim fast and lossless.
   - **Multi-source**: full re-encode on a common canvas — target = base recording's dimensions, capped 1920 long edge, even-snapped; every input letterbox-padded (`scale=…:force_original_aspect_ratio=decrease,pad=…`) — porting the hard-won canvas rules from `index.js:1204-1240`. Audio: resample all to 48kHz stereo AAC; missing-audio clips get silent audio (`anullsrc`) so concat A/V stays aligned.
3. `-progress` → job progress (editor progress bar becomes real; today it is indeterminate).
4. Verify output (ffprobe: duration ≈ Σ clip lengths ±2%), upload to `renders/…`, register asset, apply mode semantics (§4) in one tx.

Failure: `render_jobs.failed` + error surfaced in the editor; timeline intact; sources untouched. Retryable.

## 6. Timeline UI notes (kept from `Editor.jsx`)

Multi-clip horizontal timeline; drag-reorder; split/delete; add via gallery picker or upload; per-clip preview by swapping the single `<video>` src with the stale-load guard (`Editor.jsx:87-98` — keep that guard). New: op-based undo/redo buttons; render progress %; "virtual vs rendered" indicator so users understand instant-save vs bake.

## 7. Silence removal

Becomes a job (`08` §11): prefer **audio-based** silence detection in the worker (`ffmpeg silencedetect` on the extracted audio — reusing `transcription.js:125-139` parsing) with transcript-gap fallback, padding/min-gap parameters as today (`index.js:1280-1295`: pad 0.2s, minGap 0.8s). Result = keep-ranges applied as a **virtual** edit (instant, reversible), with "bake permanently" going through a render. Matches current UX promise (`Watch.jsx:289-300`).

## 8. Render failure taxonomy (→ `18`)

`render_source_missing`, `render_ffmpeg_failed` (stderr tail captured), `render_verify_failed`, `render_timeout`, `render_disk_full` (worker refuses/delays), `render_forbidden_clip` (ownership/status). All leave the draft session intact.
