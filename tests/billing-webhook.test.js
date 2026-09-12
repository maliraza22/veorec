// T-1301 Paddle webhook ledger + T-1303 entitlement reads (run: cd api && npm run test:billing)
//
// Real PostgreSQL. A. pure: signature parsing/verification (timing-safe, the
// exact `ts:rawBody` scheme), plan resolution from an event, the subscription
// patch each event implies. B. the mounted webhook: bad/missing signature →
// 401 (nothing recorded); a first event → 200 + ledger row `processed` +
// subscription row + users.paddle_customer_id; the SAME event id again → 200
// duplicate (applied once); an OLDER event after a newer one → `skipped`
// (out_of_order — the late-updated-after-canceled resurrection cannot happen);
// paused / canceled / payment_failed / transaction.completed safety net /
// customer.updated by email; an unresolvable user → `skipped`; a processing
// failure → ledger `failed` + HTTP 500 (Paddle retries); billing never touches
// recordings. C. GET /me/entitlements and /me/subscription on PostgreSQL:
// free → subscription → canceled with period-end grace → expired → admin comp
// (with expiry) → the legacy summary shape.
//
// SKIPS LOUDLY without PostgreSQL; BILLING_TESTS_REQUIRED=1 makes that a failure.
'use strict';

const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const API_DIR = path.join(ROOT, 'api');
const express = require(path.join(API_DIR, 'node_modules', 'express'));
const { loadEnv, createPool, createClient, createRepositories, withTransaction: rawTx } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));
const { createBillingWebhookRouter, createMeRouter, createQuota, verifyPaddleSignature, parsePaddleSignature, signPaddleBody, resolvePlanFromEvent, subscriptionPatchFor, resolveEntitlement, isEntitled } = require(path.join(API_DIR, 'src', 'index.js'));
const plans = require(path.join(ROOT, 'server', 'plans.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.BILLING_TESTS_REQUIRED === '1';
const RUN = crypto.randomBytes(3).toString('hex');
const REASON = 'T-1301 billing test';
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const SECRET = 'pdl_ntfset_test_secret_' + RUN;

(async () => {
  console.log('T-1301/T-1303 billing tests');

  console.log('\nA. Pure');
  const body = JSON.stringify({ event_id: 'evt_x', data: { a: 1 } });
  const header = signPaddleBody({ rawBody: body, secret: SECRET, ts: 1700000000 });
  ok(/^ts=1700000000;h1=[0-9a-f]{64}$/.test(header) && parsePaddleSignature(header).ts === '1700000000', 'the header is ts=…;h1=<hmac-sha256 hex>');
  ok(verifyPaddleSignature({ header, rawBody: Buffer.from(body), secret: SECRET }) && verifyPaddleSignature({ header, rawBody: body, secret: SECRET }), 'a valid signature verifies (Buffer or string body)');
  ok(!verifyPaddleSignature({ header, rawBody: body + ' ', secret: SECRET }) && !verifyPaddleSignature({ header, rawBody: body, secret: 'other' }) && !verifyPaddleSignature({ header: 'ts=1;h1=zz', rawBody: body, secret: SECRET }) && !verifyPaddleSignature({ header: null, rawBody: body, secret: SECRET }) && !verifyPaddleSignature({ header, rawBody: body, secret: null }), 'a changed body, another secret, a malformed header, no header or no secret all fail');
  const created = { id: 'sub_p1', customer_id: 'ctm_1', status: 'active', items: [{ price: { id: 'pri_unknown' } }], custom_data: { userId: 'legacy-1', planSlug: 'pro', billingCycle: 'yearly' }, current_billing_period: { starts_at: '2026-09-01T00:00:00Z', ends_at: '2027-09-01T00:00:00Z' }, scheduled_change: { action: 'cancel' } };
  ok(resolvePlanFromEvent(created, plans).planSlug === 'pro' && resolvePlanFromEvent(created, plans).billingCycle === 'yearly' && resolvePlanFromEvent({ items: [] }, plans).planSlug === 'pro' && resolvePlanFromEvent({ items: [] }, plans).billingCycle === 'monthly', 'custom_data wins; unknown prices default to pro/monthly');
  const p1 = subscriptionPatchFor('subscription.created', created, null, plans).patch;
  ok(p1.paddleSubscriptionId === 'sub_p1' && p1.paddleCustomerId === 'ctm_1' && p1.status === 'active' && p1.planSlug === 'pro' && p1.billingCycle === 'yearly' && p1.cancelAtPeriodEnd === true && p1.currentPeriodEnd.toISOString() === '2027-09-01T00:00:00.000Z', 'created → the full subscription state (scheduled cancel → cancelAtPeriodEnd)');
  const p2 = subscriptionPatchFor('subscription.canceled', { current_billing_period: { ends_at: '2026-10-01T00:00:00Z' } }, p1, plans).patch;
  ok(p2.status === 'canceled' && p2.cancelAtPeriodEnd === false && p2.paddleSubscriptionId === 'sub_p1' && p2.currentPeriodEnd.toISOString() === '2026-10-01T00:00:00.000Z', 'canceled keeps the ids and records the period end');
  ok(subscriptionPatchFor('subscription.paused', {}, p1, plans).patch.status === 'paused' && subscriptionPatchFor('transaction.payment_failed', {}, p1, plans).patch.status === 'past_due', 'paused / payment_failed');
  ok(subscriptionPatchFor('transaction.completed', {}, p1, plans).patch === null && subscriptionPatchFor('transaction.completed', { customer_id: 'ctm_2', subscription_id: 'sub_2' }, { ...p1, status: 'paused' }, plans).patch.status === 'active', 'transaction.completed is a safety net only when the user is not already entitled');
  ok(subscriptionPatchFor('address.created', {}, null, plans).patch === null, 'an unrelated event changes nothing');
  const now = Date.parse('2026-09-12T00:00:00Z');
  ok(isEntitled({ status: 'active' }, now) && isEntitled({ status: 'past_due' }, now) && !isEntitled({ status: 'paused' }, now) && isEntitled({ status: 'canceled', currentPeriodEnd: '2026-10-01T00:00:00Z' }, now) && !isEntitled({ status: 'canceled', currentPeriodEnd: '2026-09-01T00:00:00Z' }, now) && !isEntitled(null, now), 'entitled statuses; a canceled subscription keeps access until its period end (the docs/16 §2 fix)');
  const free = resolveEntitlement({ user: { id: 'u' }, subscription: null, plans, now });
  const paid = resolveEntitlement({ user: { id: 'u' }, subscription: { status: 'active', planSlug: 'pro', billingCycle: 'monthly', currentPeriodEnd: '2026-10-01T00:00:00Z' }, plans, now });
  const comped = resolveEntitlement({ user: { id: 'u', manualPlan: 'pro', manualPlanExpires: '2026-12-01T00:00:00Z' }, subscription: null, plans, now });
  const expiredComp = resolveEntitlement({ user: { id: 'u', manualPlan: 'pro', manualPlanExpires: '2026-01-01T00:00:00Z' }, subscription: null, plans, now });
  const bogusComp = resolveEntitlement({ user: { id: 'u', manualPlan: 'platinum' }, subscription: null, plans, now });
  ok(free.planSlug === plans.DEFAULT_PLAN_SLUG && free.source === 'free' && !free.isPaid && free.subscription === null, 'no rows → free');
  ok(paid.planSlug === 'pro' && paid.source === 'subscription' && paid.isPaid && paid.subscription.entitled === true && paid.subscription.currentPeriodEnd === Date.parse('2026-10-01T00:00:00Z'), 'an entitled subscription → its plan');
  ok(comped.planSlug === 'pro' && comped.source === 'comped' && comped.comped === true && expiredComp.source === 'free' && bogusComp.source === 'free', 'admin comp wins while valid; expired or unknown comps do not');

  let env = null, pgUp = false, pool = null;
  try { env = loadEnv({ appEnv: 'test' }); } catch (e) { console.log('  env:', e.message); }
  if (env) { pool = createPool({ env, max: 6 }); try { await pool.query('select 1'); pgUp = true; } catch {} }
  if (!pgUp) {
    console.log('\n  SKIPPED B–C — PostgreSQL unreachable');
    if (REQUIRED) { fail += 1; console.log('  FAIL: BILLING_TESTS_REQUIRED=1 but PostgreSQL is unavailable'); }
    if (pool) await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; return;
  }
  const db = createClient(pool);
  const repositories = () => createRepositories(db);
  const repos = repositories();
  const withTransaction = (fn) => rawTx(fn, db);
  const legacy = { alice: `a${RUN}`, bob: `b${RUN}` };
  const pg = (u) => `usr_${legacy[u]}`;
  for (const u of ['alice', 'bob']) await db.execute(sql`INSERT INTO users (id,email,name,password_hash) VALUES (${pg(u)}, ${`${u}-t1301-${RUN}@example.com`}, ${u}, 'x')`);

  let currentUser = null;
  const requireAuth = (req, res, next) => { if (!currentUser) return res.status(401).json({ error: { code: 'unauthorized', message: 'no' } }); req.userId = currentUser; req.id = 'req_test'; next(); };
  const app = express();
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use('/api/v1', createBillingWebhookRouter({ repositories, withTransaction, secret: SECRET, plans, userIdFor: (id) => `usr_${id}`, logger: silent }));
  app.use('/api/v1', createMeRouter({ repositories, requireAuth, quota: createQuota({ resolveLimits: async () => ({}), logger: silent }), plans, logger: silent }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const post = async (event, { secret = SECRET, header } = {}) => {
    const raw = JSON.stringify(event);
    const res = await fetch(`${base}/webhooks/paddle`, { method: 'POST', headers: { 'content-type': 'application/json', ...(header === null ? {} : { 'paddle-signature': header || signPaddleBody({ rawBody: raw, secret }) }) }, body: raw });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const me = async (p, as) => { currentUser = as; const r = await fetch(`${base}${p}`); return { status: r.status, body: await r.json().catch(() => null) }; };
  const evt = (id, type, data, occurred) => ({ event_id: id, event_type: type, occurred_at: occurred, data });
  const ledger = async (id) => (await db.execute(sql`select status, error, user_id from billing_events where paddle_event_id = ${id}`)).rows[0] || null;
  const subOf = (u) => repos.subscriptions.getForUser({ userId: pg(u) });

  try {
    console.log('\nB. The webhook on PostgreSQL');
    const c1 = { id: `sub_${RUN}`, customer_id: `ctm_${RUN}`, status: 'active', items: [{ price: { id: 'pri_x' } }], custom_data: { userId: legacy.alice, planSlug: 'pro', billingCycle: 'monthly' }, current_billing_period: { starts_at: '2026-09-01T00:00:00Z', ends_at: '2026-10-01T00:00:00Z' } };
    const bad = await post(evt(`evt_${RUN}_bad`, 'subscription.created', c1, '2026-09-01T00:00:01Z'), { secret: 'wrong' });
    ok(bad.status === 401 && bad.body.error.code === 'bad_signature' && (await ledger(`evt_${RUN}_bad`)) === null, 'a bad signature is 401 and nothing is recorded');
    ok((await post(evt(`evt_${RUN}_nohdr`, 'subscription.created', c1, '2026-09-01T00:00:01Z'), { header: null })).status === 401, 'a missing signature header is 401');
    const r1 = await post(evt(`evt_${RUN}_1`, 'subscription.created', c1, '2026-09-01T00:00:01Z'));
    const s1 = await subOf('alice');
    ok(r1.status === 200 && r1.body.ok === true && r1.body.duplicate === false && r1.body.status === 'processed' && (await ledger(`evt_${RUN}_1`)).status === 'processed', 'subscription.created → 200, ledger row processed');
    ok(s1 && s1.status === 'active' && s1.planSlug === 'pro' && s1.billingCycle === 'monthly' && s1.paddleSubscriptionId === `sub_${RUN}` && s1.paddleCustomerId === `ctm_${RUN}` && new Date(s1.currentPeriodEnd).toISOString() === '2026-10-01T00:00:00.000Z' && new Date(s1.lastEventAt).toISOString() === '2026-09-01T00:00:01.000Z', 'the subscription row carries the full state and the event time');
    ok((await repos.users.findById(pg('alice'))).paddleCustomerId === `ctm_${RUN}`, 'users.paddle_customer_id is attached');
    const r1b = await post(evt(`evt_${RUN}_1`, 'subscription.created', { ...c1, status: 'paused' }, '2026-09-05T00:00:00Z'));
    ok(r1b.status === 200 && r1b.body.duplicate === true && (await subOf('alice')).status === 'active', 'the same event id again is acknowledged as a duplicate and NOT re-applied (replay-proof)');
    const r2 = await post(evt(`evt_${RUN}_2`, 'subscription.canceled', { id: `sub_${RUN}`, customer_id: `ctm_${RUN}`, current_billing_period: { ends_at: '2026-10-01T00:00:00Z' } }, '2026-09-10T00:00:00Z'));
    const s2 = await subOf('alice');
    ok(r2.status === 200 && s2.status === 'canceled' && s2.cancelAtPeriodEnd === false && s2.paddleSubscriptionId === `sub_${RUN}` && new Date(s2.lastEventAt).toISOString() === '2026-09-10T00:00:00.000Z', 'canceled (resolved by the Paddle subscription id, no custom_data) → status canceled, ids kept');
    const late = await post(evt(`evt_${RUN}_3`, 'subscription.updated', { ...c1, status: 'active' }, '2026-09-08T00:00:00Z'));
    ok(late.status === 200 && late.body.status === 'skipped' && late.body.reason === 'out_of_order' && (await ledger(`evt_${RUN}_3`)).error === 'out_of_order' && (await subOf('alice')).status === 'canceled', 'an OLDER updated arriving after canceled is skipped — no resurrection');
    const r4 = await post(evt(`evt_${RUN}_4`, 'subscription.resumed', { ...c1, status: 'active' }, '2026-09-11T00:00:00Z'));
    ok(r4.status === 200 && (await subOf('alice')).status === 'active', 'a NEWER resumed applies');
    await post(evt(`evt_${RUN}_5`, 'subscription.paused', { id: `sub_${RUN}` }, '2026-09-11T01:00:00Z'));
    ok((await subOf('alice')).status === 'paused', 'paused');
    await post(evt(`evt_${RUN}_6`, 'transaction.payment_failed', { subscription_id: `sub_${RUN}`, customer_id: `ctm_${RUN}` }, '2026-09-11T02:00:00Z'));
    ok((await subOf('alice')).status === 'past_due', 'payment_failed → past_due (grace via entitled statuses)');
    await post(evt(`evt_${RUN}_7`, 'subscription.canceled', { id: `sub_${RUN}`, current_billing_period: { ends_at: '2026-09-01T00:00:00Z' } }, '2026-09-11T03:00:00Z'));
    const tc = await post(evt(`evt_${RUN}_8`, 'transaction.completed', { customer_id: `ctm_${RUN}`, subscription_id: `sub_${RUN}`, items: [{ price: { id: 'pri_x' } }], custom_data: { userId: legacy.alice, planSlug: 'pro' } }, '2026-09-11T04:00:00Z'));
    ok(tc.status === 200 && tc.body.status === 'processed' && (await subOf('alice')).status === 'active', 'transaction.completed after an expired cancellation re-activates (the ordering safety net)');
    const tc2 = await post(evt(`evt_${RUN}_9`, 'transaction.completed', { customer_id: `ctm_${RUN}`, custom_data: { userId: legacy.alice } }, '2026-09-11T05:00:00Z'));
    ok(tc2.body.status === 'processed' && tc2.body.reason === 'already_entitled', 'a completed transaction for an entitled user changes nothing');
    const cu = await post(evt(`evt_${RUN}_10`, 'customer.updated', { id: `ctm_bob_${RUN}`, email: `BOB-t1301-${RUN}@example.com` }, '2026-09-11T06:00:00Z'));
    ok(cu.status === 200 && (await repos.users.findById(pg('bob'))).paddleCustomerId === `ctm_bob_${RUN}`, 'customer.updated attaches the Paddle customer to the user by (case-insensitive) email');
    const un = await post(evt(`evt_${RUN}_11`, 'subscription.created', { id: 'sub_nobody', customer_id: 'ctm_nobody', custom_data: { userId: 'nobody' } }, '2026-09-11T07:00:00Z'));
    ok(un.status === 200 && un.body.status === 'skipped' && un.body.reason === 'user_unresolved' && (await ledger(`evt_${RUN}_11`)).error === 'user_unresolved', 'an event no user matches is recorded as skipped (200, no retry storm)');
    const unk = await post(evt(`evt_${RUN}_12`, 'address.created', { customer_id: `ctm_${RUN}` }, '2026-09-11T08:00:00Z'));
    ok(unk.status === 200 && unk.body.status === 'skipped' && (await ledger(`evt_${RUN}_12`)).error === 'unhandled_event_type', 'an unhandled event type is acknowledged and recorded as skipped');
    const boom = await post(evt(`evt_${RUN}_13`, 'subscription.updated', { ...c1, status: 'not-a-status' }, '2026-09-12T00:00:00Z'));
    const l13 = await ledger(`evt_${RUN}_13`);
    ok(boom.status === 500 && boom.body.error.code === 'webhook_processing_failed' && l13.status === 'failed' && /constraint|status/.test(l13.error || ''), `a processing failure marks the event failed and answers 500 (Paddle retries) — never a blind 200 [${boom.status} ${JSON.stringify(boom.body).slice(0, 200)} ledger=${JSON.stringify(l13)}]`);
    ok((await subOf('alice')).status === 'active', 'the failed event changed nothing (transaction rolled back)');
    ok((await post(evt(null, 'subscription.updated', c1, '2026-09-12T00:00:00Z'))).status === 400, 'an event without an id is 400');
    const failed = await repos.billingEvents.listFailedSystem({ limit: 10 }, REASON);
    ok(failed.some((f) => f.paddleEventId === `evt_${RUN}_13`), 'failed events are listable for the operator (docs/16 §8 alert)');
    ok((await db.execute(sql`select count(*)::int n from recordings where user_id = ${pg('alice')}`)).rows[0].n === 0, 'billing never touches recordings (invariant #15)');

    console.log('\nC. GET /me/entitlements + /me/subscription (T-1303)');
    const eb = await me('/me/entitlements', legacy.bob);
    ok(eb.status === 200 && eb.body.planSlug === plans.DEFAULT_PLAN_SLUG && eb.body.isPaid === false && eb.body.source === 'free' && eb.body.subscription === null && eb.body.plan && eb.body.plan.features && typeof eb.body.plan.features.analyticsEnabled === 'boolean', 'no subscription → the free plan in the legacy summary shape (public plan with features)');
    const ea = await me('/me/entitlements', legacy.alice);
    ok(ea.status === 200 && ea.body.planSlug === 'pro' && ea.body.isPaid === true && ea.body.source === 'subscription' && ea.body.subscription.status === 'active' && ea.body.comped === false, 'an active subscription → pro from PostgreSQL');
    const sa = await me('/me/subscription', legacy.alice);
    ok(sa.status === 200 && sa.body.subscription.status === 'active' && sa.body.subscription.entitled === true && sa.body.subscription.planSlug === 'pro' && sa.body.planSlug === 'pro' && !('paddleCustomerId' in sa.body.subscription), 'the subscription view carries no Paddle identifiers');
    await repos.subscriptions.upsertForUserSystem(pg('alice'), { ...(await subOf('alice')), status: 'canceled', currentPeriodEnd: new Date(Date.now() + 86400e3) }, REASON);
    ok((await me('/me/entitlements', legacy.alice)).body.planSlug === 'pro', 'canceled with the period end ahead → still pro (grace)');
    await repos.subscriptions.upsertForUserSystem(pg('alice'), { ...(await subOf('alice')), status: 'canceled', currentPeriodEnd: new Date(Date.now() - 86400e3) }, REASON);
    ok((await me('/me/entitlements', legacy.alice)).body.planSlug === plans.DEFAULT_PLAN_SLUG && (await me('/me/entitlements', legacy.alice)).body.source === 'free', 'canceled with the period end behind → free');
    await repos.users.updateAsAdmin(pg('bob'), { manualPlan: 'pro', manualPlanExpires: new Date(Date.now() + 86400e3) }, REASON);
    const cb = await me('/me/entitlements', legacy.bob);
    ok(cb.body.planSlug === 'pro' && cb.body.source === 'comped' && cb.body.comped === true, 'an admin comp → pro (source comped)');
    await repos.users.updateAsAdmin(pg('bob'), { manualPlanExpires: new Date(Date.now() - 1000) }, REASON);
    ok((await me('/me/entitlements', legacy.bob)).body.source === 'free', 'an expired comp → free');
    ok((await me('/me/entitlements', null)).status === 401, 'unauthenticated → 401');
  } finally {
    server.close();
    await db.execute(sql`delete from billing_events where paddle_event_id like ${`evt_${RUN}_%`}`);
    await db.execute(sql`delete from users where id in (${pg('alice')}, ${pg('bob')})`);
    await pool.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
