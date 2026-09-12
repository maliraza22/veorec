// /api/v1 watch (T-801, docs/08 §7, docs/11 §1–§2, docs/12)
//
// The public, privacy-aware read side of a recording:
//
//   GET  /watch/:id              WatchPayload (no media URLs) or the gates
//   POST /watch/:id/unlock       password → WatchPayload + accessToken
//   GET  /watch/:id/media        signed media URLs, TTL by privacy
//   GET  /watch/:id/hls/:file    playlist rewrite proxy (playlists ONLY)
//   GET  /watch/:id/transcript   the transcript with its real status
//   POST /watch/:id/lead         email gate → accessToken with a 'lead' grant
//
// Every route authorises through ONE resolver (`authz.resolveWatchAccess`);
// media URLs are minted only after that decision, bound to the exact object
// key, and expire (10 min private-ish / 24 h public). The API serves no video
// bytes: playlists are tiny text files rewritten to presigned segment URLs and
// segments go straight to storage. No storage key ever leaves this router.
//
// Auth is OPTIONAL here: `viewer(req)` resolves a Bearer token to a viewer or
// null, and a missing/invalid token is anonymous, never a 401 — the privacy
// level decides. Unknown, deleted or unauthorised-workspace ids are 404.
'use strict';

const express = require('express');
const { errorHandler, badRequest, forbidden, notFound, ApiError } = require('./errors');
const authz = require('./authz');
const { createRateLimiter, ipOf } = require('./rate-limit');
const { createWatchContext } = require('./watch-context');
const { transcriptBody } = require('./ai.router');
const { legacyPosterUrl: legacyPoster } = require('./legacy-media');   // T-803: the READ fallback for un-backfilled rows

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const REASON = 'T-801 watch: public read path (authorised by authz.resolveWatchAccess before every call)';
const HLS_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const POSTER_TTL_SECONDS = authz.TTL_PUBLIC_SECONDS;
const M3U8 = 'application/vnd.apple.mpegurl';

const DEFAULT_LIMITS = {
  watch: { max: 120, windowMs: 60 * 1000 },          // docs/12 §6: /watch/* per IP
  unlock: { max: 10, windowMs: 15 * 60 * 1000 },     // docs/08 §7: 10/15 min·IP
  lead: { max: 30, windowMs: 60 * 1000 },
};

/**
 * @param {object} deps
 * @param {() => object} deps.repositories
 * @param {object} deps.storage           StorageProvider (getSignedDownloadUrl, getObjectBuffer)
 * @param {object} deps.keys              key contract (hlsSegment)
 * @param {(req) => Promise<{id: string, isAdmin?: boolean}|null>} deps.viewer  optional-auth resolver
 * @param {string} deps.accessSecret      HMAC secret for watch access tokens
 * @param {(password, hash) => Promise<boolean>} [deps.verifyPassword]
 * @param {() => boolean} [deps.configured]   STT configured (transcript shape)
 * @param {string} [deps.publicBaseUrl]   absolute base for proxy URLs (default: derived from the request)
 * @param {object} [deps.rateLimits]      { watch, unlock, lead } overrides
 * @param {() => number} [deps.now]
 * @param {object} [deps.logger]
 */
