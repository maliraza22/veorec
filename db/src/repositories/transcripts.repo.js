// Transcripts, segments and cached translations (docs/07 §6, docs/15).
//
// Transcription runs in workers, so writes are *System. Replacing segments is
// inherently multi-row and MUST run in a transaction — the repo enforces that
// rather than trusting the caller.
'use strict';

const { and, eq, isNull, asc, count } = require('drizzle-orm');
const { transcripts, transcriptSegments, transcriptTranslations, recordings } = require('../schema');
const { newId } = require('../ids');
const { exec, NotFoundError, InvalidStateError } = require('./errors');
const { requireScope, requireSystemReason } = require('./scope');

module.exports = function transcriptsRepo(db) {
  const inTransaction = () => typeof db.rollback === 'function';

  return {
    async getForRecording(scope, recordingId) {
      const { userId } = requireScope(scope);
      const rows = await exec('transcript', () => db.select({ transcript: transcripts })
        .from(transcripts)
        .innerJoin(recordings, eq(transcripts.recordingId, recordings.id))
        .where(and(eq(transcripts.recordingId, recordingId), eq(recordings.userId, userId),
          isNull(recordings.deletedAt)))
        .limit(1));
      return rows.length ? rows[0].transcript : null;
    },

    /** Watch page: authorisation for the recording happens before this call. */
    async getForPublicWatch(recordingId) {
      const [row] = await exec('transcript', () => db.select().from(transcripts)
        .where(eq(transcripts.recordingId, recordingId)).limit(1));
      return row || null;
    },

    async listSegments(transcriptId) {
      return exec('transcript_segment', () => db.select().from(transcriptSegments)
        .where(eq(transcriptSegments.transcriptId, transcriptId)).orderBy(asc(transcriptSegments.idx)));
    },

    /** T-1103: segment count without loading rows (the no_speech note on the owner's status). */
    async countSegments(transcriptId) {
      const [row] = await exec('transcript_segment', () => db.select({ n: count() }).from(transcriptSegments)
        .where(eq(transcriptSegments.transcriptId, transcriptId)));
      return Number(row ? row.n : 0);
    },

    /** One current transcript per recording — re-running upserts in place. */
    async upsertSystem(recordingId, data, reason) {
      requireSystemReason(reason);
      const [row] = await exec('transcript', () => db.insert(transcripts).values({
        id: data.id || newId('transcript'),
        recordingId,
        status: data.status || 'queued',
        language: data.language ?? null,
        text: data.text ?? null,
        source: data.source ?? null,
        spokenLangOverride: data.spokenLangOverride ?? null,
        error: data.error ?? null,
      }).onConflictDoUpdate({
        target: transcripts.recordingId,
        set: {
          status: data.status || 'queued',
          language: data.language ?? null,
          text: data.text ?? null,
          source: data.source ?? null,
          error: data.error ?? null,
        },
      }).returning());
      return row;
    },

    async setStatusSystem(transcriptId, status, reason, { error = null } = {}) {
      requireSystemReason(reason);
      const [row] = await exec('transcript', () => db.update(transcripts)
        .set({ status, error }).where(eq(transcripts.id, transcriptId)).returning());
      if (!row) throw new NotFoundError('transcript');
      return row;
    },

    /**
     * Replace the whole segment set atomically: a half-written transcript would
     * corrupt captions and silence-detection ranges.
     */
    async replaceSegmentsSystem(transcriptId, segments, reason) {
      requireSystemReason(reason);
      if (!inTransaction()) {
        throw new InvalidStateError('transcript_segment',
          'replaceSegmentsSystem must run inside withTransaction() — deleting and re-inserting segments must be atomic');
      }
      await exec('transcript_segment', () => db.delete(transcriptSegments)
        .where(eq(transcriptSegments.transcriptId, transcriptId)));
      if (!segments || segments.length === 0) return [];
      const values = segments.map((s, i) => ({
        transcriptId,
        idx: s.idx ?? i,
        startS: String(s.start ?? s.startS),
        endS: String(s.end ?? s.endS),
        text: s.text,
        language: s.language ?? null,
      }));
      return exec('transcript_segment', () => db.insert(transcriptSegments).values(values).returning());
    },

    async putTranslationSystem(transcriptId, lang, segments, reason) {
      requireSystemReason(reason);
      const [row] = await exec('transcript_translation', () => db.insert(transcriptTranslations)
        .values({ transcriptId, lang, segments })
        .onConflictDoUpdate({
          target: [transcriptTranslations.transcriptId, transcriptTranslations.lang],
          set: { segments },
        }).returning());
      return row;
    },

    async getTranslation(transcriptId, lang) {
      const [row] = await exec('transcript_translation', () => db.select().from(transcriptTranslations)
        .where(and(eq(transcriptTranslations.transcriptId, transcriptId),
          eq(transcriptTranslations.lang, lang))).limit(1));
      return row || null;
    },

    /** DELETE /recordings/:id/transcribe (T-603): segments and translations cascade. Idempotent. */
    async deleteForRecordingSystem(recordingId, reason) {
      requireSystemReason(reason);
      const rows = await exec('transcript', () => db.delete(transcripts)
        .where(eq(transcripts.recordingId, recordingId)).returning({ id: transcripts.id }));
      return rows.length;
    },
  };
};
