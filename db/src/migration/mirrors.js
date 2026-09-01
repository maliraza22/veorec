// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL LEGACY → POSTGRESQL RECORD MAPPING (T-104 / T-105)
//
// One upsert per legacy entity, used by BOTH:
//   • the bulk importer (T-104) — iterating the JSON stores, and
//   • the runtime dual-write mirror (T-105) — mirroring a single mutation.
//
// Having a single implementation is what makes the two converge: the same
// legacy record produces the same row and the same primary key regardless of
// which path wrote it, so re-running the importer after a failed mirror repairs
// it exactly rather than duplicating it.
//
// Every function is idempotent (deterministic id + ON CONFLICT) and returns
// `{ id, created }`. None of them read application state, enforce quotas, or
// know anything about storage providers.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const S = require('../schema');
const { idFor, derivedId } = require('../legacy-ids');

const toDate = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)) : null);
const str = (v, max) => (v == null ? null : String(v).slice(0, max));
// `Number(null)` is 0 and `Number('')` is 0, so a plain isFinite check silently
// turns "no value" into a real 0 — which corrupted null trim points, null
// comment timestamps, and violated the recommended-speed CHECK. Null-ish input
// must stay null.
const nullish = (v) => v === null || v === undefined || v === '';
const num = (v) => (nullish(v) || !Number.isFinite(Number(v)) ? null : Number(v));
const numStr = (v) => (num(v) === null ? null : String(num(v)));

/** Insert-if-absent; returns whether a row was created. */
async function insertNew(db, table, values, target) {
  const rows = await db.insert(table).values(values).onConflictDoNothing({ target }).returning({ id: table.id });
  return rows.length > 0;
}

// ── Users ────────────────────────────────────────────────────────────────────
/**
 * Upsert a legacy user. Mutable profile fields are refreshed on conflict so a
 * later profile/password change mirrors correctly; created_at is never moved.
 * Legacy plaintext reset tokens are deliberately NOT mirrored.
 */
async function upsertUser(db, u) {
  if (!u || typeof u.id !== 'string' || typeof u.email !== 'string' || !u.email.includes('@')) {
    throw new Error('legacy user is missing an id or has an invalid email');
  }
  const id = idFor('usr', u.id);
  const mutable = {
    email: u.email.toLowerCase(),
    name: str(u.name, 200) || u.email.split('@')[0],
    passwordHash: u.password ?? null,
    googleId: u.googleId ?? null,
    manualPlan: u.manualPlan ?? null,
    manualPlanExpires: toDate(u.manualPlanExpires),
    slackWebhook: u.slackWebhook ?? null,
    paddleCustomerId: u.paddleCustomerId ?? null,
  };
  const rows = await db.insert(S.users)
    .values({ id, ...mutable, createdAt: toDate(u.created_at) || new Date() })
    .onConflictDoUpdate({ target: S.users.id, set: mutable })
    .returning({ id: S.users.id });
  return { id, created: rows.length > 0 };
}

// ── Folders ──────────────────────────────────────────────────────────────────
async function upsertFolder(db, f, ownerId) {
  const id = idFor('fld', f.id);
  const rows = await db.insert(S.folders)
    .values({ id, userId: ownerId, name: str(f.name, 60) || 'Folder', createdAt: toDate(f.created_at) || new Date() })
    .onConflictDoUpdate({ target: S.folders.id, set: { name: str(f.name, 60) || 'Folder' } })
    .returning({ id: S.folders.id });
  return { id, created: rows.length > 0 };
}

async function deleteFolder(db, legacyFolderId, ownerId) {
  const { and, eq } = require('drizzle-orm');
  const id = idFor('fld', legacyFolderId);
  const rows = await db.delete(S.folders)
    .where(and(eq(S.folders.id, id), eq(S.folders.userId, ownerId)))
    .returning({ id: S.folders.id });
  return { id, created: false, deleted: rows.length > 0 };
}

// ── Recordings ───────────────────────────────────────────────────────────────
/**
 * Upsert a recording from legacy facts + its meta.json entry.
 * `meta` may be partial (a metadata patch) — only supplied fields are updated.
 */