function createWatchRouter({ repositories, storage, keys, viewer, accessSecret, verifyPassword = authz.createPasswordVerifier(), configured = () => false, publicBaseUrl = null, rateLimits = {}, now = () => Date.now(), logger = console }) {
  if (!storage || typeof storage.getSignedDownloadUrl !== 'function' || typeof storage.getObjectBuffer !== 'function') throw new Error('createWatchRouter: storage with getSignedDownloadUrl/getObjectBuffer is required');
  if (!keys || typeof keys.hlsSegment !== 'function') throw new Error('createWatchRouter: keys is required');
  if (typeof viewer !== 'function') throw new Error('createWatchRouter: viewer(req) resolver is required');
  if (!accessSecret || String(accessSecret).length < 16) throw new Error('createWatchRouter: accessSecret (≥ 16 chars) is required');

  const limits = { ...DEFAULT_LIMITS, ...rateLimits };
  const limiter = {
    watch: createRateLimiter({ ...limits.watch, keyOf: ipOf, now }),
    unlock: createRateLimiter({ ...limits.unlock, keyOf: ipOf, now, name: 'rate_limited' }),
    lead: createRateLimiter({ ...limits.lead, keyOf: ipOf, now }),
  };
  const router = express.Router();

  // ── request context: viewer, share link, access token (shared with the
  //    engagement router — ONE resolver for every public route, T-1001) ────
  const ctx = createWatchContext({ repositories, viewer, accessSecret, now });
  router.use('/watch/:id', limiter.watch.middleware);
  router.use('/watch/:id', ctx.middleware);

  const baseUrlOf = (req) => {
    if (publicBaseUrl) return publicBaseUrl.replace(/\/$/, '');
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
    return `${proto}://${req.get('host')}${req.baseUrl || ''}`;
  };

  /** Load + authorise (the shared resolver). Throws the gate errors; returns { recording, decision, repos }. */
  const authorise = ctx.authorise;

  /** A share-link watch counts against max_views; racing past the cap is a dead link. */
  async function countShareView(repos, decision) {
    if (decision.via !== 'share' || !decision.shareLink) return;
    const counted = await repos.shareLinks.countViewSystem(decision.shareLink.id, REASON);
    if (!counted) throw forbidden('link_expired', 'This share link is no longer valid.');
  }

  async function payloadFor(repos, recording, decision, access) {
    const [owner, views] = await Promise.all([repos.users.findById(recording.userId), repos.viewSessions.countUnique(recording.id)]);
    const privileged = decision.isOwner || decision.isAdmin;
    const audience = recording.audience || {};
    return {
      id: recording.id,
      title: recording.title,
      description: recording.description || '',
      status: recording.status,
      failureCode: privileged ? (recording.failureCode ?? null) : null,
      duration: numOrNull(recording.duration),
      width: recording.width ?? null,
      height: recording.height ?? null,
      privacy: recording.privacy,
      created_at: recording.createdAt,
      author: { name: owner ? owner.name : 'VeoRec user' },
      branding: !(recording.removeBranding ?? false),
      chapters: recording.chapters ?? [],
      audience,
      cta: recording.cta ?? null,
      trimStart: numOrNull(recording.trimStart),
      trimEnd: numOrNull(recording.trimEnd),
      segments: recording.segments ?? null,
      recommendedSpeed: numOrNull(recording.recommendedSpeed),
      animatedThumbnail: recording.animatedThumbnail,
      archived: !!recording.archived,
      tags: recording.tags ?? [],
      ai_status: recording.aiStatus ?? null,
      views,
      requiresEmail: !authz.leadGateSatisfied(recording, decision, access),
      viewer: { isOwner: decision.isOwner, isAdmin: decision.isAdmin, via: decision.via, signedIn: !!decision.viewerPresent },
    };
  }

  const gateResponse = (res, err) => res.status(200).json({ id: err.gate.recording.id, title: err.gate.recording.title, requiresPassword: true, shareLink: err.gate.shareLink ? { label: err.gate.shareLink.label ?? null } : null });

  // ── GET /watch/:id ─────────────────────────────────────────────────────
  router.get('/watch/:id', asyncRoute(async (req, res, next) => {
    let ctx;
    try { ctx = await authorise(req); } catch (err) { if (err.gate) return gateResponse(res, err); return next(err); }
    const { repos, recording, decision } = ctx;
    await countShareView(repos, decision);
    decision.viewerPresent = !!req.watchViewer;
    return res.json(await payloadFor(repos, recording, decision, req.watchAccess));
  }));

  // ── POST /watch/:id/unlock ─────────────────────────────────────────────
  router.post('/watch/:id/unlock', limiter.unlock.middleware, asyncRoute(async (req, res) => {
    const repos = repositories();
    const recording = await repos.recordings.getForPublicWatch(req.params.id);
    if (!recording) throw notFound('recording_not_found', 'Recording not found');
    const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
    const grants = new Set((req.watchAccess && req.watchAccess.grants) || []);

    if (req.shareTokenPresented) {
      const state = authz.shareLinkState(req.shareLink, now);
      if (state !== 'valid' || req.shareLink.recordingId !== recording.id) throw forbidden('link_expired', 'This share link is no longer valid.');
      if (req.shareLink.passwordHash) {
        if (!(await verifyPassword(password, req.shareLink.passwordHash))) throw new ApiError(401, 'invalid_password', 'Incorrect password.');
        grants.add(`share:${req.shareLink.id}`);
      }
    } else if (recording.privacy === 'password' && recording.passwordHash) {
      if (!(await verifyPassword(password, recording.passwordHash))) throw new ApiError(401, 'invalid_password', 'Incorrect password.');
      grants.add('password');
    }
    const exp = Math.floor(now() / 1000) + authz.ACCESS_TOKEN_TTL_SECONDS;
    const accessToken = grants.size ? authz.signAccess(accessSecret, { rec: recording.id, grants: [...grants], exp, sub: req.watchViewer ? req.watchViewer.id : null }, now) : null;
    req.watchAccess = accessToken ? authz.verifyAccess(accessSecret, accessToken, { rec: recording.id, now }) : req.watchAccess;
    // Re-run the ONE resolver with the new grant — never a second inline check.
    const { decision } = await authorise(req);
    await countShareView(repos, decision);
    decision.viewerPresent = !!req.watchViewer;
    logger.info({ recording_id: recording.id, via: decision.via, request_id: req.id || null }, 'T-801: watch unlocked');
    return res.json({ ...(await payloadFor(repos, recording, decision, req.watchAccess)), accessToken, accessExpiresAt: accessToken ? new Date(exp * 1000).toISOString() : null });
  }));

  // ── GET /watch/:id/media ───────────────────────────────────────────────
  router.get('/watch/:id/media', asyncRoute(async (req, res) => {
    const { repos, recording, decision } = await authorise(req, { forMedia: true });
    const assets = await repos.assets.listByRecordingSystem(recording.id, REASON);
    const ready = (kind, variant) => assets.find((a) => a.kind === kind && a.status === 'ready' && (variant === undefined || (a.variant ?? null) === variant));
    const mp4 = ready('mp4', 'main') || ready('mp4');
    const poster = ready('poster', null) || ready('poster');
    const captions = ready('captions_vtt');
    const hls = ready('hls');
    const ttl = authz.mediaTtlSeconds(recording, decision.via);
    const attachment = req.query.disposition === 'attachment';
    const privileged = decision.isOwner || decision.isAdmin;
    if (attachment && !privileged && (recording.audience || {}).download === false) throw forbidden('audience_disabled', 'Downloads are disabled for this video.');

    const sign = (key, opts = {}) => storage.getSignedDownloadUrl(key, { expiresIn: ttl, ...opts });
    const [mp4Url, posterUrl, captionsUrl] = await Promise.all([
      mp4 ? sign(mp4.storageKey, attachment ? { responseContentDisposition: `attachment; filename="${safeFilename(recording.title)}.mp4"`, responseContentType: 'video/mp4' } : {}) : null,
      poster ? storage.getSignedDownloadUrl(poster.storageKey, { expiresIn: POSTER_TTL_SECONDS }) : null,
      captions ? sign(captions.storageKey, { responseContentType: 'text/vtt' }) : null,
    ]);
    // hls.js cannot send our Bearer, so gated recordings get a playlist-scoped
    // token in the URL instead; public/unlisted playlists need none.
    let hlsUrl = null;
    if (hls && !attachment) {
      const gated = !['public', 'unlisted'].includes(decision.via) || (recording.audience || {}).requireEmail === true;
      const q = gated ? `?a=${encodeURIComponent(authz.signAccess(accessSecret, { rec: recording.id, grants: ['hls'], exp: Math.floor(now() / 1000) + ttl, sub: req.watchViewer ? req.watchViewer.id : null }, now))}` : '';
      hlsUrl = `${baseUrlOf(req)}/watch/${encodeURIComponent(recording.id)}/hls/master.m3u8${q}`;
    }
    // T-803 (docs/23 Phase 7): a legacy recording the backfill has not reached
    // has no v1 playable asset yet — its Cloudinary URL stays the READ fallback
    // (no signature, no expiry; a plain read of the legacy media map, never a
    // listing or a write). The moment an MP4/HLS asset lands, this branch is
    // never taken again for that recording.
    if (!mp4Url && !hlsUrl && recording.status === 'ready') {
      const legacyUrl = (await repos.recordings.legacyMediaSystem([recording.id], REASON)).get(recording.id);
      if (legacyUrl) {
        return res.json({
          status: recording.status,
          mp4Url: legacyUrl, hlsUrl: null,
          posterUrl: posterUrl || legacyPoster(legacyUrl), captionsUrl,
          expiresAt: null, ttlSeconds: null, legacyMedia: true,
          download: privileged || (recording.audience || {}).download !== false,
        });
      }
    }
    return res.json({
      status: recording.status,
      mp4Url, hlsUrl, posterUrl, captionsUrl,
      expiresAt: new Date(now() + ttl * 1000).toISOString(),
      ttlSeconds: ttl, legacyMedia: false,
      download: privileged || (recording.audience || {}).download !== false,
    });
  }));

  // ── GET /watch/:id/hls/:file — playlists only (docs/12 §5.2) ───────────
  router.get('/watch/:id/hls/:file', asyncRoute(async (req, res) => {
    const file = req.params.file;
    if (!HLS_FILE_RE.test(file)) throw badRequest('invalid_request', 'Invalid playlist name.');
    if (!file.endsWith('.m3u8')) throw notFound('object_not_found', 'Only playlists are served here; media segments are fetched from storage directly.');
    const repos = repositories();
    const recording = await repos.recordings.getForPublicWatch(req.params.id);
    if (!recording) throw notFound('recording_not_found', 'Recording not found');
    // A playlist-scoped token minted by /media is sufficient; otherwise the full resolver decides.
    const hlsGrant = req.watchAccess && req.watchAccess.grants.includes('hls');
    let via = 'hls_token', ttl = authz.TTL_PRIVATE_SECONDS;
    if (!hlsGrant) {
      const { decision } = await authorise(req, { forMedia: true });
      via = decision.via; ttl = authz.mediaTtlSeconds(recording, decision.via);
    }
    const asset = (await repos.assets.listByRecordingSystem(recording.id, REASON)).find((a) => a.kind === 'hls' && a.status === 'ready');
    if (!asset) throw notFound('object_not_found', 'No HLS package for this recording.');
    const key = file === 'master.m3u8' ? asset.storageKey : keys.hlsSegment(recording.id, asset.id, file);
    let text;
    try { text = (await storage.getObjectBuffer(key)).body.toString('utf8'); } catch (e) { if (e && e.code === 'object_not_found') throw notFound('object_not_found', 'Playlist not found.'); throw e; }
    const tokenQs = req.watchAccessToken ? `?a=${encodeURIComponent(req.watchAccessToken)}` : '';
    const proxyBase = `${baseUrlOf(req)}/watch/${encodeURIComponent(recording.id)}/hls/`;
    const presign = (name) => storage.getSignedDownloadUrl(keys.hlsSegment(recording.id, asset.id, name), { expiresIn: ttl });
    const out = await rewritePlaylist(text, {
      playlistUrl: (name) => `${proxyBase}${name}${tokenQs}`,
      segmentUrl: presign,
    });
    logger.debug && logger.debug({ recording_id: recording.id, file, via }, 'T-801: playlist served');
    res.set('Content-Type', M3U8);
    res.set('Cache-Control', 'no-store');
    return res.send(out);
  }));

  // ── GET /watch/:id/transcript ──────────────────────────────────────────
  router.get('/watch/:id/transcript', asyncRoute(async (req, res) => {
    const { repos, recording, decision } = await authorise(req, { forMedia: true });
    if (!(decision.isOwner || decision.isAdmin) && (recording.audience || {}).transcript === false) throw forbidden('audience_disabled', 'The transcript is not available for this video.');
    const t = await repos.transcripts.getForPublicWatch(recording.id);
    const segments = t && t.status === 'done' ? await repos.transcripts.listSegments(t.id) : [];
    return res.json(transcriptBody(t, segments, configured()));
  }));

  // ── POST /watch/:id/lead — the email gate (docs/12 §6) ─────────────────
  router.post('/watch/:id/lead', limiter.lead.middleware, asyncRoute(async (req, res) => {
    const { repos, recording, decision } = await authorise(req);
    const email = req.body && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 120) : null;
    if (!EMAIL_RE.test(email) || email.length > 254) throw badRequest('invalid_request', 'A valid email address is required.');
    await repos.leads.capture(recording.id, { email, name: name || null });
    const grants = new Set([...((req.watchAccess && req.watchAccess.grants) || []), 'lead']);
    const exp = Math.floor(now() / 1000) + authz.ACCESS_TOKEN_TTL_SECONDS;
    const accessToken = authz.signAccess(accessSecret, { rec: recording.id, grants: [...grants], exp, sub: req.watchViewer ? req.watchViewer.id : null }, now);
    logger.info({ recording_id: recording.id, via: decision.via, request_id: req.id || null }, 'T-801: lead captured');
    return res.json({ ok: true, accessToken, accessExpiresAt: new Date(exp * 1000).toISOString() });
  }));

  router.use(errorHandler(logger));
  return router;
}

