# 22 — Data Flows (Sequence Diagrams)

> Canonical sequence diagrams for the target architecture. Participants: `POP` popup, `REC` recorder window (state machine), `OV` overlay, `IDB` IndexedDB, `API`, `PG` Postgres, `R2` object storage, `Q` queue, `W` worker, `WEB` web app, `CDN`.

## 1. Starting a recording

```mermaid
sequenceDiagram
    participant U as User
    participant POP
    participant SW as service worker
    participant REC
    participant IDB
    participant API
    U->>POP: choose options, click Start
    POP->>POP: tab mode? getMediaStreamId (gesture)
    POP->>SW: recOptions → storage; inject overlay
    POP->>REC: open recorder window
    REC->>API: GET /me/entitlements (limit; cached fallback)
    REC->>REC: START(config) → acquiring
    REC->>REC: acquire display/tab/cam/mic + mix audio
    REC->>IDB: create session row (status recording)
    REC->>API: POST /recordings → recordingId
    REC->>API: POST /uploads → uploadSessionId, partSize
    REC->>REC: countdown → MediaRecorder.start(1000)
```

## 2. Screen capture

```mermaid
sequenceDiagram
    participant REC
    participant CH as Chrome
    REC->>CH: getDisplayMedia({video:{displaySurface:'monitor'}, audio:true, systemAudio:'include'})
    CH-->>REC: user picks surface → MediaStream(video[, audio])
    REC->>REC: track.ended listener → STOP(track_ended)
    REC->>REC: read track settings (actual surface/size — hint ≠ result)
```

## 3. Camera capture

```mermaid
sequenceDiagram
    participant OV as overlay (page)
    participant BUB as bubble.html iframe (ext origin)
    participant CH as Chrome
    OV->>BUB: create iframe (camera bubble mode)
    BUB->>CH: getUserMedia({video:480x480}) — extension-origin permission, granted once
    CH-->>BUB: cam stream → <video>
    Note over BUB: visibilitychange hidden→stop / visible→start (one tab holds the camera)
    Note over OV: bubble is DOM → captured because it's on the recorded surface
```

## 4. Audio mixing

```mermaid
sequenceDiagram
    participant REC
    participant AC as AudioContext
    REC->>AC: create; sources: displayAudio?, mic?
    REC->>AC: sources → MediaStreamDestination (mixed track)
    alt tab mode
        REC->>AC: tabSource → destination (speakers) — tabCapture mutes tab locally
    end
    REC->>AC: await resume(); onstatechange → re-resume
    REC->>REC: finalStream = [videoTrack, mixedAudioTrack]
```

## 5. Pausing

```mermaid
sequenceDiagram
    participant OV
    participant REC
    OV->>REC: SR_PAUSE
    REC->>REC: PAUSE → mediaRecorder.pause(); pauseStartedAt=now
    REC->>REC: persist recSession {paused:true} → storage + IDB heartbeat
    OV->>OV: reads projection → timer frozen, icon=play
```

## 6. Resuming

```mermaid
sequenceDiagram
    participant OV
    participant REC
    OV->>REC: SR_PAUSE (toggle)
    REC->>REC: RESUME → mediaRecorder.resume(); pausedTotal += now-pauseStartedAt
    REC->>REC: persist projection {paused:false}
```

## 7. Stopping

```mermaid
sequenceDiagram
    participant U as User/overlay/track-ended/limit
    participant REC
    participant IDB
    U->>REC: STOP(source)
    REC->>REC: state=stopping → mediaRecorder.stop() (tracks NOT stopped yet)
    REC-->>REC: final dataavailable(s) → chunk pipeline
    REC->>REC: onstop → stop tracks, close AudioContext, release wakelock
    REC->>IDB: finalize: last part sealed, session status=stopped, clientDuration
    REC->>REC: state=uploading (drain remaining parts)
```

## 8. Local persistence (during recording)

```mermaid
sequenceDiagram
    participant MR as MediaRecorder
    participant REC
    participant IDB
    participant R2
    loop every 1s timeslice
        MR->>REC: dataavailable(blob)
        REC->>IDB: put chunks{sessionId, seq, bytes}  (always first)
        REC->>REC: buffer += blob; if ≥ partSize → seal part
        REC->>IDB: put parts{n, pending}
        REC->>R2: PUT part (2 concurrent max while recording)
        REC->>IDB: parts{n, uploaded, etag}
    end
```

## 9. Upload initialization

```mermaid
sequenceDiagram
    participant REC
    participant API
    participant PG
    participant R2
    REC->>API: POST /uploads {recordingId, mimeType} + Idempotency-Key
    API->>PG: advisory entitlement checks; existing active session? → return it
    API->>R2: CreateMultipartUpload(sources/{recId}/source.webm)
    API->>PG: insert upload_sessions(active)
    API-->>REC: {uploadSessionId, partSize:8MiB, expiresAt:+48h}
```

## 10. Multipart upload (part flow)

```mermaid
sequenceDiagram
    participant REC
    participant API
    participant R2
    participant PG
    REC->>API: POST /uploads/:id/parts {partNumbers:[n..n+2]} (prefetch)
    API-->>REC: presigned PUT urls (1h TTL, crc32c-bound)
    REC->>R2: PUT part n (Content-Length, checksum)
    R2-->>REC: 200 + ETag
    REC->>API: PUT /uploads/:id/parts/n {etag,size,crc32c}
    API->>PG: upsert upload_parts (idempotent)
```

## 11. Upload retry

