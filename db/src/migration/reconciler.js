// ─────────────────────────────────────────────────────────────────────────────
// RECONCILIATION SAFETY NET (T-106)
//
// Proves that PostgreSQL stays convergent with the authoritative legacy system
// during the migration. This is the gate that must be clean before authority
// ever moves to PostgreSQL — not merely a status report.
//
// DETECTION FIRST. `mode: 'report'` (the default) performs ZERO writes. Repair
// is explicit, additive-only, and idempotent: it re-applies the same mappers
// the importer and the dual-write mirror use. **Nothing here ever deletes
// PostgreSQL data automatically** — records that look deleted in the legacy
// system are reported for a human decision, and even the opt-in repair for them
// only SOFT-deletes (reversible).
//
// Checks:
//   legacy_missing_in_pg    a legacy record has no mirrored row          (repairable)
//   field_drift             both sides exist but important fields differ (repairable)
//   stale_in_pg             a PG row whose legacy record is gone —
//                           i.e. an UNMIRRORED DELETE                    (never auto-repaired)
//   failed_dual_write       journal entries still outstanding            (repairable)
//   orphaned_child          child row whose logical parent is missing    (reported)
//   mapping_inconsistency   id not derivable from legacy, or ownership
//                           that disagrees with the legacy owner         (unsafe)
//   unsafe                  anything needing human judgement             (never repaired)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const { sql } = require('drizzle-orm');
const { openLegacySources } = require('./sources');
const mirrors = require('./mirrors');
const { idFor } = require('../legacy-ids');

const SEVERITY = { critical: 3, warning: 2, info: 1 };

class ReconcileReport {
  constructor({ mode, dataDir, hasMediaListing }) {
    this.mode = mode;
    this.dataDir = dataDir;
    this.hasMediaListing = hasMediaListing;
    this.startedAt = new Date();
    this.finishedAt = null;
    this.findings = [];
    this.counts = {};       // entity → { legacy, postgres }
    this.repairs = [];
    this.skippedChecks = [];
  }

  finding(check, { severity = 'warning', entity, legacyId = null, pgId = null, detail = '', repairable = false }) {
    this.findings.push({ check, severity, entity, legacyId, pgId, detail: String(detail).slice(0, 300), repairable });
  }

  count(entity, side, n) {
    if (!this.counts[entity]) this.counts[entity] = { legacy: 0, postgres: 0 };
    this.counts[entity][side] = n;
  }

  skip(check, why) { this.skippedChecks.push({ check, why }); }

  get byCheck() {
    const out = {};
    for (const f of this.findings) out[f.check] = (out[f.check] || 0) + 1;
    return out;
  }

  get worstSeverity() {
    return this.findings.reduce((w, f) => (SEVERITY[f.severity] > SEVERITY[w] ? f.severity : w), 'info');
  }

  get clean() { return this.findings.length === 0; }

  finish() { this.finishedAt = new Date(); return this; }

  toJSON() {
    return {
      mode: this.mode,
      startedAt: this.startedAt.toISOString(),
      finishedAt: this.finishedAt && this.finishedAt.toISOString(),
      clean: this.clean,
      counts: this.counts,
      byCheck: this.byCheck,
      worstSeverity: this.worstSeverity,
      skippedChecks: this.skippedChecks,
      repairs: this.repairs,
      findings: this.findings.slice(0, 500),
      totalFindings: this.findings.length,
    };
  }

