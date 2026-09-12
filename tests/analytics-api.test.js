// T-1002 / T-1003 owner analytics + paywall events (run: cd api && npm run test:analytics)
//
// Real PostgreSQL. Per-recording analytics from view_sessions (unique
// non-owner views, per-viewer progress, avg view-through, completion rate, the
// retention decile curve), the workspace overview (rollup + daily trend from
// analytics_events), the owner matrix, and the T-1003 paywall: a locked
// account gets 403 feature_locked AND one canonical `analytics_attempted`
// paywall_hit event.
//
// SKIPS LOUDLY without PostgreSQL; ANALYTICS_TESTS_REQUIRED=1 makes that a failure.
'use strict';

const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const API_DIR = path.join(ROOT, 'api');
const express = require(path.join(API_DIR, 'node_modules', 'express'));
const { loadEnv, createPool, createClient, createRepositories } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));
const { createAnalyticsRouter, triggerFor, TRIGGER_BY_FEATURE } = require(path.join(API_DIR, 'src', 'index.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.ANALYTICS_TESTS_REQUIRED === '1';
const RUN = crypto.randomBytes(3).toString('hex');
const silent = { info() {}, warn() {}, error() {}, debug() {} };

(async () => {
  console.log('T-1002/T-1003 analytics + paywall tests');
  console.log('\nA. Canonical paywall trigger names (T-1003)');
  ok(triggerFor('analyticsEnabled') === 'analytics_attempted' && triggerFor('passwordProtection') === 'password_protection_attempted' && triggerFor('removeBranding') === 'remove_branding_attempted' && triggerFor('slackEnabled') === 'advanced_sharing_attempted' && triggerFor('storageLimit') === 'storage_limit_reached' && triggerFor('recordingLimit') === 'recording_over_limit', 'feature keys map to the legacy conversion.js trigger names');
  ok(triggerFor('somethingNew') === 'somethingnew_attempted' && Object.keys(TRIGGER_BY_FEATURE).length >= 10, 'an unknown feature still gets a well-formed trigger');

  let env = null, pgUp = false, pool = null;
  try { env = loadEnv({ appEnv: 'test' }); } catch (e) { console.log('  env:', e.message); }
  if (env) { pool = createPool({ env, max: 6 }); try { await pool.query('select 1'); pgUp = true; } catch {} }
  if (!pgUp) {
    console.log('\n  SKIPPED B–E — PostgreSQL unreachable');
    if (REQUIRED) { fail += 1; console.log('  FAIL: ANALYTICS_TESTS_REQUIRED=1 but PostgreSQL is unavailable'); }
    if (pool) await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; return;
  }
  const db = createClient(pool);
  const repositories = () => createRepositories(db);
  const legacy = { alice: `a${RUN}`, bob: `b${RUN}` };
  const pg = (u) => `usr_${legacy[u]}`;
  for (const u of ['alice', 'bob']) await db.execute(sql`INSERT INTO users (id,email,name,password_hash) VALUES (${pg(u)}, ${`${u}-t1002-${RUN}@example.com`}, ${u === 'alice' ? 'Alice' : 'Bob Viewer'}, 'x')`);
  const rid = (k) => `rec_t1002_${k}_${RUN}`;
  const mkRec = async (k, owner = 'alice', daysAgo = 0) => { await db.execute(sql`INSERT INTO recordings (id,user_id,title,status,source_kind,privacy,created_at) VALUES (${rid(k)}, ${pg(owner)}, ${`Ana ${k}`}, 'ready', 'extension', 'unlisted', ${new Date(Date.now() - daysAgo * 86400000)})`); return rid(k); };
  const t = (min) => new Date(Date.now() - min * 60000);
  const view = (rec, { key, userId = null, progress = 0, isOwner = false, at = t(10) }) => db.execute(sql`INSERT INTO view_sessions (id,recording_id,viewer_user_id,viewer_key,created_at,last_seen_at,max_progress,completed,is_owner) VALUES (${`vs_${crypto.randomBytes(4).toString('hex')}`}, ${rec}, ${userId}, ${key}, ${at}, ${at}, ${String(progress)}, ${progress >= 0.9}, ${isOwner})`);
  const event = (rec, ev, at, userId = null) => db.execute(sql`INSERT INTO analytics_events (recording_id,user_id,event,props,created_at) VALUES (${rec}, ${userId}, ${ev}, '{}'::jsonb, ${at})`);

  let currentUser = null, analytics = true;
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => { if (!currentUser) return res.status(401).json({ error: { code: 'unauthorized', message: 'no' } }); req.userId = currentUser; req.id = 'req_test'; next(); };
  app.use('/api/v1', createAnalyticsRouter({ repositories, requireAuth, entitlements: { isFeatureEnabled: async (f) => f === 'analyticsEnabled' && analytics }, logger: silent }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const api = async (method, p, { as } = {}) => {
    if (as !== undefined) currentUser = as;
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' } });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const code = (r) => r.body && r.body.error && r.body.error.code;

  try {
    console.log('\nB. Per-recording analytics from view_sessions');
    const A = await mkRec('a');
    await view(A, { key: 'u:bob', userId: pg('bob'), progress: 1.0, at: t(50) });
    await view(A, { key: 'v:anon1', progress: 0.55, at: t(40) });
    await view(A, { key: 'ip:hash1', progress: 0.25, at: t(30) });
    await view(A, { key: 'v:anon2', progress: 0.95, at: t(20) });
    await view(A, { key: 'u:alice', userId: pg('alice'), progress: 1.0, isOwner: true, at: t(5) });
    await db.execute(sql`INSERT INTO comments (id,recording_id,author_name,body,created_at) VALUES (${`cmt_${RUN}`}, ${A}, 'Zed', 'nice', ${t(3)})`);
    await db.execute(sql`INSERT INTO reactions (id,recording_id,author_name,emoji,created_at) VALUES (${`rct_${RUN}`}, ${A}, 'Zed', '🔥', ${t(2)})`);
    await db.execute(sql`INSERT INTO leads (id,recording_id,email,name) VALUES (${`led_${RUN}`}, ${A}, ${`lead-${RUN}@x.co`}, 'L')`);
    ok((await api('GET', `/recordings/${A}/analytics`, { as: null })).status === 401 && (await api('GET', `/recordings/${A}/analytics`, { as: legacy.bob })).status === 404, 'unauthenticated 401; a non-owner 404');
    const a = await api('GET', `/recordings/${A}/analytics`, { as: legacy.alice });
    ok(a.status === 200 && a.body.views === 4 && a.body.uniqueViewers === 4, 'views = unique non-owner sessions (the owner\'s own session is excluded by user id)');
    ok(a.body.engagement.samples === 4 && a.body.engagement.avgViewThrough === Math.round(((1.0 + 0.55 + 0.25 + 0.95) / 4) * 100) && a.body.engagement.completionRate === 50, 'avg view-through and completion rate are per-viewer-accurate (2 of 4 completed)');
    ok(a.body.viewers.length === 4 && a.body.viewers[0].name === 'Anon2' === false && a.body.viewers.some((v) => v.name === 'Bob Viewer' && v.verified && v.maxProgress === 1 && v.completed) && a.body.viewers.filter((v) => !v.verified).every((v) => /^Anonymous/.test(v.name)), 'viewers: signed-in ones named from the account (verified), anonymous ones labelled Anonymous, newest first');
    ok(Array.isArray(a.body.retention) && a.body.retention.length === 10 && a.body.retention[0].viewers === 4 && a.body.retention[2].viewers === 4 && a.body.retention[3].viewers === 3 && a.body.retention[5].viewers === 3 && a.body.retention[6].viewers === 2 && a.body.retention[9].viewers === 2, `the retention curve counts viewers reaching each decile: ${JSON.stringify(a.body.retention.map((d) => d.viewers))}`);
    ok(a.body.comments.length === 1 && a.body.reactions.length === 1 && a.body.leads.length === 1 && a.body.leads[0].email === `lead-${RUN}@x.co`, 'reactions / comments / leads lists');
    ok(!JSON.stringify(a.body).includes('ip_hash') && !JSON.stringify(a.body).includes('viewer_key'), 'no viewer keys or IP hashes leave the API');

    console.log('\nC. Overview: rollup + daily trend');
    const B = await mkRec('b', 'alice', 3);
    await view(B, { key: 'v:x', progress: 0.5, at: t(60 * 24 * 2) });
    await event(A, 'view', t(60 * 24 * 1)); await event(A, 'view', t(60 * 24 * 1)); await event(B, 'comment', t(60 * 24 * 2)); await event(A, 'paywall_hit', t(30));
    const ov = await api('GET', '/analytics/overview?days=7', { as: legacy.alice });
    ok(ov.status === 200 && ov.body.days === 7 && ov.body.totals.recordings === 2 && ov.body.totals.views === 5 && ov.body.totals.comments === 1 && ov.body.totals.reactions === 1, 'totals across the owner\'s recordings');
    const rowA = ov.body.recordings.find((r) => r.id === A), rowB = ov.body.recordings.find((r) => r.id === B);
    ok(rowA && rowA.views === 4 && rowA.completionRate === 50 && rowB && rowB.views === 1 && rowB.avgViewThrough === 50, 'per-recording rollup rows');
    ok(Array.isArray(ov.body.trend) && ov.body.trend.length === 7 && ov.body.trend.reduce((s, d) => s + d.views, 0) === 2 && ov.body.trend.reduce((s, d) => s + d.comments, 0) === 1 && ov.body.trend.reduce((s, d) => s + d.paywallHits, 0) === 1 && ov.body.trend.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day)), 'a day-by-day trend from analytics_events with the requested window filled in');
    ok((await api('GET', '/analytics/overview', { as: legacy.bob })).body.totals.recordings === 0, 'another owner sees only their own');
    ok((await api('GET', '/analytics/overview?days=999', { as: legacy.alice })).body.days === 90, 'the window is capped at 90 days');

    console.log('\nD. The paywall records a canonical event (T-1003)');
    analytics = false;
    const locked = await api('GET', `/recordings/${A}/analytics`, { as: legacy.alice });
    ok(locked.status === 403 && code(locked) === 'feature_locked' && locked.body.error.upgradeRequired === true && locked.body.error.details.feature === 'analyticsEnabled', 'a locked account gets 403 feature_locked + upgradeRequired');
    const hits = (await db.execute(sql`select recording_id, user_id, props from analytics_events where event = 'paywall_hit' and user_id = ${pg('alice')} order by id desc`)).rows;
    ok(hits.length === 1 && hits[0].recording_id === A && hits[0].props.trigger === 'analytics_attempted' && hits[0].props.feature === 'analyticsEnabled', 'exactly one paywall_hit with the legacy trigger name analytics_attempted, attributed to the user and recording');
    ok((await api('GET', '/analytics/overview', { as: legacy.alice })).status === 403 && (await db.execute(sql`select count(*)::int as n from analytics_events where event = 'paywall_hit' and user_id = ${pg('alice')}`)).rows[0].n === 2, 'the overview paywall records one too');
    analytics = true;
    ok((await api('GET', `/recordings/${A}/analytics`, { as: legacy.alice })).status === 200, 'unlocked again → 200');
  } finally {
    server.close();
    await db.execute(sql`delete from users where id in (${pg('alice')}, ${pg('bob')})`).catch(() => {});
    await pool.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
