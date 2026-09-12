// T-1001 /api/v1 engagement (run: cd api && npm run test:engagement)
//
// Real PostgreSQL. Views (one row per viewer key: user → visitorId → salted
// daily IP hash; owner rows recorded but never counted), progress (monotonic,
// completed ≥ 0.9), comments (audience gate, one reply level, signed-in
// identity from the session, owner/author removal), reactions (appended
// events), the analytics event log, the shared watch authorisation (privacy,
// share links) and the rate limits. Nothing here touches a JSON store.
//
// SKIPS LOUDLY without PostgreSQL; ENGAGEMENT_TESTS_REQUIRED=1 makes that a failure.
'use strict';

const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const API_DIR = path.join(ROOT, 'api');
const express = require(path.join(API_DIR, 'node_modules', 'express'));
const { loadEnv, createPool, createClient, createRepositories } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));
const { createEngagementRouter } = require(path.join(API_DIR, 'src', 'index.js'));
const { wireComment, wireReaction } = require(path.join(API_DIR, 'src', 'engagement.router.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.ENGAGEMENT_TESTS_REQUIRED === '1';
const RUN = crypto.randomBytes(3).toString('hex');
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

(async () => {
  console.log('T-1001 engagement endpoint tests');
  console.log('\nA. Wire shapes');
  const c = wireComment({ id: 'cmt_1', authorName: 'A', body: 'hi', t: '12.000', createdAt: new Date(5), parentId: null, userId: 'usr_x', deletedAt: null });
  ok(c.name === 'A' && c.text === 'hi' && c.t === 12 && c.at === 5 && c.verified === true && c.removed === false && !('userId' in c) && !('body' in c), 'a comment is {id,name,text,t,at,parentId,verified,removed} — the legacy card shape plus flags, no user id');
  ok(wireComment({ id: 'x', authorName: 'A', body: 'secret', deletedAt: new Date(), createdAt: new Date() }).text === '' && wireReaction({ id: 'r', emoji: '🔥', t: null, createdAt: new Date(7), authorName: null, userId: null }).at === 7, 'a removed comment renders empty text; reactions carry emoji/t/at/name');

  let env = null, pgUp = false, pool = null;
  try { env = loadEnv({ appEnv: 'test' }); } catch (e) { console.log('  env:', e.message); }
  if (env) { pool = createPool({ env, max: 6 }); try { await pool.query('select 1'); pgUp = true; } catch {} }
  if (!pgUp) {
    console.log('\n  SKIPPED B–G — PostgreSQL unreachable');
    if (REQUIRED) { fail += 1; console.log('  FAIL: ENGAGEMENT_TESTS_REQUIRED=1 but PostgreSQL is unavailable'); }
    if (pool) await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; return;
  }
  const db = createClient(pool);
  const repositories = () => createRepositories(db);
  const repos = repositories();
  const legacy = { alice: `a${RUN}`, bob: `b${RUN}`, carol: `c${RUN}` };
  const pg = (u) => `usr_${legacy[u]}`;
  for (const u of ['alice', 'bob', 'carol']) await db.execute(sql`INSERT INTO users (id,email,name,password_hash,is_admin) VALUES (${pg(u)}, ${`${u}-t1001-${RUN}@example.com`}, ${u === 'alice' ? 'Alice Owner' : u === 'bob' ? 'Bob Viewer' : 'Carol Admin'}, 'x', ${u === 'carol'})`);
  const rid = (k) => `rec_t1001_${k}_${RUN}`;
  const mkRec = async (k, { privacy = 'unlisted', audience = {} } = {}) => { await db.execute(sql`INSERT INTO recordings (id,user_id,title,status,source_kind,privacy,audience) VALUES (${rid(k)}, ${pg('alice')}, ${`Eng ${k}`}, 'ready', 'extension', ${privacy}, ${JSON.stringify(audience)}::jsonb)`); return rid(k); };

  let clock = Date.now(); const now = () => clock;
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createEngagementRouter({
    repositories, accessSecret: 'engagement-test-secret-0123456789', logger: silent, now, ipSalt: `salt-${RUN}`,
    viewer: async (req) => { const u = req.get('x-viewer'); return u ? { id: pg(u), isAdmin: u === 'carol' } : null; },
    rateLimits: { view: { max: 8, windowMs: 60000 }, engage: { max: 3, windowMs: 60000 } },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const api = async (method, p, { as, body, ip = '10.1.1.1', headers = {} } = {}) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(as ? { 'x-viewer': as } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const code = (r) => r.body && r.body.error && r.body.error.code;
  const sessions = (id) => db.execute(sql`select viewer_key, viewer_user_id, visitor_id, ip_hash, is_owner, max_progress, completed from view_sessions where recording_id = ${id} order by created_at`).then((r) => r.rows);

  try {
    console.log('\nB. Views: one row per viewer key, owner never counted');
    const A = await mkRec('a');
    const v1 = await api('POST', `/watch/${A}/view`, { body: { visitorId: 'vis-1' }, ip: '10.0.0.1' });
    ok(v1.status === 200 && v1.body.views === 1, 'an anonymous viewer with a visitorId counts once');
    ok((await api('POST', `/watch/${A}/view`, { body: { visitorId: 'vis-1' }, ip: '10.0.0.9' })).body.views === 1, 'the same visitorId from another IP is the same viewer');
    ok((await api('POST', `/watch/${A}/view`, { body: {}, ip: '10.0.0.2' })).body.views === 2 && (await api('POST', `/watch/${A}/view`, { body: {}, ip: '10.0.0.2' })).body.views === 2, 'no visitorId → the (hashed) IP is the key, still counted once');
    const own = await api('POST', `/watch/${A}/view`, { as: 'alice', ip: '10.0.0.3' });
    ok(own.body.views === 2 && own.body.self === true, 'the owner\'s own view is recorded but not counted (by user id)');
    ok((await api('POST', `/watch/${A}/view`, { as: 'bob', body: { visitorId: 'vis-1' }, ip: '10.0.0.1' })).body.views === 3, 'a signed-in viewer is keyed by user id, even with a visitorId');
    const rows = await sessions(A);
    ok(rows.length === 4 && rows.find((r) => r.is_owner).viewer_user_id === pg('alice') && rows.every((r) => !r.ip_hash || /^[0-9a-f]{32}$/.test(r.ip_hash)) && !rows.some((r) => (r.viewer_key || '').includes('10.0.0')), 'four rows: user/visitor/ip keys, the IP stored only as a salted hash, the owner flagged');
    const ev = (await db.execute(sql`select event, user_id from analytics_events where recording_id = ${A} order by id`)).rows;
    ok(ev.filter((e) => e.event === 'view').length === 5 && !ev.some((e) => e.user_id === pg('alice')), 'analytics_events records every non-owner view call (a repeat view is still a behaviour fact), never the owner');

    console.log('\nC. Progress: monotonic max, completed at 90 %');
    ok((await api('POST', `/watch/${A}/progress`, { body: { pct: 0.4, visitorId: 'vis-1' }, ip: '10.0.0.1' })).status === 204, 'progress → 204');
    await api('POST', `/watch/${A}/progress`, { body: { pct: 0.2, visitorId: 'vis-1' }, ip: '10.0.0.1' });
    let s = (await sessions(A)).find((r) => r.visitor_id === 'vis-1');
    ok(Number(s.max_progress) === 0.4 && s.completed === false, 'a smaller beacon never regresses max_progress');
    await api('POST', `/watch/${A}/progress`, { body: { pct: 0.95, visitorId: 'vis-1' }, ip: '10.0.0.1' });
    s = (await sessions(A)).find((r) => r.visitor_id === 'vis-1');
    ok(Number(s.max_progress) === 0.95 && s.completed === true, '≥ 0.9 marks the session completed');
    ok((await api('POST', `/watch/${A}/progress`, { body: { pct: 'x' } })).status === 204 && (await api('POST', `/watch/${A}/progress`, { body: { pct: 0.5, visitorId: 'never-viewed' }, ip: '10.0.0.8' })).status === 204, 'garbage or an unknown session is a silent 204 (sendBeacon has no listener)');

    console.log('\nD. Comments: gate, identity, replies, moderation');
    ok(code(await api('POST', `/watch/${A}/comment`, { body: { text: '' } })) === 'invalid_request', 'empty text → 400');
    const c1 = await api('POST', `/watch/${A}/comment`, { body: { text: 'First!', name: '  Zed  ', t: 12.7 }, ip: '10.2.0.1' });
    ok(c1.status === 201 && c1.body.name === 'Zed' && c1.body.text === 'First!' && c1.body.t === 12 && c1.body.verified === false && c1.body.parentId === null, 'an anonymous comment carries the display name (trimmed), floored t, unverified');
    const c2 = await api('POST', `/watch/${A}/comment`, { as: 'bob', body: { text: 'Hi from Bob', name: 'Impostor' }, ip: '10.2.0.2' });
    ok(c2.status === 201 && c2.body.name === 'Bob Viewer' && c2.body.verified === true, 'a signed-in commenter is named from the account, never from the form');
    const reply = await api('POST', `/watch/${A}/comment`, { body: { text: 'reply', parentId: c1.body.id }, ip: '10.2.0.3' });
    ok(reply.status === 201 && reply.body.parentId === c1.body.id, 'one level of replies');
    ok(code(await api('POST', `/watch/${A}/comment`, { body: { text: 'deeper', parentId: reply.body.id }, ip: '10.2.0.4' })) === 'comment_depth', 'a reply to a reply → 400 comment_depth');
    ok(code(await api('POST', `/watch/${A}/comment`, { body: { text: 'x', parentId: 'cmt_nope' }, ip: '10.2.0.5' })) === 'invalid_request', 'a reply to an unknown comment → 400');
    const eng = await api('GET', `/watch/${A}/engagement`);
    ok(eng.status === 200 && eng.body.views === 3 && eng.body.comments.length === 3 && eng.body.comments[0].id === c1.body.id && eng.body.comments.every((x) => typeof x.at === 'number'), 'GET /engagement lists views + comments oldest first in the card shape');
    ok((await api('DELETE', `/watch/${A}/comments/${c2.body.id}`, { ip: '10.2.0.6' })).status === 403 && (await api('DELETE', `/watch/${A}/comments/${c2.body.id}`, { as: 'alice', headers: { 'x-viewer': 'bob' } })).status === 200, 'anonymous cannot remove; the signed-in author can');
    ok((await api('DELETE', `/watch/${A}/comments/${c1.body.id}`, { as: 'alice' })).status === 200 && (await api('DELETE', `/watch/${A}/comments/${reply.body.id}`, { as: 'carol' })).status === 200, 'the owner and an admin can moderate any comment');
    const after = await api('GET', `/watch/${A}/engagement`);
    ok(after.body.comments.length === 0, 'removed comments leave the public list');
    ok((await api('DELETE', `/watch/${A}/comments/cmt_nope`, { as: 'alice' })).status === 404, 'an unknown comment → 404');
    const Q = await mkRec('quiet', { audience: { comments: false, reactions: false } });
    ok(code(await api('POST', `/watch/${Q}/comment`, { body: { text: 'no' }, ip: '10.3.0.1' })) === 'audience_disabled' && (await api('POST', `/watch/${Q}/comment`, { as: 'alice', body: { text: 'owner note' }, ip: '10.3.0.2' })).status === 201, 'audience.comments=false blocks viewers, not the owner');

    console.log('\nE. Reactions');
    ok(code(await api('POST', `/watch/${A}/react`, { body: { emoji: '' }, ip: '10.4.0.1' })) === 'invalid_request' && code(await api('POST', `/watch/${A}/react`, { body: { emoji: 'toolongemoji' }, ip: '10.4.0.1' })) === 'invalid_request', 'emoji required, at most 8 characters');
    const r1 = await api('POST', `/watch/${A}/react`, { body: { emoji: '🔥', t: 3.9, name: 'Zed' }, ip: '10.4.0.2' });
    ok(r1.status === 201 && r1.body.reactions.length === 1 && r1.body.reactions[0].emoji === '🔥' && r1.body.reactions[0].t === 3 && r1.body.reactions[0].name === 'Zed', 'a reaction is appended and the list returned');
    const r2 = await api('POST', `/watch/${A}/react`, { as: 'bob', body: { emoji: '🎉' }, ip: '10.4.0.3' });
    ok(r2.body.reactions.length === 2 && r2.body.reactions[1].name === 'Bob Viewer' && r2.body.reactions[1].verified === true, 'reactions are events, never a tally; signed-in ones are verified');
    ok(code(await api('POST', `/watch/${Q}/react`, { body: { emoji: '👍' }, ip: '10.4.0.4' })) === 'audience_disabled', 'audience.reactions=false blocks viewers');
    const evs = (await db.execute(sql`select event from analytics_events where recording_id = ${A}`)).rows.map((e) => e.event);
    ok(evs.filter((e) => e === 'comment').length === 3 && evs.filter((e) => e === 'reaction').length === 2, 'analytics_events records comments and reactions');

    console.log('\nF. Authorisation is the shared watch context');
    const L = await mkRec('login', { privacy: 'login' });
    ok((await api('POST', `/watch/${L}/view`, { body: {}, ip: '10.5.0.1' })).status === 401 && (await api('GET', `/watch/${L}/engagement`)).status === 401 && (await api('POST', `/watch/${L}/comment`, { body: { text: 'x' }, ip: '10.5.0.2' })).status === 401, 'login-only: anonymous engagement is 401 login_required everywhere');
    ok((await api('POST', `/watch/${L}/view`, { as: 'bob' })).body.views === 1, 'a signed-in viewer may');
    const token = crypto.randomBytes(16).toString('base64url');
    await repos.shareLinks.create({ userId: pg('alice') }, L, { tokenHash: sha256(token), label: 'e' });
    ok((await api('GET', `/watch/${L}/engagement?s=${token}`)).status === 200 && (await api('POST', `/watch/${L}/comment?s=${token}`, { body: { text: 'via link' }, ip: '10.5.0.3' })).status === 201, 'a live share link satisfies the gate for engagement too');
    ok((await api('GET', `/watch/${L}/engagement?s=nope`)).status === 403 && (await api('POST', `/watch/rec_nope/view`, { body: {} })).status === 404, 'a dead link is link_expired; an unknown id 404');

    console.log('\nG. Rate limits (per IP, fixed window)');
    const hits = []; for (let i = 0; i < 4; i += 1) hits.push(await api('POST', `/watch/${A}/react`, { body: { emoji: '👍' }, ip: '10.9.9.9' }));
    ok(hits.slice(0, 3).every((h) => h.status === 201) && hits[3].status === 429 && code(hits[3]) === 'rate_limited', 'reactions/comments share the engage budget (30/min·IP in production; 3 here)');
    const views = []; for (let i = 0; i < 9; i += 1) views.push(await api('POST', `/watch/${A}/view`, { body: { visitorId: `v${i}` }, ip: '10.9.9.8' }));
    ok(views.slice(0, 8).every((h) => h.status === 200) && views[8].status === 429, 'views/progress share the view budget (60/min·IP in production; 8 here)');
    clock += 61000;
    ok((await api('POST', `/watch/${A}/react`, { body: { emoji: '👍' }, ip: '10.9.9.9' })).status === 201, 'the window resets');
  } finally {
    server.close();
    await db.execute(sql`delete from users where id in (${pg('alice')}, ${pg('bob')}, ${pg('carol')})`).catch(() => {});
    await pool.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