/**
 * Rewrite an HLS playlist (docs/12 §5.2): every bare sibling reference becomes
 * a URL. Playlists (`*.m3u8`) point back at this proxy; init segments
 * (`#EXT-X-MAP:URI`) and media segments become presigned storage URLs.
 * Anything that is already absolute is left alone; comments/tags untouched.
 */
async function rewritePlaylist(text, { playlistUrl, segmentUrl }) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { out.push(raw); continue; }
    if (line.startsWith('#')) {
      const m = /^(#EXT-X-MAP:.*?URI=")([^"]+)(".*)$/.exec(line);
      if (m && !/^[a-z]+:\/\//i.test(m[2])) out.push(`${m[1]}${await segmentUrl(m[2])}${m[3]}`);
      else out.push(raw);
      continue;
    }
    if (/^[a-z]+:\/\//i.test(line)) { out.push(raw); continue; }
    if (!HLS_FILE_RE.test(line)) throw new ApiError(502, 'internal_error', 'The HLS package references an unexpected file.');
    out.push(line.endsWith('.m3u8') ? playlistUrl(line) : await segmentUrl(line));
  }
  return out.join('\n');
}

const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));
function safeFilename(title) {
  const s = String(title || 'video').replace(/[^\w\s.-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return s || 'video';
}

module.exports = { createWatchRouter, rewritePlaylist, safeFilename, HLS_FILE_RE, DEFAULT_LIMITS };
