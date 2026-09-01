// Reconciliation report (T-104).
//
// Every entity gets the same counter shape so a run can be checked at a glance
// and diffed between runs. The importer FAILS LOUDLY: `failed` and `orphan` are
// first-class outcomes that are never folded into `imported`.
'use strict';

const COUNTERS = ['source', 'imported', 'alreadyImported', 'skipped', 'conflict', 'orphan', 'unmappedMedia', 'failed'];

class ImportReport {
  constructor({ dryRun }) {
    this.dryRun = dryRun;
    this.startedAt = new Date();
    this.finishedAt = null;
    this.entities = {};
    this.problems = [];       // orphans, conflicts, failures — with enough detail to act on
    this.notes = [];          // fidelity notes: data deliberately not imported
  }

  entity(name) {
    if (!this.entities[name]) {
      this.entities[name] = Object.fromEntries(COUNTERS.map((c) => [c, 0]));
    }
    return this.entities[name];
  }

  count(name, counter, n = 1) {
    const e = this.entity(name);
    if (!(counter in e)) throw new Error(`unknown report counter: ${counter}`);
    e[counter] += n;
  }

  /** Record something a human must look at. Never silently swallowed. */
  problem(kind, entity, key, detail) {
    this.problems.push({ kind, entity, key, detail: String(detail || '').slice(0, 500) });
    if (COUNTERS.includes(kind)) this.count(entity, kind);
  }

  note(text) { this.notes.push(text); }

  get totals() {
    const t = Object.fromEntries(COUNTERS.map((c) => [c, 0]));
    for (const e of Object.values(this.entities)) for (const c of COUNTERS) t[c] += e[c];
    return t;
  }

  /** True when the run had outcomes that need a human decision. */
  get hasProblems() {
    const t = this.totals;
    return t.failed > 0 || t.orphan > 0 || t.conflict > 0;
  }

  finish() { this.finishedAt = new Date(); return this; }

  toJSON() {
    return {
      dryRun: this.dryRun,
      startedAt: this.startedAt.toISOString(),
      finishedAt: this.finishedAt ? this.finishedAt.toISOString() : null,
      entities: this.entities,
      totals: this.totals,
      problems: this.problems,
      notes: this.notes,
    };
  }

  format() {
    const pad = (s, n) => String(s).padEnd(n);
    const num = (n) => String(n).padStart(10);   // wider than the longest header word
    const lines = [];
    lines.push('');
    lines.push(this.dryRun
      ? '── DRY RUN — no database writes were performed ─────────────────────────'
      : '── IMPORT COMPLETE ─────────────────────────────────────────────────────');
    lines.push('');
    lines.push(`${pad('entity', 22)}${COUNTERS.map((c) => num(c === 'alreadyImported' ? 'already' : c === 'unmappedMedia' ? 'unmapped' : c)).join('')}`);
    lines.push("-".repeat(22 + COUNTERS.length * 10));
    for (const [name, e] of Object.entries(this.entities)) {
      lines.push(`${pad(name, 22)}${COUNTERS.map((c) => num(e[c])).join('')}`);
    }
    lines.push("-".repeat(22 + COUNTERS.length * 10));
    const t = this.totals;
    lines.push(`${pad('TOTAL', 22)}${COUNTERS.map((c) => num(t[c])).join('')}`);
    if (this.notes.length) {
      lines.push('');
      lines.push('Notes (data deliberately not imported):');
      for (const n of this.notes) lines.push(`  · ${n}`);
    }
    if (this.problems.length) {
      lines.push('');
      lines.push(`Problems requiring attention (${this.problems.length}):`);
      for (const p of this.problems.slice(0, 50)) {
        lines.push(`  ! [${p.kind}] ${p.entity} ${p.key}: ${p.detail}`);
      }
      if (this.problems.length > 50) lines.push(`  … and ${this.problems.length - 50} more (see --json)`);
    }
    lines.push('');
    return lines.join('\n');
  }
}

module.exports = { ImportReport, COUNTERS };
