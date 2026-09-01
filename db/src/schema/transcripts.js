// Transcripts, segments and cached translations (docs/07 §6, docs/15).
//
// Transcription is independent of playability: a failed transcript never
// changes recordings.status (invariant #14).
'use strict';

const { sql } = require('drizzle-orm');
const { pgTable, text, integer, bigserial, numeric, jsonb, index, uniqueIndex, check, primaryKey } = require('drizzle-orm/pg-core');
const { createdAt, updatedAt } = require('./_types');
const { recordings } = require('./recordings');

const transcripts = pgTable('transcripts', {
  id: text('id').primaryKey(),                       // trs_
  recordingId: text('recording_id').notNull().references(() => recordings.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('queued'),
  language: text('language'),
  text: text('text'),
  source: text('source'),                            // which engine produced it
  spokenLangOverride: text('spoken_lang_override'),
  // Timestamps stop matching the media after an overwrite render (docs/14 §4).
  stale: text('stale'),
  error: text('error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('transcripts_recording_uniq').on(t.recordingId),   // one current transcript
  check('transcripts_status_chk', sql`${t.status} IN ('queued','running','done','failed')`),
  check('transcripts_source_chk', sql`${t.source} IS NULL OR ${t.source} IN ('groq','whisper_cpp')`),
]);

const transcriptSegments = pgTable('transcript_segments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  transcriptId: text('transcript_id').notNull().references(() => transcripts.id, { onDelete: 'cascade' }),
  idx: integer('idx').notNull(),
  startS: numeric('start_s', { precision: 10, scale: 3 }).notNull(),
  endS: numeric('end_s', { precision: 10, scale: 3 }).notNull(),
  text: text('text').notNull(),
  language: text('language'),                        // per-segment: mixed-language support
}, (t) => [
  uniqueIndex('transcript_segments_transcript_idx_uniq').on(t.transcriptId, t.idx),
  index('transcript_segments_transcript_idx').on(t.transcriptId),
  check('transcript_segments_range_chk', sql`${t.startS} >= 0 AND ${t.endS} >= ${t.startS}`),
  check('transcript_segments_idx_chk', sql`${t.idx} >= 0`),
]);

// Cached LLM translations — legacy recomputed these on every request.
const transcriptTranslations = pgTable('transcript_translations', {
  transcriptId: text('transcript_id').notNull().references(() => transcripts.id, { onDelete: 'cascade' }),
  lang: text('lang').notNull(),
  segments: jsonb('segments').notNull(),
  createdAt: createdAt(),
}, (t) => [
  primaryKey({ name: 'transcript_translations_pk', columns: [t.transcriptId, t.lang] }),
]);

module.exports = { transcripts, transcriptSegments, transcriptTranslations };