  format() {
    const L = [];
    L.push('');
    L.push(this.mode === 'report'
      ? '── RECONCILIATION REPORT — read-only, no database writes ───────────────'
      : '── RECONCILIATION REPAIR — additive only, never deletes ────────────────');
    L.push('');
    L.push(`${'entity'.padEnd(24)}${'legacy'.padStart(10)}${'postgres'.padStart(10)}${'delta'.padStart(10)}`);
    L.push('-'.repeat(54));
    for (const [entity, c] of Object.entries(this.counts)) {
      const d = c.postgres - c.legacy;
      L.push(`${entity.padEnd(24)}${String(c.legacy).padStart(10)}${String(c.postgres).padStart(10)}${(d > 0 ? '+' + d : String(d)).padStart(10)}`);
    }
    L.push('');
    if (this.skippedChecks.length) {
      L.push('Checks SKIPPED (cannot be evaluated safely):');
      for (const s of this.skippedChecks) L.push(`  ~ ${s.check}: ${s.why}`);
      L.push('');
    }
    if (this.clean) {
      L.push('  ✓ No divergence detected — PostgreSQL matches the legacy system.');
    } else {
      L.push(`Findings (${this.findings.length}), worst severity: ${this.worstSeverity.toUpperCase()}`);
      for (const [check, n] of Object.entries(this.byCheck)) L.push(`  ${String(n).padStart(6)}  ${check}`);
      L.push('');
      const shown = this.findings.slice(0, 40);
      for (const f of shown) {
        L.push(`  [${f.severity}] ${f.check} ${f.entity} legacy=${f.legacyId ?? '-'} pg=${f.pgId ?? '-'}`);
        if (f.detail) L.push(`         ${f.detail}`);
      }
      if (this.findings.length > shown.length) L.push(`  … and ${this.findings.length - shown.length} more (use --json)`);
    }
    if (this.repairs.length) {
      L.push('');
      L.push(`Repairs applied (${this.repairs.length}):`);
      for (const r of this.repairs.slice(0, 40)) L.push(`  + ${r.action} ${r.entity} ${r.legacyId ?? r.pgId ?? ''}`);
    }
    const repairable = this.findings.filter((f) => f.repairable).length;
    const manual = this.findings.length - repairable;
    if (this.mode === 'report' && this.findings.length) {
      L.push('');
      L.push(`  ${repairable} finding(s) can be repaired automatically:  npm run db:reconcile -- --data-dir=… --repair`);
      if (manual) L.push(`  ${manual} finding(s) need a human decision — nothing is deleted automatically.`);
    }
    L.push('');
    return L.join('\n');
  }
}

const rows = (res) => (res && res.rows) ? res.rows : (res || []);
const norm = (v) => (v === undefined || v === null || v === '' ? null : String(v));
const numEq = (a, b) => {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return Math.abs(Number(a) - Number(b)) < 0.005;
};

/**
 * @param {object} o
 * @param {object} o.db            drizzle client
 * @param {string} o.dataDir       legacy JSON directory
 * @param {string|null} o.mediaListingFile
 * @param {'report'|'repair'} o.mode
 * @param {boolean} o.allowStaleSoftDelete  opt-in: soft-delete stale PG rows (never hard delete)
 */