async function upsertRecording(db, rec, meta = {}) {
  const id = idFor('rec', rec.legacyId);
  const privacy = ['public', 'login', 'password'].includes(meta.privacy) ? meta.privacy : 'public';
  // A metadata patch carries no title (legacy titles live outside meta.json),
  // so only overwrite the title when one is actually supplied — otherwise a
  // privacy/description change would reset it to 'Untitled Recording'.
  const title = str(rec.title || meta.title, 200);
  const mutable = {
    ...(title ? { title } : {}),
    description: str(meta.description, 5000) || '',
    privacy,
    passwordHash: meta.passwordHash ?? null,
    folderId: rec.folderId ?? null,
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
  };
  const rows = await db.insert(S.recordings).values({
    id,
    title: title || 'Untitled Recording',
    userId: rec.ownerId,
    status: 'ready',
    sourceKind: rec.sourceKind || 'extension',
    duration: numStr(rec.duration),
    sizeBytes: rec.sizeBytes ?? null,
    width: rec.width ?? null,
    height: rec.height ?? null,
    createdAt: rec.createdAt || new Date(),
    ...mutable,
  }).onConflictDoUpdate({
    target: S.recordings.id,
    // Ownership, lifecycle and verified media facts are never rewritten by a
    // metadata mirror; only owner-editable fields are refreshed.
    set: mutable,
  }).returning({ id: S.recordings.id });
  return { id, created: rows.length > 0 };
}

/** Where a recording's bytes currently live (pre-R2). Transitional. */
async function upsertMediaMap(db, recordingId, media) {
  const { sql } = require('drizzle-orm');
  await db.execute(sql`
    INSERT INTO legacy.media_map
      (recording_id, legacy_provider, legacy_public_id, legacy_url, legacy_bytes, legacy_duration, legacy_format)
    VALUES (${recordingId}, ${media.provider || 'cloudinary'}, ${media.publicId},
            ${media.url ?? null}, ${media.bytes ?? null}, ${media.duration ?? null}, ${media.format ?? null})
    ON CONFLICT (recording_id) DO UPDATE SET
      legacy_provider = EXCLUDED.legacy_provider, legacy_public_id = EXCLUDED.legacy_public_id,
      legacy_url = EXCLUDED.legacy_url, legacy_bytes = EXCLUDED.legacy_bytes,
      legacy_duration = EXCLUDED.legacy_duration, legacy_format = EXCLUDED.legacy_format`);
  return { id: recordingId, created: false };
}

// ── Engagement ───────────────────────────────────────────────────────────────
async function upsertComment(db, recordingId, c) {
  const id = c.id ? idFor('cmt', c.id) : derivedId('cmt', recordingId, c.at, c.text);
  const created = await insertNew(db, S.comments, {
    id,
    recordingId,
    authorName: str(c.name, 80) || 'Anonymous',
    body: str(c.text, 2000),
    t: numStr(c.t),
    createdAt: toDate(c.at) || new Date(),
  }, S.comments.id);
  return { id, created };
}

async function upsertReaction(db, recordingId, r) {
  const id = derivedId('rct', recordingId, r.emoji, r.at, r.t, r.name, r._tally);
  const created = await insertNew(db, S.reactions, {
    id,
    recordingId,
    authorName: str(r.name, 80),
    emoji: str(r.emoji, 8),
    t: numStr(r.t),
    createdAt: toDate(r.at) || new Date(0),
  }, S.reactions.id);
  return { id, created };
}

async function upsertViewSession(db, recordingId, viewerKey, extra = {}) {
  const id = derivedId('vs', recordingId, viewerKey);
  const rows = await db.insert(S.viewSessions).values({
    id,
    recordingId,
    viewerKey: String(viewerKey).slice(0, 200),
    viewerUserId: extra.viewerUserId ?? null,
    isOwner: !!extra.isOwner,
    lastSeenAt: new Date(),
  }).onConflictDoNothing({ target: [S.viewSessions.recordingId, S.viewSessions.viewerKey] })
    .returning({ id: S.viewSessions.id });
  return { id, created: rows.length > 0 };
}

async function upsertLead(db, recordingId, l) {
  const id = derivedId('led', recordingId, l.email);
  const rows = await db.insert(S.leads).values({
    id, recordingId, email: String(l.email).slice(0, 200), name: str(l.name, 80),
    createdAt: toDate(l.at) || new Date(),
  }).onConflictDoNothing({ target: [S.leads.recordingId, S.leads.email] })
    .returning({ id: S.leads.id });
  return { id, created: rows.length > 0 };
}

// ── Transcripts ──────────────────────────────────────────────────────────────
async function upsertTranscript(db, recordingId, legacyRecordingId, t) {
  const id = idFor('trs', legacyRecordingId);
  const rows = await db.insert(S.transcripts).values({
    id,
    recordingId,
    status: 'done',
    language: str(t.language, 40),
    text: t.text ?? null,
    source: t.source === 'whisper_cpp' ? 'whisper_cpp' : 'groq',
    spokenLangOverride: str(t.spokenLang, 40),
    createdAt: toDate(t.created_at) || new Date(),
  }).onConflictDoNothing({ target: S.transcripts.recordingId }).returning({ id: S.transcripts.id });
  return { id, created: rows.length > 0 };
}

