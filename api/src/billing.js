// PADDLE WEBHOOK on PostgreSQL — the idempotent event ledger (T-1301, docs/16 §6, docs/08 §13).
//
//   POST /api/v1/webhooks/paddle
//     1. verify `paddle-signature` (HMAC-SHA256 over `ts:rawBody`, timing-safe) → else 401
//     2. INSERT billing_events ON CONFLICT (paddle_event_id) DO NOTHING
//        → duplicate ⇒ 200 {ok, duplicate:true}   (replay-proof)
//     3. process in ONE transaction: resolve the user, apply the event to
//        `subscriptions` (+ users.paddle_customer_id), mark the event processed
//     4. out-of-order guard: an event older than the subscription's
//        `last_event_at` is marked `skipped`, never applied
//     5. a processing exception marks the event `failed` and answers 500 so
//        Paddle retries — never a blind 200
//
// Event semantics are the legacy handler's (webhooks.paddle.js), ported:
// created/updated/activated/resumed upsert full state; paused → paused;
// canceled → canceled with the period end; transaction.completed is the
// ordering safety net; payment_failed → past_due; customer.* attaches the
// Paddle customer id by email. Billing never touches recording state.
'use strict';

const crypto = require('crypto');
const express = require('express');
const { errorHandler, ApiError } = require('./errors');

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const REASON = 'T-1301 paddle webhook: apply a verified billing event';
const SUBSCRIPTION_EVENTS = new Set(['subscription.created', 'subscription.updated', 'subscription.activated', 'subscription.resumed']);

/** `paddle-signature: ts=…;h1=…` → {ts, h1} or null. */
function parsePaddleSignature(header) {
  if (!header) return null;
  const parts = Object.fromEntries(String(header).split(';').map((kv) => { const i = kv.indexOf('='); return i < 0 ? [kv, ''] : [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]; }));
  if (!parts.ts || !parts.h1) return null;
  return { ts: parts.ts, h1: parts.h1 };
}

/** Timing-safe HMAC check over `ts:rawBody`. `rawBody` is a Buffer or string. */
function verifyPaddleSignature({ header, rawBody, secret }) {
  if (!secret || rawBody == null) return false;
  const sig = parsePaddleSignature(header);
  if (!sig) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = crypto.createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${sig.ts}:`), body])).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(sig.h1, 'utf8')); } catch { return false; }
}

/** Sign a body the way Paddle does (tests and local tooling). */
function signPaddleBody({ rawBody, secret, ts = Math.floor(Date.now() / 1000) }) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const h1 = crypto.createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${ts}:`), body])).digest('hex');
  return `ts=${ts};h1=${h1}`;
}

const periodAt = (d, key) => { const v = d && d.current_billing_period && d.current_billing_period[key]; const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? new Date(t) : null; };
const priceIdOf = (d) => (d && d.items && d.items[0] && ((d.items[0].price && d.items[0].price.id) || d.items[0].price_id)) || null;

/** The plan a subscription/transaction event grants: custom_data first, then the price catalog, then pro/monthly. */
function resolvePlanFromEvent(data, plans) {
  const priceId = priceIdOf(data);
  const resolved = priceId && typeof plans.resolvePlanByPriceId === 'function' ? plans.resolvePlanByPriceId(priceId) : null;
  const custom = (data && data.custom_data) || {};
  return {
    priceId,
    planSlug: custom.planSlug || (resolved && resolved.plan && resolved.plan.slug) || 'pro',
    billingCycle: custom.billingCycle || (resolved && resolved.billingCycle) || 'monthly',
  };
}

/**
 * The subscription patch an event implies (pure). `existing` is the current
 * row or null. Returns `{ patch }` or `{ patch: null, reason }` when the event
 * changes nothing on the subscription.
 */
