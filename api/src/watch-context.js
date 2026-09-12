// WATCH REQUEST CONTEXT (T-801 / T-1001, docs/12 §4)
//
// The one place a public watch request is turned into an authorisation
// decision: resolve the optional viewer, the presented share link and the
// access token, then ask `authz.resolveWatchAccess`. Shared by the watch
// router (payload / media / playlists / transcript) and the engagement router
// (views / progress / comments / reactions), so every public route gates the
// same way — there is no second copy of the matrix anywhere.
'use strict';

const { forbidden, notFound, ApiError } = require('./errors');
const authz = require('./authz');

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * @param {object} deps
 * @param {() => object} deps.repositories
 * @param {(req) => Promise<{id: string, isAdmin?: boolean}|null>} deps.viewer  optional-auth resolver
 * @param {string} deps.accessSecret
 * @param {() => number} [deps.now]
 */
function createWatchContext({ repositories, viewer, accessSecret, now = () => Date.now() }) {
  if (typeof viewer !== 'function') throw new Error('createWatchContext: viewer(req) resolver is required');
  if (!accessSecret || String(accessSecret).length < 16) throw new Error('createWatchContext: accessSecret (≥ 16 chars) is required');

  /** Express middleware for `/watch/:id*`: viewer, access token, share link → req.* */
  const middleware = asyncRoute(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    req.watchViewer = await viewer(req);          // null = anonymous
    const tokenIn = req.get('x-watch-access') || (typeof req.query.a === 'string' ? req.query.a : null);
    req.watchAccess = tokenIn ? authz.verifyAccess(accessSecret, tokenIn, { rec: req.params.id, now }) : null;
    req.watchAccessToken = req.watchAccess ? tokenIn : null;
    const s = typeof req.query.s === 'string' ? req.query.s : (typeof req.query.shareToken === 'string' ? req.query.shareToken : null);
    req.shareTokenPresented = !!s;
    req.shareLink = s && s.length <= 256 ? await repositories().shareLinks.findByTokenHashForWatch(authz.hashShareToken(s)) : null;
    next();
  });

  /**
   * Load + authorise. Throws the gate errors (404 / 401 login_required /
   * 403 link_expired / 403 password_required with `.gate` / 403 email_required
   * when `forMedia`); returns { recording, decision, repos }.
   */
  async function authorise(req, { forMedia = false } = {}) {
    const repos = repositories();
    const recording = await repos.recordings.getForPublicWatch(req.params.id);
    if (!recording) throw notFound('recording_not_found', 'Recording not found');
    const v = req.watchViewer;
    const workspaceRole = recording.privacy === 'workspace' && v && recording.workspaceId
      ? await repos.workspaces.memberRole(recording.workspaceId, v.id) : null;
    const decision = authz.resolveWatchAccess({ recording, viewer: v, shareLink: req.shareLink, shareTokenPresented: req.shareTokenPresented, access: req.watchAccess, workspaceRole, now });
    if (!decision.ok) {
      if (decision.reason === 'not_found') throw notFound('recording_not_found', 'Recording not found');
      if (decision.reason === 'link_expired') throw forbidden('link_expired', 'This share link is no longer valid.');
      if (decision.reason === 'login_required') throw new ApiError(401, 'login_required', 'Sign in to watch this video.', { meta: { title: recording.title } });
      // password_required is a 200 gate on GET /watch, a 403 elsewhere.
      const err = forbidden('password_required', 'This video is password protected.', { meta: { title: recording.title } });
      err.gate = { recording, shareLink: decision.shareLink };
      throw err;
    }
    if (forMedia && !authz.leadGateSatisfied(recording, decision, req.watchAccess)) {
      throw forbidden('email_required', 'Enter your email to watch this video.', { meta: { requiresEmail: true, title: recording.title } });
    }
    decision.viewerPresent = !!v;
    return { recording, decision, repos };
  }

  return { middleware, authorise };
}

module.exports = { createWatchContext, asyncRoute };
