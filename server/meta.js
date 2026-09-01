const fs = require('fs');
const path = require('path');
const dualwrite = require('./dualwrite');   // T-105 PostgreSQL mirror (flag-gated)

// Stored on the persistent volume so engagement/sharing data survives redeploys.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const META_FILE = path.join(DATA_DIR, 'meta.json');
const FOLDER_FILE = path.join(DATA_DIR, 'folders.json');
const NOTIF_READ_FILE = path.join(DATA_DIR, 'notif-reads.json');

function loadJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// ── Per-recording metadata (engagement + sharing settings) ────────────────────
function defaults() {
  return {
    title: null,          // authoritative title (instant); Cloudinary context is a mirror
    views: 0,
    viewers: [],          // [{ name, at }]
    reactions: [],        // [{ emoji, t, at }]  — t = seconds into the video
    comments: [],         // [{ id, name, text, at, t }]
    cta: null,            // { label, url }
    description: '',
    privacy: 'public',    // 'public' | 'login' | 'password'
    passwordHash: null,
    folder: null,         // folderId
    trimStart: null,      // seconds — virtual trim (player only plays start..end)
    trimEnd: null,
    segments: null,       // [{start,end}] keep-ranges (virtual split); null = whole video
    transcript: null,     // { status, language, text, segments:[{start,end,text}], created_at }
    tags: [],             // owner-defined tags [string]
    // Audience controls (Loom-style) — what viewers are allowed to do.
    audience: {
      comments: true,     // viewers can comment
      reactions: true,    // viewers can react
      download: true,     // show the download option to viewers
      transcript: true,   // viewers can open the transcript
      requireEmail: false,// gate the video behind a viewer email (lead capture)
    },
    leads: [],            // captured viewer emails [{ email, name, at }]
    engagement: { sum: 0, n: 0, completed: 0 }, // view-through: avg = sum/n, completion = completed/n
    recommendedSpeed: null, // suggested playback speed (e.g. 1.5); null = normal
    animatedThumbnail: true, // show the animated preview thumbnail when shared
    archived: false,         // hidden from the main library (kept, not deleted)
  };
}

const meta = {
  get(id) {
    const all = loadJSON(META_FILE, {});
    return { ...defaults(), ...(all[id] || {}) };
  },
  set(id, fields) {
    const all = loadJSON(META_FILE, {});
    all[id] = { ...defaults(), ...(all[id] || {}), ...fields };
    saveJSON(META_FILE, all);
    return all[id];
  },
  // atomic-ish mutation helper
  update(id, fn) {
    const all = loadJSON(META_FILE, {});
    const cur = { ...defaults(), ...(all[id] || {}) };
    all[id] = fn(cur) || cur;
    saveJSON(META_FILE, all);
    return all[id];
  },
  remove(id) {
    const all = loadJSON(META_FILE, {});
    delete all[id];
    saveJSON(META_FILE, all);
  },
  // Raw map of every recording's stored fields (no defaults merge). Used to
  // build the per-user notifications feed without N file reads.
  all() {
    return loadJSON(META_FILE, {});
  },
};

// ── Notification read-state (per user) ────────────────────────────────────────
// Tracks the timestamp at which each user last opened their activity feed, so
// the bell can show an unread count. One tiny JSON file keyed by userId.
const notifReads = {
  get(userId) {
    const all = loadJSON(NOTIF_READ_FILE, {});
    return all[userId] || 0;
  },
  set(userId, at) {
    const all = loadJSON(NOTIF_READ_FILE, {});
    all[userId] = at;
    saveJSON(NOTIF_READ_FILE, all);
    dualwrite.notificationRead(userId, at);
    return at;
  },
};

// ── Folders (per user) ────────────────────────────────────────────────────────
const folders = {
  listByUser(userId) {
    return loadJSON(FOLDER_FILE, []).filter(f => f.userId === userId);
  },
  create(folder) {
    const all = loadJSON(FOLDER_FILE, []);
    all.push(folder);
    saveJSON(FOLDER_FILE, all);
    dualwrite.folder(folder);
    return folder;
  },
  get(id) {
    return loadJSON(FOLDER_FILE, []).find(f => f.id === id) || null;
  },
  update(id, userId, fields) {
    const all = loadJSON(FOLDER_FILE, []);
    const i = all.findIndex(f => f.id === id && f.userId === userId);
    if (i === -1) return null;
    all[i] = { ...all[i], ...fields };
    saveJSON(FOLDER_FILE, all);
    dualwrite.folder(all[i]);
    return all[i];
  },
  remove(id, userId) {
    let all = loadJSON(FOLDER_FILE, []);
    all = all.filter(f => !(f.id === id && f.userId === userId));
    saveJSON(FOLDER_FILE, all);
    dualwrite.folderDeleted(id, userId);
  },
};

module.exports = { meta, folders, notifReads };
