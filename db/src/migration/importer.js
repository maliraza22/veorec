// ─────────────────────────────────────────────────────────────────────────────
// LEGACY IMPORTER (T-104)
//
// Migrates existing application state from the legacy JSON stores (+ an
// exported media listing) into PostgreSQL. It is an explicit, operator-run
// migration tool: nothing in the running application imports this module, and
// no server startup, request, cron or worker path invokes it.
//
// GUARANTEES
//   • READ-ONLY against legacy sources — additive migration, never mutation.
//   • IDEMPOTENT — deterministic ids derived from legacy identifiers plus
//     ON CONFLICT upserts; append-only logs use checkpoints. Running it once,
//     twice or ten times converges to the same rows.
//   • RESUMABLE — a crash halfway through leaves committed work in place;
//     re-running skips it (`alreadyImported`) and continues.
//   • HONEST — data that cannot be safely mapped is quarantined and reported,
//     never guessed. Ownership is never inferred.
//   • DRY RUN — performs zero writes while producing the full report.
//
// Writes go through the Drizzle query builder (not hand-written SQL) so
// text[]/jsonb/timestamp encoding is the ORM's problem, not ours.
//
// CLOUDINARY: consumed only as a migration SOURCE, via an exported listing
// file. This module contains no Cloudinary SDK, credentials or API calls, and
// nothing here belongs to the target architecture (docs/02 §2.7).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const crypto = require('crypto');
const { ImportReport } = require('./report');
const legacyStore = require('./legacy-store');
const { openLegacySources } = require('./sources');
const S = require('../schema');

// ── Deterministic id mapping — the backbone of idempotency ───────────────────
// Legacy stores already use UUIDs, so the new prefixed id is a pure function of
// the legacy id: importing the same record twice targets the same primary key.
const idFor = (prefix, legacyId) => `${prefix}_${legacyId}`;
/** Stable surrogate for legacy records that never had an id (e.g. reactions). */
const derivedId = (prefix, ...parts) =>
  `${prefix}_${crypto.createHash('sha256').update(parts.map((p) => String(p ?? '')).join(' ')).digest('hex').slice(0, 32)}`;

const toDate = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)) : null);
const str = (v, max) => (v == null ? null : String(v).slice(0, max));
const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const numStr = (v) => (Number.isFinite(Number(v)) ? String(Number(v)) : null);

/** Cloudinary public ids look like `screenrec/<userId>/<recordingId>`. */
function parseLegacyPublicId(publicId) {
  const parts = String(publicId || '').split('/');
  if (parts.length < 3) return null;
  return { legacyUserId: parts[parts.length - 2], legacyRecordingId: parts[parts.length - 1] };
}

/** Insert-if-absent helper: returns true when a row was actually created. */
async function insertNew(db, table, values, target) {
  const rows = await db.insert(table).values(values).onConflictDoNothing({ target }).returning({ id: table.id });
  return rows.length > 0;
}

