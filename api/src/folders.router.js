// /api/v1 folders (T-803, docs/08 §10)
//
// CRUD as today, from PostgreSQL: GET/POST /folders, PATCH/DELETE /folders/:id.
// Owner-scoped through the repositories (a folder belonging to someone else is
// 404, indistinguishable from missing); names 1–60 after trim; a duplicate
// name is 409 folder_exists; delete leaves the recordings (folder_id → NULL by
// the schema) and is idempotent.
'use strict';

const express = require('express');
const { errorHandler, badRequest, notFound, conflict } = require('./errors');
const { createIdentityBridge, scopeOf } = require('./identity');

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const MAX_NAME = 60;

const wire = (f) => ({ id: f.id, name: f.name, created_at: f.createdAt, updated_at: f.updatedAt ?? f.createdAt });

function cleanName(body) {
  const name = body && typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME) : '';
  if (!name) throw badRequest('invalid_request', 'Folder name required');
  return name;
}

function createFoldersRouter({ repositories, requireAuth, logger = console }) {
  const router = express.Router();
  router.use('/folders', requireAuth);
  router.use('/folders', createIdentityBridge({ repositories, logger }));

  async function assertUnique(repos, scope, name, exceptId = null) {
    const all = await repos.folders.list(scope);
    if (all.some((f) => f.id !== exceptId && f.name.toLowerCase() === name.toLowerCase())) throw conflict('folder_exists', 'You already have a folder with that name.');
  }

  router.get('/folders', asyncRoute(async (req, res) => {
    const items = await repositories().folders.list(scopeOf(req));
    res.set('Cache-Control', 'no-store');
    return res.json({ items: items.map(wire) });
  }));

  router.post('/folders', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const name = cleanName(req.body);
    await assertUnique(repos, scope, name);
    const created = await repos.folders.create(scope, { name });
    return res.status(201).json(wire(created));
  }));

  router.patch('/folders/:id', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const name = cleanName(req.body);
    const existing = await repos.folders.get(scope, req.params.id);
    if (!existing) throw notFound('folder_not_found', 'Folder not found');
    await assertUnique(repos, scope, name, existing.id);
    const updated = await repos.folders.rename(scope, existing.id, name);
    return res.json(wire(updated));
  }));

  router.delete('/folders/:id', asyncRoute(async (req, res) => {
    const scope = scopeOf(req);
    const repos = repositories();
    const existing = await repos.folders.get(scope, req.params.id);
    if (!existing) return res.json({ ok: true, removed: false });
    await repos.folders.remove(scope, existing.id);
    return res.json({ ok: true, removed: true });
  }));

  router.use(errorHandler(logger));
  return router;
}

module.exports = { createFoldersRouter, MAX_NAME };