function subscriptionPatchFor(type, data, existing, plans, { now = Date.now() } = {}) {
  const base = existing || {};
  if (SUBSCRIPTION_EVENTS.has(type)) {
    const { priceId, planSlug, billingCycle } = resolvePlanFromEvent(data, plans);
    return { patch: {
      ...base,
      paddleSubscriptionId: data.id || base.paddleSubscriptionId || null,
      paddleCustomerId: data.customer_id || base.paddleCustomerId || null,
      paddlePriceId: priceId || base.paddlePriceId || null,
      planSlug, billingCycle,
      status: data.status || 'active',
      currentPeriodStart: periodAt(data, 'starts_at') || base.currentPeriodStart || null,
      currentPeriodEnd: periodAt(data, 'ends_at') || base.currentPeriodEnd || null,
      cancelAtPeriodEnd: !!(data.scheduled_change && data.scheduled_change.action === 'cancel'),
    } };
  }
  if (type === 'subscription.paused') return { patch: { planSlug: 'pro', ...base, status: 'paused' } };
  if (type === 'subscription.canceled') return { patch: { planSlug: 'pro', ...base, status: 'canceled', cancelAtPeriodEnd: false, currentPeriodEnd: periodAt(data, 'ends_at') || base.currentPeriodEnd || null } };
  if (type === 'transaction.payment_failed') return { patch: { planSlug: 'pro', ...base, status: 'past_due' } };
  if (type === 'transaction.completed') {
    const { isEntitled } = require('./entitlements');
    if (existing && isEntitled(existing, now)) return { patch: null, reason: 'already_entitled' };
    const { priceId, planSlug, billingCycle } = resolvePlanFromEvent(data, plans);
    return { patch: {
      ...base,
      paddleCustomerId: data.customer_id || base.paddleCustomerId || null,
      paddleSubscriptionId: data.subscription_id || base.paddleSubscriptionId || null,
      paddlePriceId: priceId || base.paddlePriceId || null,
      planSlug, billingCycle, status: 'active',
    } };
  }
  return { patch: null, reason: 'no_subscription_change' };
}

const eventTime = (event) => { const t = event && event.occurred_at ? Date.parse(event.occurred_at) : NaN; return Number.isFinite(t) ? new Date(t) : null; };

/**
 * @param {object} deps
 * @param {() => object} deps.repositories
 * @param {Function} deps.withTransaction
 * @param {string|null} deps.secret               PADDLE webhook secret (401 for every request when unset)
 * @param {object} deps.plans                     the plan catalog (getPlan, resolvePlanByPriceId)
 * @param {(customUserId: string) => string} [deps.userIdFor]   custom_data.userId → PostgreSQL user id (the legacy bridge)
 * @param {object} [deps.logger]
 */