async function runImport({ repos, db, dataDir, mediaListingFile = null, dryRun = true }) {
  const report = new ImportReport({ dryRun });
  const legacy = legacyStore(db);
  const src = openLegacySources(dataDir, mediaListingFile);

  // Deterministic ownership map: legacy user id → new user id, populated only
  // from users that actually exist. Anything not in here is an orphan.
  const userIdMap = new Map();
  // Recordings that are genuinely present in the database after this run.
  const liveRecordings = new Map();

  let runId = null;
  if (!dryRun) runId = await legacy.startRun({ dryRun, sourceDir: dataDir });

  try {
    // ── 1. Users ────────────────────────────────────────────────────────────
    for (const u of src.users) {
      report.count('users', 'source');
      if (!u || typeof u.id !== 'string' || typeof u.email !== 'string' || !u.email.includes('@')) {
        report.problem('failed', 'users', String(u && u.id), 'missing id or invalid email');
        continue;
      }
      const newId = idFor('usr', u.id);
      userIdMap.set(u.id, newId);
      if (dryRun) { report.count('users', 'imported'); continue; }
      try {
        const created = await insertNew(db, S.users, {
          id: newId,
          email: u.email.toLowerCase(),
          name: str(u.name, 200) || u.email.split('@')[0],
          passwordHash: u.password ?? null,
          googleId: u.googleId ?? null,
          manualPlan: u.manualPlan ?? null,
          manualPlanExpires: toDate(u.manualPlanExpires),
          slackWebhook: u.slackWebhook ?? null,
          paddleCustomerId: u.paddleCustomerId ?? null,
          createdAt: toDate(u.created_at) || new Date(),
        }, S.users.id);
        report.count('users', created ? 'imported' : 'alreadyImported');
      } catch (err) {
        // A duplicate live email (two legacy rows, same address) is a conflict a
        // human must resolve — never merged automatically.
        report.problem(err.code === 'conflict' || err.code === '23505' ? 'conflict' : 'failed',
          'users', u.id, err.message);
      }
    }
    report.note('legacy plaintext password-reset tokens are NOT imported (the column stores hashes; tokens expire in 1h)');

    // ── 2. Sessions ─────────────────────────────────────────────────────────
    // The legacy system is stateless (30-day JWTs, no session store), so there
    // is nothing to import. Users simply sign in again after cutover.
    report.entity('sessions');
    report.note('sessions: legacy auth was stateless JWT — no session records exist to import');

    // ── 3. Folders ──────────────────────────────────────────────────────────
    const liveFolders = new Set();
    for (const f of src.folders) {
      report.count('folders', 'source');
      if (!f || typeof f.id !== 'string') { report.problem('failed', 'folders', String(f && f.id), 'missing id'); continue; }
      const ownerId = userIdMap.get(f.userId);
      if (!ownerId) { report.problem('orphan', 'folders', f.id, `unknown legacy user ${f.userId}`); continue; }
      liveFolders.add(f.id);
      if (dryRun) { report.count('folders', 'imported'); continue; }
      try {
        const created = await insertNew(db, S.folders, {
          id: idFor('fld', f.id), userId: ownerId, name: str(f.name, 60) || 'Folder',
          createdAt: toDate(f.created_at) || new Date(),
        }, S.folders.id);
        report.count('folders', created ? 'imported' : 'alreadyImported');
      } catch (err) {
        report.problem('failed', 'folders', f.id, err.message);
      }
    }

    // ── 4. Recordings ───────────────────────────────────────────────────────
    // Ownership comes from a source that actually knows the owner:
    //   (a) recordings.json (local store) — carries userId
    //   (b) the media listing  — owner encoded in `screenrec/<userId>/<recId>`
    // meta.json holds metadata but NOT ownership, so a recording known only to
    // meta.json is quarantined rather than guessed.
    const recordingInputs = new Map();

    for (const r of src.localRecordings) {
      if (!r || typeof r.id !== 'string') continue;
      recordingInputs.set(r.id, {
        legacyId: r.id, legacyUserId: r.userId, title: r.title,
        duration: numOrNull(r.duration), sizeBytes: numOrNull(r.size),
        createdAt: toDate(r.created_at),
        media: r.filename ? { provider: 'local_disk', publicId: r.filename, url: null } : null,
      });
    }
    for (const m of src.mediaListing) {
      const ctx = (m && m.context && (m.context.custom || m.context)) || {};
      const parsed = parseLegacyPublicId(m && m.public_id);
      const legacyId = ctx.rec_id || (parsed && parsed.legacyRecordingId);
      const legacyUserId = ctx.user_id || (parsed && parsed.legacyUserId);
      if (!legacyId) continue;
      // Skip in-flight trim/compose artefacts the legacy editor leaves behind.
      if (/__(trim|compose)_\d+$/.test(String(m.public_id))) continue;
      const prev = recordingInputs.get(legacyId) || {};
      recordingInputs.set(legacyId, {
        ...prev,
        legacyId,
        legacyUserId: prev.legacyUserId || legacyUserId,
        title: prev.title || ctx.title,
        duration: prev.duration ?? numOrNull(m.duration) ?? numOrNull(ctx.duration),
        sizeBytes: prev.sizeBytes ?? numOrNull(m.bytes),
        width: prev.width ?? numOrNull(m.width),
        height: prev.height ?? numOrNull(m.height),
        createdAt: prev.createdAt || toDate(ctx.created_at) || (m.created_at ? new Date(m.created_at) : null),
        media: {
          provider: 'cloudinary', publicId: m.public_id, url: m.secure_url || null,
          bytes: numOrNull(m.bytes), duration: numOrNull(m.duration), format: m.format || null,
        },
      });
    }
    // Recordings referenced by meta.json but by no ownership-bearing source.
    for (const legacyId of Object.keys(src.meta)) {
      if (!recordingInputs.has(legacyId)) {
        report.count('recordings', 'source');
        report.problem('orphan', 'recordings', legacyId,
          'present in meta.json but no ownership source (media listing missing?) — not imported');
      }
    }

    for (const input of recordingInputs.values()) {
      report.count('recordings', 'source');
      const ownerId = userIdMap.get(input.legacyUserId);
      if (!ownerId) {
        report.problem('orphan', 'recordings', input.legacyId,
          `unknown legacy owner ${input.legacyUserId ?? '(none)'} — ownership never guessed`);
        continue;
      }
      const newId = idFor('rec', input.legacyId);
      const meta = src.meta[input.legacyId] || {};
      const folderId = meta.folder && liveFolders.has(meta.folder) ? idFor('fld', meta.folder) : null;
      if (meta.folder && !folderId) {
        report.problem('skipped', 'recordings', input.legacyId,
          `references unknown folder ${meta.folder} — imported without folder`);
      }
      if (input.media) report.count('recordings', 'unmappedMedia');   // bytes not in R2 yet
      if (dryRun) { report.count('recordings', 'imported'); continue; }

      try {
        const privacy = ['public', 'login', 'password'].includes(meta.privacy) ? meta.privacy : 'public';
        const created = await insertNew(db, S.recordings, {
          id: newId,
          userId: ownerId,
          title: str(input.title || meta.title, 200) || 'Untitled Recording',
          description: str(meta.description, 5000) || '',
          status: 'ready',
          sourceKind: 'extension',
          privacy,
          passwordHash: meta.passwordHash ?? null,
          folderId,
          duration: numStr(input.duration),
          sizeBytes: input.sizeBytes ?? null,
          width: input.width ?? null,
          height: input.height ?? null,
          trimStart: numStr(meta.trimStart),
          trimEnd: numStr(meta.trimEnd),
          segments: meta.segments ?? null,
          chapters: meta.chapters ?? null,
          tags: Array.isArray(meta.tags) ? meta.tags.map((t) => String(t).slice(0, 40)) : [],
          audience: meta.audience && typeof meta.audience === 'object' ? meta.audience : {},
          cta: meta.cta ?? null,
          recommendedSpeed: numStr(meta.recommendedSpeed),
          animatedThumbnail: meta.animatedThumbnail !== false,
          archived: !!meta.archived,
          createdAt: input.createdAt || new Date(),
        }, S.recordings.id);
        report.count('recordings', created ? 'imported' : 'alreadyImported');
        liveRecordings.set(newId, { ownerId, legacyId: input.legacyId });

        // 4b. Legacy media pointer — where the bytes live TODAY. No video_assets
        // row is created: the absence of one is the honest signal that nothing
        // exists in R2 yet. T-204 copies the bytes and creates the asset.
        if (input.media) {
          await legacy.upsertMediaMap({
            recordingId: newId,
            provider: input.media.provider,
            publicId: input.media.publicId,
            url: input.media.url,
            bytes: input.media.bytes ?? input.sizeBytes ?? null,
            duration: input.media.duration ?? input.duration ?? null,
            format: input.media.format ?? null,
          });
          report.count('legacy_media_map', 'source');
          report.count('legacy_media_map', 'imported');
        }
      } catch (err) {
        report.problem('failed', 'recordings', input.legacyId, err.message);
      }
    }
    report.note('no video_assets rows are created: legacy media still lives outside R2 — T-204 copies the bytes and creates the asset rows');

    // ── 5. Per-recording engagement, transcripts, leads ─────────────────────
    for (const [newRecordingId, info] of liveRecordings) {
      const meta = src.meta[info.legacyId] || {};

      // Comments (legacy rows carry uuids; author identity is a display name only).
      for (const c of (Array.isArray(meta.comments) ? meta.comments : [])) {
        report.count('comments', 'source');
        if (!c || !c.text) { report.problem('skipped', 'comments', String(c && c.id), 'empty body'); continue; }
        try {
          const created = await insertNew(db, S.comments, {
            id: c.id ? idFor('cmt', c.id) : derivedId('cmt', newRecordingId, c.at, c.text),
            recordingId: newRecordingId,
            authorName: str(c.name, 80) || 'Anonymous',
            body: str(c.text, 2000),
            t: numStr(c.t),
            createdAt: toDate(c.at) || new Date(),
          }, S.comments.id);
          report.count('comments', created ? 'imported' : 'alreadyImported');
        } catch (err) { report.problem('failed', 'comments', String(c && c.id), err.message); }
      }

      // Reactions: current array form, or the legacy { emoji: count } tally.
      const reactionRows = Array.isArray(meta.reactions)
        ? meta.reactions
        : Object.entries(meta.reactions || {}).flatMap(([emoji, n]) =>
          Array.from({ length: Math.max(0, parseInt(n) || 0) }, (_, i) => ({ emoji, t: null, at: 0, _tally: i })));
      for (const r of reactionRows) {
        report.count('reactions', 'source');
        if (!r || !r.emoji) { report.problem('skipped', 'reactions', newRecordingId, 'missing emoji'); continue; }
        try {
          const created = await insertNew(db, S.reactions, {
            id: derivedId('rct', newRecordingId, r.emoji, r.at, r.t, r.name, r._tally),
            recordingId: newRecordingId,
            authorName: str(r.name, 80),
            emoji: str(r.emoji, 8),
            t: numStr(r.t),
            createdAt: toDate(r.at) || new Date(0),
          }, S.reactions.id);
          report.count('reactions', created ? 'imported' : 'alreadyImported');
        } catch (err) { report.problem('failed', 'reactions', newRecordingId, err.message); }
      }

      // Unique viewers: legacy `viewKeys` maps 1:1 onto view_sessions rows, which
      // preserves the unique-view count exactly.
      for (const key of (Array.isArray(meta.viewKeys) ? meta.viewKeys : [])) {
        report.count('view_sessions', 'source');
        try {
          const rows = await db.insert(S.viewSessions).values({
            id: derivedId('vs', newRecordingId, key),
            recordingId: newRecordingId,
            viewerKey: String(key).slice(0, 200),
            lastSeenAt: new Date(),
          }).onConflictDoNothing({ target: [S.viewSessions.recordingId, S.viewSessions.viewerKey] })
            .returning({ id: S.viewSessions.id });
          report.count('view_sessions', rows.length ? 'imported' : 'alreadyImported');
        } catch (err) { report.problem('failed', 'view_sessions', newRecordingId, err.message); }
      }

      // Aggregate watch-through stats have no per-viewer breakdown in legacy
      // data; preserve them as an analytics event rather than fabricating rows.
      const eng = meta.engagement;
      if (eng && Number(eng.n) > 0) {
        const key = `engagement:${info.legacyId}`;
        try {
          if (!(await legacy.hasCheckpoint('meta.engagement', key))) {
            await db.insert(S.analyticsEvents).values({
              event: 'legacy_engagement_summary',
              recordingId: newRecordingId,
              props: { sum: Number(eng.sum) || 0, n: Number(eng.n) || 0, completed: Number(eng.completed) || 0 },
            });
            await legacy.putCheckpoint('meta.engagement', key);
          }
        } catch (err) { report.problem('failed', 'view_sessions', info.legacyId, `engagement summary: ${err.message}`); }
      }

      for (const l of (Array.isArray(meta.leads) ? meta.leads : [])) {
        report.count('leads', 'source');
        if (!l || !l.email) { report.problem('skipped', 'leads', newRecordingId, 'missing email'); continue; }
        try {
          const rows = await db.insert(S.leads).values({
            id: derivedId('led', newRecordingId, l.email),
            recordingId: newRecordingId,
            email: String(l.email).slice(0, 200),
            name: str(l.name, 80),
            createdAt: toDate(l.at) || new Date(),
          }).onConflictDoNothing({ target: [S.leads.recordingId, S.leads.email] })
            .returning({ id: S.leads.id });
          report.count('leads', rows.length ? 'imported' : 'alreadyImported');
        } catch (err) { report.problem('failed', 'leads', newRecordingId, err.message); }
      }

      // Transcript + segments (one current transcript per recording).
      const t = meta.transcript;
      if (t && (t.text || (Array.isArray(t.segments) && t.segments.length))) {
        report.count('transcripts', 'source');
        const segs = (Array.isArray(t.segments) ? t.segments : [])
          .filter((s) => s && Number.isFinite(Number(s.start)) && Number.isFinite(Number(s.end)) && s.text);
        try {
          const transcriptId = idFor('trs', info.legacyId);
          const rows = await db.insert(S.transcripts).values({
            id: transcriptId,
            recordingId: newRecordingId,
            status: 'done',
            language: str(t.language, 40),
            text: t.text ?? null,
            source: t.source === 'whisper_cpp' ? 'whisper_cpp' : 'groq',
            spokenLangOverride: str(t.spokenLang, 40),
            createdAt: toDate(t.created_at) || new Date(),
          }).onConflictDoNothing({ target: S.transcripts.recordingId }).returning({ id: S.transcripts.id });
          const created = rows.length > 0;
          report.count('transcripts', created ? 'imported' : 'alreadyImported');
          report.count('transcript_segments', 'source', segs.length);
          if (created && segs.length) {
            await db.insert(S.transcriptSegments).values(segs.map((s, i) => ({
              transcriptId, idx: i,
              startS: String(Number(s.start)),
              endS: String(Math.max(Number(s.start), Number(s.end))),
              text: String(s.text),
              language: str(s.language, 40),
            }))).onConflictDoNothing();
            report.count('transcript_segments', 'imported', segs.length);
          } else if (!created) {
            report.count('transcript_segments', 'alreadyImported', segs.length);
          }
        } catch (err) { report.problem('failed', 'transcripts', info.legacyId, err.message); }
      }
    }

    // ── 6. Usage ledger ─────────────────────────────────────────────────────
    for (const [legacyUserId, u] of Object.entries(src.usage)) {
      report.count('usage', 'source');
      const ownerId = userIdMap.get(legacyUserId);
      if (!ownerId) { report.problem('orphan', 'usage', legacyUserId, 'unknown legacy user'); continue; }
      if (dryRun) { report.count('usage', 'imported'); continue; }
      try {
        const rows = await db.insert(S.usage).values({
          userId: ownerId,
          storageRetainedBytes: Math.max(0, Math.round(Number(u.storageUsedBytes) || 0)),
          activeVideoCount: Math.max(0, Number(u.videoCount) || 0),
          recordingSeconds: Math.max(0, Math.round((Number(u.recordingMinutesUsed) || 0) * 60)),
          monthlyUploads: Math.max(0, Number(u.monthlyUploads) || 0),
          monthlyPeriod: str(u.monthlyUploadsPeriod, 7),
          lastRecalculatedAt: toDate(u.lastCalculatedAt),
        }).onConflictDoNothing({ target: S.usage.userId }).returning({ userId: S.usage.userId });
        report.count('usage', rows.length ? 'imported' : 'alreadyImported');
      } catch (err) { report.problem('failed', 'usage', legacyUserId, err.message); }
    }
    report.note('usage counters are imported as-is; the nightly usage_sync job re-derives them authoritatively after cutover');

    // ── 7. Subscriptions ────────────────────────────────────────────────────
    for (const [legacyUserId, s] of Object.entries(src.subscriptions)) {
      report.count('subscriptions', 'source');
      const ownerId = userIdMap.get(legacyUserId);
      if (!ownerId) { report.problem('orphan', 'subscriptions', legacyUserId, 'unknown legacy user'); continue; }
      const status = ['active', 'trialing', 'past_due', 'paused', 'canceled'].includes(s.status) ? s.status : 'canceled';
      if (s.status && status !== s.status) {
        report.problem('skipped', 'subscriptions', legacyUserId, `unknown status "${s.status}" imported as canceled`);
      }
      if (dryRun) { report.count('subscriptions', 'imported'); continue; }
      try {
        const created = await insertNew(db, S.subscriptions, {
          id: idFor('sub', s.id || legacyUserId),
          userId: ownerId,
          paddleSubscriptionId: s.paddleSubscriptionId ?? null,
          paddleCustomerId: s.paddleCustomerId ?? null,
          paddlePriceId: s.paddlePriceId ?? null,
          planSlug: str(s.planSlug, 40) || 'pro',
          status,
          billingCycle: s.billingCycle === 'yearly' ? 'yearly' : 'monthly',
          currentPeriodStart: toDate(s.currentPeriodStart),
          currentPeriodEnd: toDate(s.currentPeriodEnd),
          cancelAtPeriodEnd: !!s.cancelAtPeriodEnd,
          createdAt: toDate(s.createdAt) || new Date(),
        }, S.subscriptions.userId);
        report.count('subscriptions', created ? 'imported' : 'alreadyImported');
      } catch (err) { report.problem('failed', 'subscriptions', legacyUserId, err.message); }
    }
    report.entity('billing_events');
    report.note('billing_events: legacy webhooks were never persisted — the ledger starts empty and fills from live Paddle events');

    // ── 8. Conversion events → analytics (append-only ⇒ checkpointed) ────────
    const seenEvents = dryRun ? new Set() : await legacy.loadCheckpointKeys('upgrade_events');
    for (const [i, e] of src.upgradeEvents.entries()) {
      report.count('analytics_events', 'source');
      if (!e || !e.featureRequested) { report.problem('skipped', 'analytics_events', String(i), 'missing featureRequested'); continue; }
      const key = derivedId('ev', e.userId, e.featureRequested, e.timestamp, i);
      if (seenEvents.has(key)) { report.count('analytics_events', 'alreadyImported'); continue; }
      if (dryRun) { report.count('analytics_events', 'imported'); continue; }
      try {
        await db.insert(S.analyticsEvents).values({
          event: 'paywall_hit',
          userId: userIdMap.get(e.userId) ?? null,
          props: { trigger: e.featureRequested, userPlan: e.userPlan ?? null, meta: e.meta ?? {} },
          createdAt: toDate(e.timestamp) || new Date(),
        });
        await legacy.putCheckpoint('upgrade_events', key);
        report.count('analytics_events', 'imported');
      } catch (err) { report.problem('failed', 'analytics_events', String(i), err.message); }
    }

    // ── 9. Contacts, notification reads, plan overrides ─────────────────────
    for (const c of Object.values(src.contacts)) {
      report.count('contacts', 'source');
      if (!c || !c.email || !c.message) { report.problem('skipped', 'contacts', String(c && c.id), 'missing email or message'); continue; }
      if (dryRun) { report.count('contacts', 'imported'); continue; }
      try {
        const created = await insertNew(db, S.contacts, {
          id: idFor('ctc', c.id),
          name: str(c.name, 120) || 'Unknown',
          email: str(c.email, 200),
          subject: str(c.subject, 160),
          message: str(c.message, 5000),
          userId: userIdMap.get(c.userId) ?? null,
          status: ['new', 'read', 'replied', 'archived'].includes(c.status) ? c.status : 'new',
          createdAt: toDate(c.createdAt) || new Date(),
        }, S.contacts.id);
        report.count('contacts', created ? 'imported' : 'alreadyImported');
      } catch (err) { report.problem('failed', 'contacts', String(c && c.id), err.message); }
    }

    for (const [legacyUserId, at] of Object.entries(src.notifReads)) {
      report.count('notification_reads', 'source');
      const ownerId = userIdMap.get(legacyUserId);
      if (!ownerId) { report.problem('orphan', 'notification_reads', legacyUserId, 'unknown legacy user'); continue; }
      if (dryRun) { report.count('notification_reads', 'imported'); continue; }
      try {
        const rows = await db.insert(S.notificationReads)
          .values({ userId: ownerId, lastReadAt: toDate(at) || new Date(0) })
          .onConflictDoNothing({ target: S.notificationReads.userId })
          .returning({ userId: S.notificationReads.userId });
        report.count('notification_reads', rows.length ? 'imported' : 'alreadyImported');
      } catch (err) { report.problem('failed', 'notification_reads', legacyUserId, err.message); }
    }

    for (const [slug, overrides] of Object.entries(src.planOverrides)) {
      report.count('plan_overrides', 'source');
      if (dryRun) { report.count('plan_overrides', 'imported'); continue; }
      try {
        await db.insert(S.planOverrides)
          .values({ planSlug: String(slug).slice(0, 40), overrides: overrides || {} })
          .onConflictDoUpdate({ target: S.planOverrides.planSlug, set: { overrides: overrides || {} } });
        report.count('plan_overrides', 'imported');
      } catch (err) { report.problem('failed', 'plan_overrides', slug, err.message); }
    }

    // ── 10. Audit the migration itself (bookkeeping, not imported data) ─────
    if (!dryRun) {
      await repos.audit.record({
        action: 'legacy.import', targetType: 'migration', targetId: String(runId ?? ''),
        detail: { totals: report.totals, dataDir },
      });
    }

    report.finish();
    if (!dryRun && runId != null) await legacy.finishRun(runId, report.toJSON());
    return report;
  } catch (err) {
    report.finish();
    if (!dryRun && runId != null) {
      await legacy.finishRun(runId, report.toJSON(), String(err && err.message)).catch(() => {});
    }
    throw err;
  }
}

module.exports = { runImport, idFor, derivedId, parseLegacyPublicId };