async function insertTranscriptSegments(db, transcriptId, segments) {
  const segs = (Array.isArray(segments) ? segments : [])
    .filter((s) => s && Number.isFinite(Number(s.start)) && Number.isFinite(Number(s.end)) && s.text);
  if (!segs.length) return { count: 0 };
  await db.insert(S.transcriptSegments).values(segs.map((s, i) => ({
    transcriptId, idx: i,
    startS: String(Number(s.start)),
    endS: String(Math.max(Number(s.start), Number(s.end))),
    text: String(s.text),
    language: str(s.language, 40),
  }))).onConflictDoNothing();
  return { count: segs.length };
}

// ── Usage / billing / misc ───────────────────────────────────────────────────
/** Usage is a mirrored SNAPSHOT of the legacy counters, never an enforcement input. */
async function upsertUsage(db, ownerId, u) {
  const values = {
    storageRetainedBytes: Math.max(0, Math.round(Number(u.storageUsedBytes) || 0)),
    activeVideoCount: Math.max(0, Number(u.videoCount) || 0),
    recordingSeconds: Math.max(0, Math.round((Number(u.recordingMinutesUsed) || 0) * 60)),
    monthlyUploads: Math.max(0, Number(u.monthlyUploads) || 0),
    monthlyPeriod: str(u.monthlyUploadsPeriod, 7),
    lastRecalculatedAt: toDate(u.lastCalculatedAt),
  };
  const rows = await db.insert(S.usage).values({ userId: ownerId, ...values })
    .onConflictDoUpdate({ target: S.usage.userId, set: values })
    .returning({ id: S.usage.userId });
  return { id: ownerId, created: rows.length > 0 };
}

async function upsertSubscription(db, ownerId, s, legacyUserId) {
  const status = ['active', 'trialing', 'past_due', 'paused', 'canceled'].includes(s.status) ? s.status : 'canceled';
  const values = {
    paddleSubscriptionId: s.paddleSubscriptionId ?? null,
    paddleCustomerId: s.paddleCustomerId ?? null,
    paddlePriceId: s.paddlePriceId ?? null,
    planSlug: str(s.planSlug, 40) || 'pro',
    status,
    billingCycle: s.billingCycle === 'yearly' ? 'yearly' : 'monthly',
    currentPeriodStart: toDate(s.currentPeriodStart),
    currentPeriodEnd: toDate(s.currentPeriodEnd),
    cancelAtPeriodEnd: !!s.cancelAtPeriodEnd,
  };
  const id = idFor('sub', s.id || legacyUserId);
  const rows = await db.insert(S.subscriptions)
    .values({ id, userId: ownerId, ...values, createdAt: toDate(s.createdAt) || new Date() })
    .onConflictDoUpdate({ target: S.subscriptions.userId, set: values })
    .returning({ id: S.subscriptions.id });
  return { id, created: rows.length > 0, unknownStatus: s.status && status !== s.status ? s.status : null };
}

async function upsertContact(db, c, ownerId = null) {
  const id = idFor('ctc', c.id);
  const created = await insertNew(db, S.contacts, {
    id,
    name: str(c.name, 120) || 'Unknown',
    email: str(c.email, 200),
    subject: str(c.subject, 160),
    message: str(c.message, 5000),
    userId: ownerId,
    status: ['new', 'read', 'replied', 'archived'].includes(c.status) ? c.status : 'new',
    createdAt: toDate(c.createdAt) || new Date(),
  }, S.contacts.id);
  return { id, created };
}

async function upsertNotificationRead(db, ownerId, at) {
  const rows = await db.insert(S.notificationReads)
    .values({ userId: ownerId, lastReadAt: toDate(at) || new Date(0) })
    .onConflictDoUpdate({ target: S.notificationReads.userId, set: { lastReadAt: toDate(at) || new Date(0) } })
    .returning({ id: S.notificationReads.userId });
  return { id: ownerId, created: rows.length > 0 };
}

async function upsertPlanOverride(db, slug, overrides) {
  await db.insert(S.planOverrides)
    .values({ planSlug: String(slug).slice(0, 40), overrides: overrides || {} })
    .onConflictDoUpdate({ target: S.planOverrides.planSlug, set: { overrides: overrides || {} } });
  return { id: slug, created: true };
}

async function insertAnalyticsEvent(db, { event, recordingId = null, userId = null, props = {}, createdAt = null }) {
  await db.insert(S.analyticsEvents).values({
    event, recordingId, userId, props, ...(createdAt ? { createdAt } : {}),
  });
  return { id: null, created: true };
}

module.exports = {
  idFor, derivedId,
  upsertUser, upsertFolder, deleteFolder,
  upsertRecording, upsertMediaMap,
  upsertComment, upsertReaction, upsertViewSession, upsertLead,
  upsertTranscript, insertTranscriptSegments,
  upsertUsage, upsertSubscription, upsertContact, upsertNotificationRead,
  upsertPlanOverride, insertAnalyticsEvent,
};