function createBillingWebhookRouter({ repositories, withTransaction, secret = null, plans, userIdFor = (id) => id, logger = console }) {
  if (!plans) throw new Error('createBillingWebhookRouter: plans catalog required');
  const router = express.Router();
  // Raw-body capture for standalone mounting; a no-op when the app already parsed JSON.
  router.use('/webhooks/paddle', express.json({ limit: '1mb', verify: (req, res, buf) => { if (!req.rawBody) req.rawBody = buf; } }));

  async function resolveUser(repos, type, data) {
    const custom = data && data.custom_data && data.custom_data.userId;
    if (custom) { const u = await repos.users.findById(userIdFor(String(custom))); if (u) return u.id; }
    const subId = data && (data.id && String(type).startsWith('subscription.') ? data.id : data.subscription_id);
    if (subId) { const s = await repos.subscriptions.findByPaddleSubscriptionIdSystem(subId, REASON); if (s) return s.userId; }
    if (data && data.customer_id) { const s = await repos.subscriptions.findByPaddleCustomerIdSystem(data.customer_id, REASON); if (s) return s.userId; }
    if (String(type).startsWith('customer.') && data && data.email) { const u = await repos.users.findByEmail(String(data.email).toLowerCase()); if (u) return u.id; }
    return null;
  }

  router.post('/webhooks/paddle', asyncRoute(async (req, res) => {
    if (!verifyPaddleSignature({ header: req.headers['paddle-signature'], rawBody: req.rawBody, secret })) {
      throw new ApiError(401, 'bad_signature', 'Webhook signature verification failed.');
    }
    const event = req.body || {};
    const type = String(event.event_type || '');
    const data = event.data || {};
    const eventId = event.event_id || event.notification_id || null;
    if (!eventId || !type) throw new ApiError(400, 'invalid_request', 'event_id and event_type are required.');
    const repos = repositories();
    const occurredAt = eventTime(event);
    const { event: row, created } = await repos.billingEvents.recordIfNew({ paddleEventId: String(eventId), eventType: type, payload: event, occurredAt });
    res.set('Cache-Control', 'no-store');
    if (!created) {
      logger.info({ paddle_event_id: eventId, event_type: type, status: row && row.status }, 'T-1301: duplicate Paddle event acknowledged');
      return res.json({ ok: true, duplicate: true, status: row ? row.status : 'received' });
    }
    let outcome;
    try {
      outcome = await withTransaction(async (tx) => {
        const userId = await resolveUser(tx, type, data);
        if (!userId) { await tx.billingEvents.markProcessed(row.id, 'skipped', { error: 'user_unresolved' }); return { status: 'skipped', reason: 'user_unresolved' }; }
        if (String(type).startsWith('customer.')) {
          if (data.id) await tx.users.updateAsAdmin(userId, { paddleCustomerId: data.id }, REASON);
          await tx.billingEvents.markProcessed(row.id, 'processed');
          return { status: 'processed', userId };
        }
        const existing = await tx.subscriptions.getForUser({ userId });
        // Out-of-order guard: never let an older event overwrite a newer state.
        if (existing && existing.lastEventAt && occurredAt && occurredAt.getTime() < new Date(existing.lastEventAt).getTime()) {
          await tx.billingEvents.markProcessed(row.id, 'skipped', { error: 'out_of_order' });
          return { status: 'skipped', reason: 'out_of_order', userId };
        }
        const { patch, reason } = subscriptionPatchFor(type, data, existing, plans);
        if (!patch) {
          const known = SUBSCRIPTION_EVENTS.has(type) || ['subscription.paused', 'subscription.canceled', 'transaction.completed', 'transaction.payment_failed'].includes(type);
          await tx.billingEvents.markProcessed(row.id, known ? 'processed' : 'skipped', { error: known ? null : 'unhandled_event_type' });
          return { status: known ? 'processed' : 'skipped', reason, userId };
        }
        const saved = await tx.subscriptions.upsertForUserSystem(userId, { ...patch, id: existing ? existing.id : undefined, lastEventAt: occurredAt || new Date() }, REASON);
        if (patch.paddleCustomerId) await tx.users.updateAsAdmin(userId, { paddleCustomerId: patch.paddleCustomerId }, REASON);
        await tx.billingEvents.markProcessed(row.id, 'processed');
        return { status: 'processed', userId, subscription: { status: saved.status, planSlug: saved.planSlug } };
      });
    } catch (e) {
      // Recorded, then 500: Paddle retries and the ledger shows the failure (docs/16 §8).
      await repos.billingEvents.markProcessed(row.id, 'failed', { error: String(e && e.message || e).slice(0, 1000) }).catch(() => {});
      logger.error({ paddle_event_id: eventId, event_type: type, err: e && e.message }, 'T-1301: billing event processing failed');
      throw new ApiError(500, 'webhook_processing_failed', 'The event was recorded but could not be applied; it will be retried.');
    }
    logger.info({ paddle_event_id: eventId, event_type: type, ...outcome }, 'T-1301: billing event handled');
    return res.json({ ok: true, duplicate: false, status: outcome.status, reason: outcome.reason || null });
  }));

  router.use(errorHandler(logger));
  return router;
}

module.exports = { createBillingWebhookRouter, verifyPaddleSignature, parsePaddleSignature, signPaddleBody, resolvePlanFromEvent, subscriptionPatchFor, SUBSCRIPTION_EVENTS };