async function reconcile({ db, dataDir, mediaListingFile = null, mode = 'report', allowStaleSoftDelete = false }) {
  const src = openLegacySources(dataDir, mediaListingFile);
  const report = new ReconcileReport({ mode, dataDir, hasMediaListing: !!mediaListingFile });
  const repairing = mode === 'repair';
  const repair = async (action, meta, fn) => {
    if (!repairing) return false;
    try { await fn(); report.repairs.push({ action, ...meta }); return true; }
    catch (err) {
      report.finding('repair_failed', { severity: 'critical', entity: meta.entity, legacyId: meta.legacyId,
        detail: err.message, repairable: false });
      return false;
    }
  };

  // ── Legacy side: build the authoritative view ───────────────────────────────
  const legacyUsers = new Map(src.users.filter((u) => u && u.id).map((u) => [u.id, u]));
  const legacyFolders = new Map(src.folders.filter((f) => f && f.id).map((f) => [f.id, f]));

  // Live recordings = anything an ownership-bearing source still knows about.
  // A legacy delete removes both the meta entry and the media asset, so a
  // recording absent from all three is genuinely gone.
  const legacyRecordings = new Map();
  for (const r of src.localRecordings) {
    if (r && r.id) legacyRecordings.set(r.id, { legacyId: r.id, legacyUserId: r.userId, title: r.title, duration: r.duration, size: r.size });
  }
  for (const m of src.mediaListing) {
    const ctx = (m && m.context && (m.context.custom || m.context)) || {};
    const parts = String(m && m.public_id || '').split('/');
    const legacyId = ctx.rec_id || parts[parts.length - 1];
    const legacyUserId = ctx.user_id || parts[parts.length - 2];
    if (!legacyId || /__(trim|compose)_\d+$/.test(String(m.public_id))) continue;
    const prev = legacyRecordings.get(legacyId) || {};
    legacyRecordings.set(legacyId, { ...prev, legacyId, legacyUserId: prev.legacyUserId || legacyUserId,
      title: prev.title || ctx.title, duration: prev.duration ?? m.duration, size: prev.size ?? m.bytes });
  }
  const metaIds = new Set(Object.keys(src.meta));

  report.count('users', 'legacy', legacyUsers.size);
  report.count('folders', 'legacy', legacyFolders.size);
  report.count('recordings', 'legacy', legacyRecordings.size);
  report.count('subscriptions', 'legacy', Object.keys(src.subscriptions).length);
  report.count('usage', 'legacy', Object.keys(src.usage).length);
  report.count('contacts', 'legacy', Object.keys(src.contacts).length);

  // ── PostgreSQL side ────────────────────────────────────────────────────────
  const pgUsers = new Map(rows(await db.execute(sql`SELECT id, email, name, manual_plan, paddle_customer_id, password_hash, deleted_at FROM users`)).map((r) => [r.id, r]));
  const pgFolders = new Map(rows(await db.execute(sql`SELECT id, user_id, name FROM folders`)).map((r) => [r.id, r]));
  const pgRecordings = new Map(rows(await db.execute(sql`SELECT id, user_id, title, privacy, description, folder_id, duration, size_bytes, archived, deleted_at FROM recordings`)).map((r) => [r.id, r]));
  const pgSubs = new Map(rows(await db.execute(sql`SELECT user_id, plan_slug, status, billing_cycle, cancel_at_period_end FROM subscriptions`)).map((r) => [r.user_id, r]));
  const pgUsage = new Map(rows(await db.execute(sql`SELECT user_id, storage_retained_bytes, active_video_count FROM usage`)).map((r) => [r.user_id, r]));
  const pgContacts = new Map(rows(await db.execute(sql`SELECT id, status FROM contacts`)).map((r) => [r.id, r]));

  report.count('users', 'postgres', pgUsers.size);
  report.count('folders', 'postgres', pgFolders.size);
  report.count('recordings', 'postgres', pgRecordings.size);
  report.count('subscriptions', 'postgres', pgSubs.size);
  report.count('usage', 'postgres', pgUsage.size);
  report.count('contacts', 'postgres', pgContacts.size);

  // ── 1. Legacy → PostgreSQL: missing rows and field drift ───────────────────
  for (const [legacyId, u] of legacyUsers) {
    const pgId = idFor('usr', legacyId);
    const row = pgUsers.get(pgId);
    if (!row) {
      report.finding('legacy_missing_in_pg', { entity: 'users', legacyId, pgId, repairable: true,
        detail: 'legacy user has no mirrored row' });
      await repair('upsert', { entity: 'users', legacyId }, () => mirrors.upsertUser(db, u));
      continue;
    }
    const diffs = [];
    if (norm(row.email) !== norm(String(u.email || '').toLowerCase())) diffs.push('email');
    if (norm(row.name) !== norm(u.name)) diffs.push('name');
    if (norm(row.manual_plan) !== norm(u.manualPlan)) diffs.push('manual_plan');
    if (norm(row.paddle_customer_id) !== norm(u.paddleCustomerId)) diffs.push('paddle_customer_id');
    if (norm(row.password_hash) !== norm(u.password)) diffs.push('password_hash');
    if (diffs.length) {
      report.finding('field_drift', { entity: 'users', legacyId, pgId, repairable: true,
        detail: `differs: ${diffs.join(', ')}` });
      await repair('upsert', { entity: 'users', legacyId }, () => mirrors.upsertUser(db, u));
    }
  }

  for (const [legacyId, f] of legacyFolders) {
    const pgId = idFor('fld', legacyId);
    const row = pgFolders.get(pgId);
    const ownerPgId = legacyUsers.has(f.userId) ? idFor('usr', f.userId) : null;
    if (!ownerPgId) {
      report.finding('unsafe', { severity: 'critical', entity: 'folders', legacyId, pgId, repairable: false,
        detail: `legacy folder references unknown user ${f.userId} — ownership cannot be resolved` });
      continue;
    }
    if (!row) {
      report.finding('legacy_missing_in_pg', { entity: 'folders', legacyId, pgId, repairable: true,
        detail: 'legacy folder has no mirrored row' });
      await repair('upsert', { entity: 'folders', legacyId }, () => mirrors.upsertFolder(db, f, ownerPgId));
      continue;
    }
    if (norm(row.user_id) !== norm(ownerPgId)) {
      report.finding('mapping_inconsistency', { severity: 'critical', entity: 'folders', legacyId, pgId,
        repairable: false, detail: `owner mismatch: pg=${row.user_id} legacy=${ownerPgId}` });
    } else if (norm(row.name) !== norm(f.name)) {
      report.finding('field_drift', { entity: 'folders', legacyId, pgId, repairable: true, detail: 'differs: name' });
      await repair('upsert', { entity: 'folders', legacyId }, () => mirrors.upsertFolder(db, f, ownerPgId));
    }
  }

  for (const [legacyId, r] of legacyRecordings) {
    const pgId = idFor('rec', legacyId);
    const row = pgRecordings.get(pgId);
    const meta = src.meta[legacyId] || {};
    const ownerPgId = legacyUsers.has(r.legacyUserId) ? idFor('usr', r.legacyUserId) : null;
    if (!ownerPgId) {
      report.finding('unsafe', { severity: 'critical', entity: 'recordings', legacyId, pgId, repairable: false,
        detail: `owner ${r.legacyUserId ?? '(none)'} not in legacy users — ownership is never guessed` });
      continue;
    }
    if (!row) {
      report.finding('legacy_missing_in_pg', { entity: 'recordings', legacyId, pgId, repairable: true,
        detail: 'legacy recording has no mirrored row' });
      await repair('upsert', { entity: 'recordings', legacyId }, () => mirrors.upsertRecording(db,
        { legacyId, ownerId: ownerPgId, title: r.title, duration: r.duration, sizeBytes: r.size,
          folderId: meta.folder && legacyFolders.has(meta.folder) ? idFor('fld', meta.folder) : null }, meta));
      continue;
    }
    if (norm(row.user_id) !== norm(ownerPgId)) {
      report.finding('mapping_inconsistency', { severity: 'critical', entity: 'recordings', legacyId, pgId,
        repairable: false, detail: `owner mismatch: pg=${row.user_id} legacy=${ownerPgId}` });
      continue;
    }
    if (row.deleted_at) {
      report.finding('unsafe', { severity: 'warning', entity: 'recordings', legacyId, pgId, repairable: false,
        detail: 'soft-deleted in PostgreSQL but still present in the legacy system' });
      continue;
    }
    const expectedPrivacy = ['public', 'login', 'password'].includes(meta.privacy) ? meta.privacy : 'public';
    const expectedFolder = meta.folder && legacyFolders.has(meta.folder) ? idFor('fld', meta.folder) : null;
    const diffs = [];
    if (r.title && norm(row.title) !== norm(r.title)) diffs.push('title');
    if (norm(row.privacy) !== norm(expectedPrivacy)) diffs.push('privacy');
    if (norm(row.description) !== norm(meta.description || '')) diffs.push('description');
    if (norm(row.folder_id) !== norm(expectedFolder)) diffs.push('folder_id');
    if (!!row.archived !== !!meta.archived) diffs.push('archived');
    if (r.duration != null && !numEq(row.duration, r.duration)) diffs.push('duration');
    if (r.size != null && !numEq(row.size_bytes, r.size)) diffs.push('size_bytes');
    if (diffs.length) {
      report.finding('field_drift', { entity: 'recordings', legacyId, pgId, repairable: true,
        detail: `differs: ${diffs.join(', ')}` });
      await repair('upsert', { entity: 'recordings', legacyId }, () => mirrors.upsertRecording(db,
        { legacyId, ownerId: ownerPgId, title: r.title, duration: r.duration, sizeBytes: r.size, folderId: expectedFolder }, meta));
    }
  }

  for (const [legacyUserId, s] of Object.entries(src.subscriptions)) {
    const ownerPgId = legacyUsers.has(legacyUserId) ? idFor('usr', legacyUserId) : null;
    if (!ownerPgId) {
      report.finding('unsafe', { severity: 'warning', entity: 'subscriptions', legacyId: legacyUserId,
        repairable: false, detail: 'subscription for a user that does not exist in the legacy store' });
      continue;
    }
    const row = pgSubs.get(ownerPgId);
    if (!row) {
      report.finding('legacy_missing_in_pg', { entity: 'subscriptions', legacyId: legacyUserId, pgId: ownerPgId,
        repairable: true, detail: 'legacy subscription has no mirrored row' });
      await repair('upsert', { entity: 'subscriptions', legacyId: legacyUserId },
        () => mirrors.upsertSubscription(db, ownerPgId, s, legacyUserId));
      continue;
    }
    const expectedStatus = ['active', 'trialing', 'past_due', 'paused', 'canceled'].includes(s.status) ? s.status : 'canceled';
    const diffs = [];
    if (norm(row.status) !== norm(expectedStatus)) diffs.push('status');
    if (norm(row.plan_slug) !== norm(s.planSlug || 'pro')) diffs.push('plan_slug');
    if (!!row.cancel_at_period_end !== !!s.cancelAtPeriodEnd) diffs.push('cancel_at_period_end');
    if (diffs.length) {
      report.finding('field_drift', { severity: 'critical', entity: 'subscriptions', legacyId: legacyUserId,
        pgId: ownerPgId, repairable: true, detail: `entitlement drift: ${diffs.join(', ')}` });
      await repair('upsert', { entity: 'subscriptions', legacyId: legacyUserId },
        () => mirrors.upsertSubscription(db, ownerPgId, s, legacyUserId));
    }
  }

  for (const [legacyUserId, u] of Object.entries(src.usage)) {
    const ownerPgId = legacyUsers.has(legacyUserId) ? idFor('usr', legacyUserId) : null;
    if (!ownerPgId) continue;                       // reported via subscriptions/users checks
    const row = pgUsage.get(ownerPgId);
    if (!row) {
      report.finding('legacy_missing_in_pg', { entity: 'usage', legacyId: legacyUserId, pgId: ownerPgId,
        repairable: true, detail: 'legacy usage record has no mirrored row' });
      await repair('upsert', { entity: 'usage', legacyId: legacyUserId }, () => mirrors.upsertUsage(db, ownerPgId, u));
      continue;
    }
    const diffs = [];
    if (!numEq(row.storage_retained_bytes, Math.max(0, Math.round(Number(u.storageUsedBytes) || 0)))) diffs.push('storage_retained_bytes');
    if (Number(row.active_video_count) !== Math.max(0, Number(u.videoCount) || 0)) diffs.push('active_video_count');
    if (diffs.length) {
      report.finding('field_drift', { entity: 'usage', legacyId: legacyUserId, pgId: ownerPgId, repairable: true,
        detail: `differs: ${diffs.join(', ')}` });
      await repair('upsert', { entity: 'usage', legacyId: legacyUserId }, () => mirrors.upsertUsage(db, ownerPgId, u));
    }
  }

  for (const c of Object.values(src.contacts)) {
    if (!c || !c.id) continue;
    const pgId = idFor('ctc', c.id);
    if (!pgContacts.has(pgId)) {
      report.finding('legacy_missing_in_pg', { severity: 'info', entity: 'contacts', legacyId: c.id, pgId,
        repairable: true, detail: 'legacy contact has no mirrored row' });
      await repair('upsert', { entity: 'contacts', legacyId: c.id },
        () => mirrors.upsertContact(db, c, c.userId && legacyUsers.has(c.userId) ? idFor('usr', c.userId) : null));
    }
  }

  // ── 2. PostgreSQL → legacy: stale rows / UNMIRRORED DELETES ────────────────
  // Only meaningful when we can enumerate the legacy side authoritatively.
  // Without a media listing every production recording would look "stale",
  // which could lead an operator to delete live data — so the check is skipped
  // loudly rather than run on incomplete inputs.
  const canDetectStaleRecordings = !!mediaListingFile || src.localRecordings.length > 0;
  if (!canDetectStaleRecordings) {
    report.skip('stale_in_pg (recordings)',
      'no media listing and no local recordings store — cannot distinguish a deleted recording from one this run simply cannot see. Re-run with --media-listing.');
  }

  for (const [pgId, row] of pgUsers) {
    const legacyId = pgId.replace(/^usr_/, '');
    if (!legacyUsers.has(legacyId)) {
      report.finding('stale_in_pg', { severity: 'warning', entity: 'users', legacyId, pgId, repairable: false,
        detail: 'user row exists in PostgreSQL but not in the legacy store (deleted in legacy, or never legacy)' });
    }
  }
  for (const [pgId, row] of pgFolders) {
    const legacyId = pgId.replace(/^fld_/, '');
    if (!legacyFolders.has(legacyId)) {
      report.finding('stale_in_pg', { severity: 'warning', entity: 'folders', legacyId, pgId, repairable: false,
        detail: 'folder deleted in the legacy system but still present in PostgreSQL (unmirrored delete)' });
    }
  }
  if (canDetectStaleRecordings) {
    for (const [pgId, row] of pgRecordings) {
      if (row.deleted_at) continue;                 // already soft-deleted — converged
      const legacyId = pgId.replace(/^rec_/, '');
      if (legacyRecordings.has(legacyId)) continue;
      const everKnown = metaIds.has(legacyId);
      report.finding('stale_in_pg', { severity: 'critical', entity: 'recordings', legacyId, pgId, repairable: false,
        detail: everKnown
          ? 'metadata still present but the media is gone — verify before acting'
          : 'recording deleted in the legacy system but still active in PostgreSQL (UNMIRRORED DELETE)' });
      if (allowStaleSoftDelete && repairing && !everKnown) {
        await repair('soft_delete', { entity: 'recordings', legacyId, pgId }, async () => {
          await db.execute(sql`UPDATE recordings SET deleted_at = now() WHERE id = ${pgId} AND deleted_at IS NULL`);
        });
      }
    }
  }

  // ── 3. Orphaned child records ──────────────────────────────────────────────
  const orphanChecks = [
    ['comments', sql`SELECT c.id, c.recording_id FROM comments c LEFT JOIN recordings r ON r.id = c.recording_id WHERE r.id IS NULL LIMIT 200`],
    ['reactions', sql`SELECT c.id, c.recording_id FROM reactions c LEFT JOIN recordings r ON r.id = c.recording_id WHERE r.id IS NULL LIMIT 200`],
    ['view_sessions', sql`SELECT c.id, c.recording_id FROM view_sessions c LEFT JOIN recordings r ON r.id = c.recording_id WHERE r.id IS NULL LIMIT 200`],
    ['leads', sql`SELECT c.id, c.recording_id FROM leads c LEFT JOIN recordings r ON r.id = c.recording_id WHERE r.id IS NULL LIMIT 200`],
    ['video_assets', sql`SELECT c.id, c.recording_id FROM video_assets c LEFT JOIN recordings r ON r.id = c.recording_id WHERE r.id IS NULL LIMIT 200`],
  ];
  for (const [entity, q] of orphanChecks) {
    for (const r of rows(await db.execute(q))) {
      report.finding('orphaned_child', { severity: 'critical', entity, pgId: r.id, repairable: false,
        detail: `parent recording ${r.recording_id} is missing` });
    }
  }
  // Children whose parent recording is soft-deleted are logically orphaned too.
  const softOrphans = rows(await db.execute(sql`
    SELECT count(*)::int AS n FROM comments c JOIN recordings r ON r.id = c.recording_id WHERE r.deleted_at IS NOT NULL`));
  if (Number(softOrphans[0].n) > 0) {
    report.finding('orphaned_child', { severity: 'info', entity: 'comments', repairable: false,
      detail: `${softOrphans[0].n} comment(s) attached to soft-deleted recordings (expected until purge)` });
  }

  // ── 4. Mapping inconsistencies ─────────────────────────────────────────────
  const badIds = [
    ['users', 'usr_', [...pgUsers.keys()]],
    ['folders', 'fld_', [...pgFolders.keys()]],
    ['recordings', 'rec_', [...pgRecordings.keys()]],
  ];
  for (const [entity, prefix, ids] of badIds) {
    for (const id of ids) {
      if (!String(id).startsWith(prefix)) {
        report.finding('mapping_inconsistency', { severity: 'critical', entity, pgId: id, repairable: false,
          detail: `id does not follow the deterministic legacy mapping (expected ${prefix}<legacyId>)` });
      }
    }
  }
  // Duplicate legacy emails would make user identity ambiguous.
  const dupEmails = rows(await db.execute(sql`
    SELECT email, count(*)::int AS n FROM users WHERE deleted_at IS NULL GROUP BY email HAVING count(*) > 1`));
  for (const d of dupEmails) {
    report.finding('unsafe', { severity: 'critical', entity: 'users', repairable: false,
      detail: `${d.n} live users share the email ${d.email} — identity is ambiguous, resolve manually` });
  }

  // ── 5. Outstanding failed dual-writes (T-105 journal) ──────────────────────
  const journalPath = path.join(dataDir, 'dual-write-failures.jsonl');
  if (fs.existsSync(journalPath)) {
    const entries = fs.readFileSync(journalPath, 'utf8').split('\n').filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    let outstanding = 0;
    for (const e of entries) {
      // A journal entry is satisfied if the record is now present; the checks
      // above already cover presence, so only report the ones still missing.
      const stillMissing = report.findings.some((f) =>
        f.check === 'legacy_missing_in_pg' && f.entity === e.entity && f.legacyId === e.legacyId);
      if (stillMissing) outstanding++;
    }
    report.count('dual_write_journal', 'legacy', entries.length);
    report.count('dual_write_journal', 'postgres', entries.length - outstanding);
    if (outstanding > 0) {
      report.finding('failed_dual_write', { severity: 'warning', entity: 'journal', repairable: true,
        detail: `${outstanding} of ${entries.length} journaled mirror failure(s) are still missing from PostgreSQL` });
    }
  }

  return report.finish();
}

module.exports = { reconcile, ReconcileReport };
