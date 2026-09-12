// Editing: edit sessions (draft timelines), their append-only op log and
// render jobs (docs/07 §6, docs/14 §3) — T-1201.
//
// Owner operations are scoped through `edit_sessions.user_id`; render jobs
// are reached through their session. The worker's *System methods take a
// stated reason. The materialised `timeline` is the state; the ops are the log.
'use strict';

const { and, eq, desc, asc, sql } = require('drizzle-orm');
const { editSessions, editOperations, renderJobs, processingJobs } = require('../schema');
const { newId } = require('../ids');
const { exec, NotFoundError, InvalidStateError } = require('./errors');
const { requireScope, requireSystemReason } = require('./scope');

const SESSION_STATUSES = ['draft', 'rendering', 'applied', 'discarded'];
const RENDER_STATUSES = ['queued', 'running', 'done', 'failed'];

module.exports = function editingRepos(db) {
  const owned = (userId, extra) => and(eq(editSessions.userId, userId), extra);

  const editSessionsRepo = {
    async create(scope, { recordingId, timeline = [], mode = null }) {
      const { userId } = requireScope(scope);
      const [row] = await exec('edit_session', () => db.insert(editSessions)
        .values({ id: newId('editSession'), recordingId, userId, timeline, mode }).returning());
      return row;
    },
    async get(scope, id) {
      const { userId } = requireScope(scope);
      const [row] = await exec('edit_session', () => db.select().from(editSessions)
        .where(owned(userId, eq(editSessions.id, id))).limit(1));
      return row || null;
    },
    async listForRecording(scope, recordingId, { limit = 50 } = {}) {
      const { userId } = requireScope(scope);
      return exec('edit_session', () => db.select().from(editSessions)
        .where(owned(userId, eq(editSessions.recordingId, recordingId)))
        .orderBy(desc(editSessions.updatedAt)).limit(limit));
    },
    /** Only a draft may change its timeline (docs/14 §3). */
    async updateTimeline(scope, id, timeline) {
      const { userId } = requireScope(scope);
      const [row] = await exec('edit_session', () => db.update(editSessions)
        .set({ timeline, updatedAt: new Date() })
        .where(owned(userId, and(eq(editSessions.id, id), eq(editSessions.status, 'draft')))).returning());
      if (!row) {
        const exists = await this.get(scope, id);
        if (!exists) throw new NotFoundError('edit_session');
        throw new InvalidStateError('edit_session', `an edit session in status '${exists.status}' cannot be changed`);
      }
      return row;
    },
    /** Append one op to the log; idx = count so far (unique per session). */
    async appendOp(scope, id, op) {
      const session = await this.get(scope, id);
      if (!session) throw new NotFoundError('edit_session');
      const [{ n }] = await exec('edit_operation', () => db.select({ n: sql`count(*)::int` }).from(editOperations)
        .where(eq(editOperations.editSessionId, id)));
      const [row] = await exec('edit_operation', () => db.insert(editOperations)
        .values({ editSessionId: id, idx: Number(n), op }).returning());
      return row;
    },
    async listOps(scope, id) {
      const session = await this.get(scope, id);
      if (!session) throw new NotFoundError('edit_session');
      return exec('edit_operation', () => db.select().from(editOperations)
        .where(eq(editOperations.editSessionId, id)).orderBy(asc(editOperations.idx)));
    },
    async setStatus(scope, id, status, { mode } = {}) {
      const { userId } = requireScope(scope);
      if (!SESSION_STATUSES.includes(status)) throw new InvalidStateError('edit_session', `unknown status '${status}'`);
      const [row] = await exec('edit_session', () => db.update(editSessions)
        .set({ status, ...(mode !== undefined ? { mode } : {}), updatedAt: new Date() })
        .where(owned(userId, eq(editSessions.id, id))).returning());
      if (!row) throw new NotFoundError('edit_session');
      return row;
    },
    async findRenderingForRecording(scope, recordingId) {
      const { userId } = requireScope(scope);
      const [row] = await exec('edit_session', () => db.select().from(editSessions)
        .where(owned(userId, and(eq(editSessions.recordingId, recordingId), eq(editSessions.status, 'rendering')))).limit(1));
      return row || null;
    },
    // ── worker surface ───────────────────────────────────────────────────
    async getSystem(id, reason) {
      requireSystemReason(reason);
      const [row] = await exec('edit_session', () => db.select().from(editSessions).where(eq(editSessions.id, id)).limit(1));
      return row || null;
    },
    async setStatusSystem(id, status, reason) {
      requireSystemReason(reason);
      if (!SESSION_STATUSES.includes(status)) throw new InvalidStateError('edit_session', `unknown status '${status}'`);
      const [row] = await exec('edit_session', () => db.update(editSessions)
        .set({ status, updatedAt: new Date() }).where(eq(editSessions.id, id)).returning());
      return row || null;
    },
  };

  const renderJobsRepo = {
    /** Ownership via the session (scoped read first). */
    async create(scope, { editSessionId, processingJobId = null, outputRecordingId = null }) {
      const session = await editSessionsRepo.get(scope, editSessionId);
      if (!session) throw new NotFoundError('edit_session');
      const [row] = await exec('render_job', () => db.insert(renderJobs)
        .values({ id: newId('renderJob'), editSessionId, processingJobId, outputRecordingId }).returning());
      return row;
    },
    /** The job + its session + the processing row's progress, for the owner. */
    async get(scope, id) {
      const { userId } = requireScope(scope);
      const [row] = await exec('render_job', () => db.select({
        job: renderJobs, session: editSessions,
        progress: sql`(${processingJobs.result} ->> 'progress')`,
        processingStatus: processingJobs.status,
      }).from(renderJobs)
        .innerJoin(editSessions, eq(renderJobs.editSessionId, editSessions.id))
        .leftJoin(processingJobs, eq(renderJobs.processingJobId, processingJobs.id))
        .where(and(eq(renderJobs.id, id), eq(editSessions.userId, userId))).limit(1));
      if (!row) return null;
      return { ...row.job, session: row.session, progress: row.progress == null ? null : Number(row.progress), processingStatus: row.processingStatus };
    },
    async listForSession(scope, editSessionId) {
      const session = await editSessionsRepo.get(scope, editSessionId);
      if (!session) throw new NotFoundError('edit_session');
      return exec('render_job', () => db.select().from(renderJobs)
        .where(eq(renderJobs.editSessionId, editSessionId)).orderBy(desc(renderJobs.createdAt)));
    },
    // ── worker surface ───────────────────────────────────────────────────
    async getSystem(id, reason) {
      requireSystemReason(reason);
      const [row] = await exec('render_job', () => db.select().from(renderJobs).where(eq(renderJobs.id, id)).limit(1));
      return row || null;
    },
    async updateSystem(id, patch, reason) {
      requireSystemReason(reason);
      const allowed = ['status', 'error', 'processingJobId', 'outputRecordingId', 'outputAssetId'];
      const values = Object.fromEntries(Object.entries(patch || {}).filter(([k, v]) => allowed.includes(k) && v !== undefined));
      if (values.status && !RENDER_STATUSES.includes(values.status)) throw new InvalidStateError('render_job', `unknown status '${values.status}'`);
      if (Object.keys(values).length === 0) return null;
      const [row] = await exec('render_job', () => db.update(renderJobs)
        .set({ ...values, updatedAt: new Date() }).where(eq(renderJobs.id, id)).returning());
      if (!row) throw new NotFoundError('render_job');
      return row;
    },
  };

  return { editSessions: editSessionsRepo, renderJobs: renderJobsRepo };
};
module.exports.SESSION_STATUSES = SESSION_STATUSES;
module.exports.RENDER_STATUSES = RENDER_STATUSES;