```mermaid
sequenceDiagram
    participant REC
    participant R2
    participant API
    REC->>R2: PUT part n
    R2--xREC: network error / 5xx / timeout
    REC->>REC: backoff = rand(0, min(60s, 1s·2^attempt))
    alt signature expired
        REC->>API: re-request part URL (free)
    end
    REC->>R2: PUT part n (same bytes — idempotent)
    Note over REC: 8 attempts → stalled banner → retry drain every 60s
```

## 12. Upload completion

```mermaid
sequenceDiagram
    participant REC
    participant API
    participant R2
    participant PG
    participant Q
    REC->>API: POST /uploads/:id/complete {parts manifest, clientDuration}
    API->>PG: BEGIN; session FOR UPDATE
    alt already completed
        API-->>REC: 200 canonical result (idempotent replay)
    else
        API->>R2: CompleteMultipartUpload; HEAD size check
        API->>PG: session=completed; recording=uploaded; asset(source);\nentitlement check (count/storage); usage tx; outbox probe job; COMMIT
        API-->>REC: 200 {recordingId, watchUrl}
    end
    Q-->>Q: relay enqueues probe
    REC->>REC: delete IDB session (only after 200)
```

## 13. Processing

```mermaid
sequenceDiagram
    participant Q
    participant W
    participant R2
    participant PG
    Q->>W: probe{recordingId}
    W->>R2: download source → ffprobe verify
    W->>PG: duration/dims; source asset ready; post-probe limit check
    W->>Q: fan-out transcode, thumbnail, (hls), audio_extract
    par
        Q->>W: transcode → mp4 (+faststart) → R2 → asset ready
    and
        Q->>W: thumbnail → poster/thumb/preview → R2 → assets
    and
        Q->>W: audio_extract → stt.transcribe → ai.* chain
    end
    W->>PG: maybe_mark_ready (mp4+poster) → recordings.status=ready
```

## 14. Playback

```mermaid
sequenceDiagram
    participant V as Viewer
    participant WEB
    participant API
    participant PG
    participant CDN
    participant R2
    V->>WEB: /watch/:id
    WEB->>API: GET /watch/:id → payload (status, meta)
    alt status != ready
        WEB->>API: poll GET /recordings/:id/status → processing UI
    end
    WEB->>API: GET /watch/:id/media
    API->>PG: authorize (privacy/share token/lead gate)
    API-->>WEB: signed {mp4Url|hlsUrl, posterUrl, expiresAt}
    WEB->>CDN: GET media → R2 (signature verified)
    WEB->>API: POST /watch/:id/view {visitorId} → view_sessions upsert
    WEB--)API: sendBeacon /progress on leave → max_progress
```

## 15. Sharing

```mermaid
sequenceDiagram
    participant O as Owner
    participant API
    participant PG
    participant V as Recipient
    O->>API: POST /recordings/:id/share-links {password?, expiresAt?, maxViews?}
    API->>PG: insert share_links (token hashed) → url shown once
    O->>V: send /watch/:id?s=token
    V->>API: GET /watch/:id?s=token
    API->>PG: link valid (not revoked/expired/over-max)? satisfies privacy
    API-->>V: WatchPayload → media flow (14)
    O->>API: DELETE /share-links/:id (revoke) → future mints refused
```

## 16. Comments

```mermaid
sequenceDiagram
    participant V as Viewer
    participant API
    participant PG
    participant O as Owner (later)
    V->>API: POST /watch/:id/comment {text, name?, t?, parentId?}
    API->>PG: audience.comments? rate limit ok? → insert comments
    API-->>V: Comment → optimistic UI reconciles
    O->>API: GET /notifications
    API->>PG: comments/reactions/views newer than last_read, actor != owner
    API-->>O: feed + unread count
```

## 17. Transcription

```mermaid
sequenceDiagram
    participant O as Owner (or auto-chain)
    participant API
    participant Q
    participant W
    participant GROQ as Groq
    participant PG
    O->>API: POST /recordings/:id/transcribe → 202 {jobId}
    API->>PG: transcripts.status=queued (outbox job)
    Q->>W: stt.transcribe
    W->>W: audio → wav → VAD chunks
    loop per chunk (paced ≤20 RPM)
        W->>GROQ: whisper verbose_json (auto-detect)
    end
    W->>GROQ: pass 2 — force dominant language on spurious chunks
    W->>PG: transcripts=done + segments; chain captions/ai jobs
    O->>API: poll transcript → done
```

## 18. Editing (render)

```mermaid
sequenceDiagram
    participant O as Owner (Editor UI)
    participant API
    participant PG
    participant Q
    participant W
    participant R2
    O->>API: POST /recordings/:id/edit-sessions {timeline}
    O->>API: PATCH ops (split/reorder/…) → edit_operations
    O->>API: POST /edit-sessions/:id/render {mode}
    API->>PG: render_jobs + outbox; 202 {renderJobId}
    Q->>W: render.render_edit
    W->>R2: fetch clip assets → ffmpeg cut/concat (sources untouched)
    W->>R2: upload render output; verify probe
    W->>PG: asset render_output; overwrite→repoint active mp4 / copy→new recording; usage tx
    O->>API: poll render job → done → navigate
```

## 19. Deletion

```mermaid
sequenceDiagram
    participant O as Owner
    participant API
    participant PG
    participant Q
    participant W
    participant R2
    O->>API: DELETE /recordings/:id
    API->>PG: tx: deleted_at=now; usage −(size,count,duration); audit log
    API-->>O: {ok} (idempotent)
    Note over PG: watch/media immediately 404
    Q->>W: maintenance.cleanup (daily)
    W->>PG: recordings deleted >30d → collect asset keys
    W->>R2: delete objects
    W->>PG: hard-delete rows (cascade)
```
