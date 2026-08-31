# 26 — Claude Code Implementation Rules

> Operating rules for every future Claude Code session (and any engineer) working on VeoRec. These are binding. When a user request conflicts with a rule, say so and propose the compliant alternative before writing code.

---

## 1. Before touching code

1. **Read the relevant docs first.** Minimum: `00`, then the doc(s) covering the subsystem you're changing (map in `README.md`). For recorder/upload work, `03` + `05` + `06` are mandatory reading. Do not code from memory of "how Loom-like apps work".
2. **Find the task.** Work should map to a task ID in `24-IMPLEMENTATION-PLAN.md` (or a bugfix). If it doesn't, either add a task (small PR to the doc) or question the work.
3. **Check the migration phase.** During migration (`23`), features listed as frozen in Phase 0 get bugfixes only. Don't "improve while you're in there."
4. **Search the codebase rather than assuming.** The audit (`01`) documents why: this codebase has non-obvious load-bearing hacks (legacy tabCapture constraint shapes, AudioContext resume dances, timer-throttling defenses). Verify current behavior before changing it.

## 2. Architectural invariants (violations are bugs, even if tests pass)

The 18 invariants in `02` §11, restated as prohibitions:

1. Do not bypass PostgreSQL — never answer an application question from storage listings, Redis, or an external API.
2. Do not add JSON-file persistence. Ever. (During migration, legacy stores are write-mirrored only per `23`.)
3. Do not send video bytes through the application server. If an endpoint you're writing accepts a video body, stop — use the upload protocol (`06`).
4. Do not keep recording data only in memory — every chunk hits IndexedDB first (`05`).
5. Do not represent recorder lifecycle with new booleans. Extend the state machine (`03`): new state or new event, with tests, or don't do it.
6. Do not run heavy work in HTTP handlers and do not fire-and-forget critical processing. Anything that must survive a restart is a queue job with a `processing_jobs` row (`10`).
7. Make every retryable operation idempotent — dedupe keys for jobs, Idempotency-Key or natural idempotency for endpoints, canonical-result replay for completion.
8. Never trust client metadata (duration, size, mime, dimensions). Store hints as hints; write facts only from FFprobe.
9. Keep source media immutable. Edits produce new assets; "overwrite" re-points, never rewrites (`14`).
10. AI/transcription failures must never block or degrade video availability.
11. Billing state changes never mutate recordings; billing webhooks go through the `billing_events` ledger (`16` §6).
12. Every listener/timer/stream/lock you create registers a disposer (`03` §10). If you can't say where it's cleaned up, you're not done.
13. Enforce entitlements server-side at the authoritative point (upload complete / post-probe / feature endpoints) — UI checks are UX, not security.
14. Privacy is enforced at the media URL level (signed URLs), not just on metadata endpoints (`12`).

## 3. Change discipline

- **Never blindly patch symptoms.** The legacy codebase is a museum of symptom patches (client 404-retry loops, dual Search+Admin merges, 12s player timeouts) — each papered over a root cause named in `01` §9. Find the cause; if the fix belongs in a later migration phase, file it against that phase rather than adding another workaround.
- **Small, reversible commits.** One task/one concern per PR. Migrations additive. Feature-flag user-facing cutovers. No broad unrelated refactors riding along ("drive-by cleanups" are separate PRs, and rare).
- **Do not remove working functionality without documenting it** — in the PR description and, if it changes a contract, in the spec doc. The feature parity gate (`25` §Product completeness) is checked against `01` §1's inventory.
- **Do not change architecture without updating the documentation in the same PR.** The docs are canonical; divergence is a defect. If you discover the doc is wrong, fix the doc (with a note) — don't silently code around it.
- **Do not introduce a dependency without justifying it in the PR** (what it replaces, size, maintenance status, why not stdlib/existing). The extension stays zero-runtime-dependency.
- **Keep error codes stable** (`18` §1). New failure modes get new codes registered in `18`, not reused ones.
- **Keep user-facing copy.** Existing warning/error texts are deliberately written (audio warnings, upgrade prompts). Reuse them; don't paraphrase.

## 4. Testing requirements

- Add tests for **failure paths, not just happy paths** — the failure behavior is the specification here (`18`, `20`). A PR touching upload/recorder/processing without failure-path tests is incomplete.
- Recorder or upload changes require the affected rows of the recorder matrix (`20` §9) to run before release; changes to the machine require transition-coverage updates.
- Idempotency claims require a run-twice test.
- Never weaken or delete a test to make a change pass; renegotiate the spec first.

## 5. Data & migration safety

- Never edit production data by hand; write an idempotent script, test on a copy, keep it in `apps/api/src/migration/`.
- Destructive migrations (drops, deletes) only in Phase 14 tasks, with the observation windows `23` requires.
- Respect dual-write windows: while a subsystem is dual-written, changes must update **both** paths or the reconciliation report will flag you.

## 6. Working style in this repo

- TypeScript for all new code; legacy JS files get types when substantially edited, not in drive-by PRs.
- Match surrounding code style; comments explain constraints ("legacy `mandatory` shape is REQUIRED for tabCapture"), not narration.
- Log with structured fields + correlation ids (`19` §1–2); never `console.log` in new server/worker code; respect redaction rules (`17` §10).
- All config via validated env; no hardcoded URLs (the extension currently hardcodes the API origin in three files — being fixed in T-104-era work; don't add a fourth).
- Commit messages reference task IDs (`T-303: extension multipart uploader`).

## 7. When uncertain

- If the docs are ambiguous about behavior you must implement, prefer: (1) the invariant list, (2) the most conservative interpretation for data safety (never lose a recording), (3) ask the user. "The recording is never lost" outranks every other consideration in this product.
- If you find a real conflict between two docs, flag it in the PR and fix both.

## 8. Session checklist (copy into your plan)

```
[ ] Read the docs for the subsystem I'm changing
[ ] Identified task ID / filed one
[ ] Verified current behavior by reading the code, not assuming
[ ] Change respects all §2 invariants
[ ] Failure-path tests added
[ ] Idempotency proven where claimed
[ ] Docs updated in the same PR if any contract changed
[ ] No new dependencies without justification
[ ] Structured logging + ids on new paths
[ ] Small, reversible, flagged if user-facing
```
