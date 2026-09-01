const fs = require('fs');
const path = require('path');
// T-105: mirror successful user writes into PostgreSQL. Legacy stays
// authoritative; the mirror is a no-op unless PG_DUAL_WRITE=true.
const dualwrite = require('./dualwrite');

// DATA_DIR points to a persistent volume in production (Railway volume mounted
// at /data). Falls back to the app directory for local dev. This is critical:
// Railway's container filesystem is ephemeral and wiped on every redeploy, so
// user accounts MUST live on a mounted volume to survive deploys.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, 'users.json');

function load() {
  if (!fs.existsSync(FILE)) return [];
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}

function save(rows) {
  fs.writeFileSync(FILE, JSON.stringify(rows, null, 2));
}

module.exports = {
  findByEmail(email) {
    return load().find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
  },
  findById(id) {
    return load().find(u => u.id === id) || null;
  },
  create(user) {
    const rows = load();
    rows.push(user);
    save(rows);
    dualwrite.user(user);
    return user;
  },
  update(id, fields) {
    const rows = load();
    const i = rows.findIndex(u => u.id === id);
    if (i === -1) return null;
    rows[i] = { ...rows[i], ...fields };
    save(rows);
    dualwrite.user(rows[i]);
    return rows[i];
  },
  remove(id) {
    const rows = load();
    const next = rows.filter(u => u.id !== id);
    if (next.length === rows.length) return false;
    save(next);
    return true;
  },
  all() { return load(); },
};
