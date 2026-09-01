// Audit log — every admin mutation and destructive user action (docs/17 §3).
//
// Append-only from the application's point of view: there is deliberately no
// update or delete method.
'use strict';

const { and, eq, desc } = require('drizzle-orm');
const { auditLogs } = require('../schema');
const { exec } = require('./errors');
const { requireSystemReason } = require('./scope');

module.exports = function auditRepo(db) {
  return {
    /**
     * `actorUserId` may be null for system-initiated actions. `detail` must not
     * contain secrets — the same redaction rules as logging apply (docs/17 §10).
     */
    async record({ actorUserId = null, action, targetType = null, targetId = null, detail = null, ip = null }) {
      const [row] = await exec('audit_log', () => db.insert(auditLogs)
        .values({ actorUserId, action, targetType, targetId, detail, ip }).returning());
      return row;
    },

    async listAsAdmin({ action, targetType, targetId, limit = 100 } = {}, reason) {
      requireSystemReason(reason);
      const conds = [];
      if (action) conds.push(eq(auditLogs.action, action));
      if (targetType) conds.push(eq(auditLogs.targetType, targetType));
      if (targetId) conds.push(eq(auditLogs.targetId, targetId));
      const q = db.select().from(auditLogs);
      const filtered = conds.length ? q.where(and(...conds)) : q;
      return exec('audit_log', () => filtered.orderBy(desc(auditLogs.createdAt)).limit(Math.min(limit, 500)));
    },
  };
};
