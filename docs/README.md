# VeoRec Documentation Package

> Canonical specification for rebuilding VeoRec (a Loom-style screen-recording platform) from the existing prototype at `C:\Users\DELL\ScreenRecorder` into a production-grade system. Produced 2026-09-01 from a full audit of the actual codebase.
>
> **These documents are the source of truth.** Code that disagrees with them is either legacy awaiting migration or a defect. Changes to architecture require changing the docs in the same PR (`26` §3).

---

## Current project status

- The existing app (extension + React web app + Express server) is **feature-complete but architecturally unsound**: Cloudinary is used as the database, recordings exist only in RAM until a single monolithic upload succeeds, all persistence is JSON files, and processing is synchronous or fire-and-forget. Full audit: `01`.
- Target: PostgreSQL as source of truth, direct-to-R2 resumable uploads, IndexedDB crash recovery, an explicit recorder state machine, BullMQ/FFmpeg workers, signed playback URLs. Full architecture: `02`.
- Nothing has been rebuilt yet. Implementation follows the migration plan (`23`) and task list (`24`) — **no big-bang rewrite**.

## Reading order

**Everyone, first:** `00` → `01` → `02` (and `26` before writing any code).

**Then by role/subsystem:**

| Working on… | Read |
|---|---|
| Recorder / capture | `03` → `05` → `06` → `04` → `21` |
| Upload | `06` → `05` → `07` (§upload tables) → `18` |
| Backend API | `08` → `07` → `12` → `18` → `17` |
| Processing / workers | `09` → `10` → `15` |
| Watch page / player | `11` → `12` → `13` |
| Editor | `14` → `09` |
| Billing / plans | `16` → `07` (§billing) |
| Testing / release | `20` → `25` |
| Ops | `19` → `17` |
| Planning work | `23` → `24` |

## Document index

| # | Document | Contents |
|---|---|---|
| 00 | [Executive Summary](00-EXECUTIVE-SUMMARY.md) | Product, condition, decisions, stack, rebuild strategy, risks |
| 01 | [Current Codebase Audit](01-CURRENT-CODEBASE-AUDIT.md) | What exists today, file-by-file, with root causes and keep/replace verdicts |
| 02 | [Architecture](02-ARCHITECTURE.md) | Target system architecture, component boundaries, tech decisions, **the 18 invariants** |
| 03 | [Recording Engine Specification](03-RECORDING-ENGINE-SPECIFICATION.md) | The recorder state machine: states, events, capture, mixing, limits, cleanup |
| 04 | [Extension Architecture](04-EXTENSION-ARCHITECTURE.md) | MV3 components, lifecycle rules, typed message protocol, storage keys |
| 05 | [Local Recovery (IndexedDB)](05-LOCAL-RECOVERY-INDEXEDDB.md) | Chunk durability, session/parts schema, crash recovery flow |
| 06 | [Upload Protocol](06-UPLOAD-PROTOCOL.md) | Direct-to-storage multipart: sessions, presigning, retries, idempotent completion |
| 07 | [Database Design](07-DATABASE-DESIGN.md) | Full PostgreSQL schema, every table, ER diagram, migration sources |
| 08 | [API Specification](08-API-SPECIFICATION.md) | REST /api/v1: every endpoint, contracts, errors, idempotency |
| 09 | [Media Processing](09-MEDIA-PROCESSING.md) | FFprobe verification, transcoding, thumbnails, HLS, storage lifecycle |
| 10 | [Jobs and Queues](10-JOBS-AND-QUEUES.md) | BullMQ + outbox, the job catalog with retry/timeout/idempotency per job |
| 11 | [Watch Page & Player](11-WATCH-PLAYER.md) | Page states, media resolution, player behavior, error handling |
| 12 | [Sharing, Privacy & Authorization](12-SHARING-PRIVACY-AUTHORIZATION.md) | Privacy levels, share links, signed URLs, threat model |
| 13 | [Comments, Reactions & Analytics](13-COMMENTS-REACTIONS-ANALYTICS.md) | Engagement model, viewer sessions, owner analytics, privacy |
| 14 | [Video Editor](14-VIDEO-EDITOR.md) | Edit sessions, ops/undo, render jobs, source immutability |
| 15 | [Transcription & AI](15-TRANSCRIPTION-AI.md) | STT pipeline (VAD/Groq/whisper.cpp), AI features, failure isolation |
| 16 | [Billing, Usage & Entitlements](16-BILLING-USAGE-ENTITLEMENTS.md) | Plans, entitlements, Paddle, idempotent webhooks, usage accounting |
| 17 | [Security](17-SECURITY.md) | Auth/sessions, CORS, rate limits, upload security, secrets, isolation |
| 18 | [Error Handling](18-ERROR-HANDLING.md) | The error taxonomy: codes, retryability, recovery per layer |
| 19 | [Observability](19-OBSERVABILITY.md) | Structured logs, correlation ids, metrics, dashboards, alerts, KPIs |
| 20 | [Testing Strategy](20-TESTING-STRATEGY.md) | Test pyramid, the recorder test matrix, failure injection, load |
| 21 | [Browser Compatibility](21-BROWSER-COMPATIBILITY.md) | Support matrix, Chrome capture constraints the design encodes |
| 22 | [Data Flows](22-DATA-FLOWS.md) | 19 sequence diagrams for every major flow |
| 23 | [Migration Plan](23-MIGRATION-PLAN.md) | 15 strangler-fig phases with risks and acceptance criteria |
| 24 | [Implementation Plan](24-IMPLEMENTATION-PLAN.md) | Ordered task list (T-xxx) with tests and acceptance per task |
| 25 | [Definition of Done](25-DEFINITION-OF-DONE.md) | Production release checklist with evidence requirements |
| 26 | [Claude Code Implementation Rules](26-CLAUDE-CODE-IMPLEMENTATION-RULES.md) | Binding working rules for future sessions |

## Architecture rules (the short version)

Postgres owns state. R2 owns bytes. The API never carries video. Every chunk hits IndexedDB before it counts. The recorder is a state machine. Critical async work is a durable, idempotent, status-tracked job. Sources are immutable. Clients are hints; FFprobe is truth. AI and billing failures never take a video down. Everything cleans up after itself, everything has a recovery path, and every failure path has a test. (Full list with teeth: `02` §11.)

## Implementation order

Phase 0 freeze → 1 Postgres → 2 storage → 3 upload → 4 recovery → 5 state machine → 6 queue → 7 processing → 8 watch → 9 sharing → 10 engagement → 11 STT/AI → 12 editor → 13 billing/auth → 14 decommission legacy. Start at `24-IMPLEMENTATION-PLAN.md` T-001 and proceed in order; the editor, AI, billing internals, admin, and integrations are **frozen** until phases 1–7 are done.

## How future Claude Code sessions should use this package

1. Read `00`, `26`, and the subsystem docs for your task (table above). Don't code from general knowledge — this codebase's constraints are documented for reasons.
2. Locate (or add) your task ID in `24`; confirm its dependencies are merged and its phase is active in `23`.
3. Verify current behavior by reading the actual code (`01` maps it).
4. Implement within the invariants; add failure-path tests; update any doc whose contract you changed — in the same PR.
5. Check the session checklist at the end of `26` before finishing.
