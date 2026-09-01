// Subscription store — mirrors the spec's Subscription model, keyed by userId
// (one active subscription per user in this product). Backed by subscriptions.json
// on the persistent volume.
//
// Record shape:
// {
//   id, userId,
//   paddleCustomerId, paddleSubscriptionId, paddleProductId, paddlePriceId,
//   planSlug,                                   // which plan it grants
//   status: 'active'|'trialing'|'past_due'|'paused'|'canceled',
//   billingCycle: 'monthly'|'yearly',
//   currentPeriodStart, currentPeriodEnd,       // epoch ms
//   cancelAtPeriodEnd,                          // boolean
//   createdAt, updatedAt
// }
const { createKeyedStore } = require('./store');
const dualwrite = require('./dualwrite');   // T-105 PostgreSQL mirror (flag-gated)

const store = createKeyedStore('subscriptions.json');

const VALID_STATUSES = ['active', 'trialing', 'past_due', 'paused', 'canceled'];
// Statuses that should grant paid entitlements.
const ENTITLED_STATUSES = ['active', 'trialing', 'past_due']; // grace on past_due

module.exports = {
  VALID_STATUSES,
  ENTITLED_STATUSES,

  getByUser(userId) {
    return store.get(userId);
  },

  getByPaddleSubscriptionId(subId) {
    return store.find((s) => s.paddleSubscriptionId === subId);
  },

  getByPaddleCustomerId(customerId) {
    return store.find((s) => s.paddleCustomerId === customerId);
  },

  upsert(userId, fields) {
    const now = Date.now();
    const saved = store.update(userId, (existing) => ({
      id: existing?.id || `sub_${userId}`,
      userId,
      createdAt: existing?.createdAt || now,
      ...existing,
      ...fields,
      updatedAt: now,
    }));
    dualwrite.subscription(userId, saved);
    return saved;
  },

  /** True if this subscription currently grants paid access. */
  isEntitled(sub) {
    if (!sub) return false;
    if (!ENTITLED_STATUSES.includes(sub.status)) return false;
    // If canceled-at-period-end, keep access until the period actually ends.
    if (sub.status === 'canceled') return false;
    return true;
  },

  all() { return store.all(); },
  remove(userId) { store.remove(userId); },
};
