// Contact form submissions store (contacts.json on the persistent volume).
// Public POST /api/contact appends here; admin reads them in the panel.
const { createKeyedStore } = require('./store');
const { v4: uuidv4 } = require('uuid');
const dualwrite = require('./dualwrite');   // T-105 PostgreSQL mirror (flag-gated)

const store = createKeyedStore('contacts.json');

module.exports = {
  create({ name, email, subject, message, userId }) {
    const id = uuidv4();
    const saved = store.set(id, {
      id, name, email, subject: subject || '', message,
      userId: userId || null, status: 'new', createdAt: Date.now(),
    });
    dualwrite.contact(saved);
    return saved;
  },
  all() {
    return store.all().sort((a, b) => b.createdAt - a.createdAt);
  },
  setStatus(id, status) {
    return store.update(id, (c) => (c ? { ...c, status } : null));
  },
  remove(id) { store.remove(id); },
  countNew() { return store.all().filter((c) => c.status === 'new').length; },
};
