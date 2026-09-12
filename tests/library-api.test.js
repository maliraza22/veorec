// T-803 /api/v1 library endpoints (run: cd api && npm run test:library)
//
// Real PostgreSQL (+ MinIO for the signed thumbnail fetch). Folders CRUD with
// the owner matrix, the query-derived notifications feed (docs/13 §6), the
// list's batched media fields (signed poster/thumbnail/preview, the Cloudinary
// READ fallback for legacy rows, views/comment counts) and the watch /media
// legacy fallback.
//
// SKIPS LOUDLY without PostgreSQL; LIBRARY_TESTS_REQUIRED=1 makes that a failure.
'use strict';

const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const API_DIR = path.join(ROOT, 'api');
const express = require(path.join(API_DIR, 'node_modules', 'express'));
const { loadEnv, createPool, createClient, createRepositories, withTransaction: rawTx } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));
const storagePkg = require(path.join(ROOT, 'storage', 'src', 'index.js'));
const { createFoldersRouter, createNotificationsRouter, createRecordingsRouter, createWatchRouter, authz } = require(path.join(API_DIR, 'src', 'index.js'));
const { summary } = require(path.join(API_DIR, 'src', 'recordings.router.js'));
const { legacyPosterUrl: cloudinaryPoster } = require(path.join(API_DIR, 'src', 'legacy-media.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.LIBRARY_TESTS_REQUIRED === '1';
const MINIO = process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100';
const RUN = crypto.randomBytes(3).toString('hex');
const REASON = 'T-803 library api test';
const silent = { info() {}, warn() {}, error() {}, debug() {} };

(async () => {
  console.log('T-803 library endpoint tests');

  console.log('\nA. Pure helpers');
  ok(cloudinaryPoster('https://res.cloudinary.com/x/video/upload/v1/screenrec/u/a.webm') === 'https://res.cloudinary.com/x/video/upload/so_0/v1/screenrec/u/a.jpg', 'the Cloudinary poster rule is the legacy one (so_0 + .jpg)');
  ok(cloudinaryPoster('https://res.cloudinary.com/x/video/upload/v1/a.mp4?x=1') === 'https://res.cloudinary.com/x/video/upload/so_0/v1/a.jpg' && cloudinaryPoster('/uploads/a.webm') === null && cloudinaryPoster(null) === null, 'only absolute Cloudinary upload URLs get a poster; local uploads and nulls do not');
  const s = summary({ id: 'r', title: 't', status: 'ready', createdAt: new Date(), privacy: 'unlisted', archived: false, description: 'd', trimStart: '1.5', animatedThumbnail: false }, { thumbnailUrl: 'T', posterUrl: 'P', previewUrl: 'W', legacyMedia: false, views: 3, commentCount: 2 });
  ok(s.thumbnailUrl === 'T' && s.posterUrl === 'P' && s.previewUrl === 'W' && s.views === 3 && s.commentCount === 2 && s.description === 'd' && s.trimStart === 1.5 && s.animatedThumbnail === false && !('storageKey' in s) && !('passwordHash' in s), 'summary carries the batched media fields and the card fields, never a key or hash');
  ok(summary({ id: 'r', status: 'ready', createdAt: new Date() }).thumbnailUrl === null && summary({ id: 'r', status: 'ready', createdAt: new Date() }).views === 0, 'without media resolution the summary is honest nulls/zeros');

  let env = null, pgUp = false, pool = null;
  try { env = loadEnv({ appEnv: 'test' }); } catch (e) { console.log('  env:', e.message); }
  if (env) { pool = createPool({ env, max: 6 }); try { await pool.query('select 1'); pgUp = true; } catch {} }
  if (!pgUp) {
    console.log('\n  SKIPPED B–F — PostgreSQL unreachable');
    if (REQUIRED) { fail += 1; console.log('  FAIL: LIBRARY_TESTS_REQUIRED=1 but PostgreSQL is unavailable'); }
    if (pool) await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; return;
  }
  let storageUp = false;
  try { storageUp = (await fetch(`${MINIO}/minio/health/live`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
  const provider = storageUp ? storagePkg.createStorageProvider({ appEnv: 'test' }) : { async getSignedDownloadUrl(key, o) { return `signed://${key}?ttl=${o.expiresIn}`; }, async putObject() {}, async deleteObjects() {}, async getObjectBuffer() { const e = new Error('nf'); e.code = 'object_not_found'; throw e; } };
  const keys = storagePkg.keys;
  const db = createClient(pool);
  const repositories = () => createRepositories(db);
  const repos = repositories();
  const withTransaction = (fn) => rawTx(fn, db);
  const legacy = { alice: `a${RUN}`, bob: `b${RUN}` };
  const pg = (u) => `usr_${legacy[u]}`;
  for (const u of ['alice', 'bob']) await db.execute(sql`INSERT INTO users (id,email,name,password_hash) VALUES (${pg(u)}, ${`${u}-t803-${RUN}@example.com`}, ${u === 'alice' ? 'Alice' : 'Bob'}, 'x')`);
  const rid = (k) => `rec_t803_${k}_${RUN}`;
  const mkRec = async (k, owner = 'alice', { status = 'ready', archived = false, folderId = null, createdAt = null, animated = true } = {}) => {
    await db.execute(sql`INSERT INTO recordings (id,user_id,title,status,source_kind,privacy,archived,folder_id,animated_thumbnail,duration,created_at) VALUES (${rid(k)}, ${pg(owner)}, ${`Rec ${k}`}, ${status}, 'extension', 'unlisted', ${archived}, ${folderId}, ${animated}, 5, ${createdAt || new Date()})`);
    return rid(k);
  };
  const uploaded = [];
  const asset = async (recId, id, kind, variant, key, bytes, contentType) => { await db.execute(sql`INSERT INTO video_assets (id,recording_id,kind,variant,storage_key,status,size_bytes,counts_toward_quota) VALUES (${id}, ${recId}, ${kind}, ${variant}, ${key}, 'ready', ${bytes.length}, false)`); await provider.putObject(key, bytes, { contentType }); uploaded.push(key); };

  let currentUser = null;
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => { if (!currentUser) return res.status(401).json({ error: { code: 'unauthorized', message: 'no' } }); req.userId = currentUser; req.id = 'req_test'; next(); };
  app.use('/api/v1', createFoldersRouter({ repositories, requireAuth, logger: silent }));
  app.use('/api/v1', createNotificationsRouter({ repositories, requireAuth, logger: silent }));
  app.use('/api/v1', createRecordingsRouter({ repositories, withTransaction, storage: provider, requireAuth, logger: silent }));
  app.use('/api/v1', createWatchRouter({ repositories, storage: provider, keys, accessSecret: 'library-test-secret-0123456789', logger: silent, viewer: async () => null }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const api = async (method, p, { as, body } = {}) => {
    if (as !== undefined) currentUser = as;
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const code = (r) => r.body && r.body.error && r.body.error.code;

  try {
    console.log('\nB. Folders CRUD (docs/08 §10)');
    ok((await api('GET', '/folders', { as: null })).status === 401, 'unauthenticated → 401');
    const empty = await api('GET', '/folders', { as: legacy.alice });
    ok(empty.status === 200 && Array.isArray(empty.body.items) && empty.body.items.length === 0, 'GET /folders → {items:[]} for a new user');
    ok(code(await api('POST', '/folders', { as: legacy.alice, body: { name: '   ' } })) === 'invalid_request' && (await api('POST', '/folders', { as: legacy.alice, body: {} })).status === 400, 'a blank name is 400 invalid_request');
    const c1 = await api('POST', '/folders', { as: legacy.alice, body: { name: '  Clients ' } });
    ok(c1.status === 201 && c1.body.id.startsWith('fld_') && c1.body.name === 'Clients' && c1.body.created_at, 'POST /folders → 201 with a trimmed name');
    const dup = await api('POST', '/folders', { as: legacy.alice, body: { name: 'clients' } });
    ok(dup.status === 409 && code(dup) === 'folder_exists', 'a duplicate name (case-insensitive) → 409 folder_exists');
    const c2 = await api('POST', '/folders', { as: legacy.alice, body: { name: 'x'.repeat(80) } });
    ok(c2.status === 201 && c2.body.name.length === 60, 'names are capped at 60');
    const bobs = await api('POST', '/folders', { as: legacy.bob, body: { name: 'Clients' } });
    ok(bobs.status === 201, 'another user may use the same name');
    ok((await api('GET', '/folders', { as: legacy.alice })).body.items.length === 2 && (await api('GET', '/folders', { as: legacy.bob })).body.items.length === 1, 'lists are owner-scoped');
    ok((await api('PATCH', `/folders/${c1.body.id}`, { as: legacy.bob, body: { name: 'Stolen' } })).status === 404 && (await api('GET', '/folders', { as: legacy.alice })).body.items.find((f) => f.id === c1.body.id).name === 'Clients', 'a non-owner PATCH is 404 and changes nothing');
    const ren = await api('PATCH', `/folders/${c1.body.id}`, { as: legacy.alice, body: { name: 'Customers' } });
    ok(ren.status === 200 && ren.body.name === 'Customers', 'the owner renames');
    ok(code(await api('PATCH', `/folders/${c1.body.id}`, { as: legacy.alice, body: { name: 'x'.repeat(60) } })) === 'folder_exists', 'renaming onto another folder\'s name → 409');
    ok((await api('PATCH', `/folders/${c1.body.id}`, { as: legacy.alice, body: { name: 'customers' } })).status === 200, 'renaming to a different case of its own name is fine');
    const inFolder = await mkRec('inf', 'alice', { folderId: c1.body.id });
    ok((await api('DELETE', `/folders/${c1.body.id}`, { as: legacy.bob })).body.removed === false && (await repos.recordings.get({ userId: pg('alice') }, inFolder)).folderId === c1.body.id, 'a non-owner DELETE removes nothing (idempotent 200, removed:false)');
    const del = await api('DELETE', `/folders/${c1.body.id}`, { as: legacy.alice });
    ok(del.status === 200 && del.body.removed === true && (await repos.recordings.get({ userId: pg('alice') }, inFolder)).folderId === null && (await api('DELETE', `/folders/${c1.body.id}`, { as: legacy.alice })).body.removed === false, 'the owner deletes; the recording stays with folder_id NULL; a repeat is idempotent');

    console.log('\nC. Notifications feed (docs/13 §6)');
    const A = await mkRec('a'); const B = await mkRec('b'); const BOB = await mkRec('bob', 'bob');
    const t = (min) => new Date(Date.now() - min * 60000);
    const ins = {
      comment: (rec, { name, userId = null, at, body = 'hi', deleted = false }) => db.execute(sql`INSERT INTO comments (id,recording_id,user_id,author_name,body,created_at,deleted_at) VALUES (${`cmt_${crypto.randomBytes(4).toString('hex')}`}, ${rec}, ${userId}, ${name}, ${body}, ${at}, ${deleted ? new Date() : null})`),
      reaction: (rec, { name, userId = null, at, emoji = '🔥' }) => db.execute(sql`INSERT INTO reactions (id,recording_id,user_id,author_name,emoji,created_at) VALUES (${`rct_${crypto.randomBytes(4).toString('hex')}`}, ${rec}, ${userId}, ${name}, ${emoji}, ${at})`),
      view: (rec, { userId = null, at, isOwner = false, key }) => db.execute(sql`INSERT INTO view_sessions (id,recording_id,viewer_user_id,viewer_key,created_at,is_owner) VALUES (${`vs_${crypto.randomBytes(4).toString('hex')}`}, ${rec}, ${userId}, ${key || `k:${crypto.randomBytes(3).toString('hex')}`}, ${at}, ${isOwner})`),
    };
    await ins.comment(A, { name: 'Zed', at: t(50), body: 'Great video' });
    await ins.comment(A, { name: 'Alice', userId: pg('alice'), at: t(1), body: 'my own reply' });     // owner by USER ID → excluded
    await ins.comment(A, { name: 'Alice', at: t(2), body: 'anonymous namesake' });                    // same display name, no user id → INCLUDED
    await ins.comment(B, { name: 'Gone', at: t(3), body: 'deleted', deleted: true });                 // moderated → excluded
    await ins.reaction(A, { name: 'Yara', at: t(30), emoji: '🎉' });
    await ins.reaction(B, { name: 'Alice', userId: pg('alice'), at: t(4) });                          // owner → excluded
    await ins.view(A, { userId: pg('bob'), at: t(20) });                                              // Bob (signed in) → name from users
    await ins.view(A, { at: t(10) });                                                                 // anonymous → Someone
    await ins.view(B, { userId: pg('alice'), at: t(5), isOwner: true });                              // owner self-view → excluded
    await ins.comment(BOB, { name: 'Zed', at: t(0.5), body: 'on Bob\'s video' });                     // not Alice's recording → excluded
    const feed = await api('GET', '/notifications', { as: legacy.alice });
    ok(feed.status === 200 && Array.isArray(feed.body.items) && typeof feed.body.unread === 'number' && feed.body.lastReadAt === 0, 'GET /notifications → {items, unread, lastReadAt} (never read → 0)');
    const kinds = feed.body.items.map((i) => `${i.type}:${i.name}`);
    ok(kinds.join() === ['comment:Alice', 'view:Someone', 'view:Bob', 'reaction:Yara', 'comment:Zed'].join(), `events newest first, owner excluded BY USER ID (namesake kept), deleted/self-view/other-owner excluded: ${kinds.join()}`);
    const cm = feed.body.items.find((i) => i.type === 'comment' && i.name === 'Zed');
    ok(cm.videoId === A && cm.videoTitle === 'Rec a' && cm.text === 'Great video' && typeof cm.at === 'number' && feed.body.items.find((i) => i.type === 'reaction').emoji === '🎉', 'events carry videoId/videoTitle/text/emoji and epoch-ms at');
    ok(feed.body.unread === 5, 'unread counts everything when never read');
    const read = await api('POST', '/notifications/read', { as: legacy.alice });
    ok(read.status === 200 && typeof read.body.lastReadAt === 'number' && read.body.lastReadAt > Date.now() - 5000, 'POST /notifications/read stamps now');
    ok((await api('GET', '/notifications', { as: legacy.alice })).body.unread === 0, 'after reading, unread is 0');
    await ins.comment(A, { name: 'Late', at: new Date(Date.now() + 1000), body: 'new' });
    const after = await api('GET', '/notifications', { as: legacy.alice });
    ok(after.body.unread === 1 && after.body.items[0].name === 'Late' && after.body.items.length === 6, 'a newer event is unread; the feed is capped and ordered');
    ok((await api('GET', '/notifications', { as: legacy.bob })).body.items.map((i) => i.name).join() === 'Zed', 'Bob sees only activity on his own recording');
    await repos.notifications.markRead({ userId: pg('alice') }, new Date(Date.now() - 3600000));
    ok((await api('GET', '/notifications', { as: legacy.alice })).body.lastReadAt === read.body.lastReadAt, 'the read marker is monotonic (an older stamp never moves it back)');

    console.log('\nD. Library list: signed thumbnails, Cloudinary fallback, counts');
    const P = await mkRec('p', 'alice', { createdAt: t(100) });
    const POSTER = crypto.randomBytes(300), THUMB = crypto.randomBytes(200), PREVIEW = crypto.randomBytes(100);
    await asset(P, `ast_pos_${RUN}`, 'poster', null, keys.image(P, `ast_pos_${RUN}`, 'poster'), POSTER, 'image/jpeg');
    await asset(P, `ast_posplay_${RUN}`, 'poster', 'play', keys.image(P, `ast_posplay_${RUN}`, 'poster'), POSTER, 'image/jpeg');
    await asset(P, `ast_thm_${RUN}`, 'thumbnail', null, keys.image(P, `ast_thm_${RUN}`, 'thumb'), THUMB, 'image/jpeg');
    await asset(P, `ast_prv_${RUN}`, 'preview_gif', null, keys.image(P, `ast_prv_${RUN}`, 'preview_webp'), PREVIEW, 'image/webp');
    const L = await mkRec('legacy', 'alice', { createdAt: t(200) });
    await db.execute(sql`INSERT INTO legacy.media_map (recording_id, legacy_provider, legacy_public_id, legacy_url) VALUES (${L}, 'cloudinary', 'screenrec/u/x', 'https://res.cloudinary.com/demo/video/upload/v1/screenrec/u/x.webm')`);
    const N = await mkRec('nothing', 'alice', { createdAt: t(300) });
    const NA = await mkRec('noanim', 'alice', { createdAt: t(400), animated: false });
    await asset(NA, `ast_prv2_${RUN}`, 'preview_gif', null, keys.image(NA, `ast_prv2_${RUN}`, 'preview_webp'), PREVIEW, 'image/webp');
    const list = await api('GET', '/recordings?limit=100', { as: legacy.alice });
    const item = (id) => list.body.items.find((i) => i.id === id);
    ok(list.status === 200 && item(P) && item(L) && item(N) && item(A), 'the list is one scoped query for the owner');
    const ip = item(P);
    ok(ip.thumbnailUrl && ip.thumbnailUrl.includes(encodeURI(keys.image(P, `ast_thm_${RUN}`, 'thumb'))) && ip.posterUrl.includes(encodeURI(keys.image(P, `ast_pos_${RUN}`, 'poster'))) && ip.previewUrl.includes('preview.webp') && ip.legacyMedia === false, 'a processed recording gets signed thumbnail (thumb asset), poster (plain poster, not the play variant) and preview URLs');
    ok(/X-Amz-Expires=86400|ttl=86400/.test(ip.thumbnailUrl), 'list images are signed for 24 h (docs/12 §5.1)');
    if (storageUp) {
      const got = await fetch(ip.thumbnailUrl);
      ok(got.status === 200 && Buffer.from(await got.arrayBuffer()).equals(THUMB), 'the thumbnail URL serves the exact object from storage');
    } else console.log('  (no MinIO: skipped the thumbnail fetch)');
    const il = item(L);
    ok(il.thumbnailUrl === 'https://res.cloudinary.com/demo/video/upload/so_0/v1/screenrec/u/x.jpg' && il.posterUrl === il.thumbnailUrl && il.legacyMedia === true && il.previewUrl === null, 'a legacy row without image assets falls back to its Cloudinary poster (a READ of legacy.media_map)');
    ok(item(N).thumbnailUrl === null && item(N).posterUrl === null && item(N).legacyMedia === false, 'nothing to show → honest nulls');
    ok(item(NA).previewUrl === null, 'animatedThumbnail=false suppresses the hover preview even when the asset exists');
    ok(item(A).views === 2 && item(A).commentCount === 4 && item(B).views === 0 && item(B).commentCount === 0, 'views count unique non-owner sessions; comments exclude deleted ones (batched per page)');
    ok(!JSON.stringify(list.body).includes('storage_key') && !JSON.stringify(list.body).includes('"storageKey"'), 'no storage key in the list');
    ok(list.body.items.every((i) => 'description' in i && 'cta' in i && 'animatedThumbnail' in i), 'summaries carry the share-settings fields');

    console.log('\nE. Watch /media legacy fallback (docs/23 Phase 7)');
    currentUser = null;
    const m = await api('GET', `/watch/${L}/media`);
    ok(m.status === 200 && m.body.mp4Url === 'https://res.cloudinary.com/demo/video/upload/v1/screenrec/u/x.webm' && m.body.legacyMedia === true && m.body.expiresAt === null && m.body.posterUrl === il.thumbnailUrl, 'a ready legacy recording without v1 media plays its Cloudinary URL (no signature, no expiry)');
    const mn = await api('GET', `/watch/${N}/media`);
    ok(mn.status === 200 && mn.body.mp4Url === null && mn.body.legacyMedia === false, 'no v1 media and no legacy map → null URLs');
    await asset(L, `ast_mp4L_${RUN}`, 'mp4', 'main', keys.derivedVideo(L, `ast_mp4L_${RUN}`), crypto.randomBytes(64), 'video/mp4');
    const m2 = await api('GET', `/watch/${L}/media`);
    ok(m2.body.legacyMedia === false && m2.body.mp4Url.includes(encodeURI(keys.derivedVideo(L, `ast_mp4L_${RUN}`))) && m2.body.expiresAt, 'once an MP4 asset lands, the fallback is never taken again');
  } finally {
    server.close();
    try { if (uploaded.length && storageUp) await provider.deleteObjects(uploaded); } catch {}
    await db.execute(sql`delete from users where id in (${pg('alice')}, ${pg('bob')})`).catch(() => {});
    await pool.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
