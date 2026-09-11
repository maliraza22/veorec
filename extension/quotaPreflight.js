// ─────────────────────────────────────────────────────────────────────────────
// Quota pre-flight — the recorder's check BEFORE Start is accepted (T-307,
// docs/03 §3.0, docs/16 §4.6). Pure: takes the /api/v1/me/usage body and the
// chosen quality, returns a decision. UX only — the authoritative gate is the
// server's atomic reservation at upload-session creation (T-306).
//
//   blocked   available storage < minStartBytes, or videos at the cap
//             → Start is replaced by the exact block message + Manage videos / Upgrade
//   warn      available < maxUploadBytes (a full-length maximum-quality take
//             may not fit — says how many minutes DO fit), or ≥ max−5 videos
//             → banner, recording allowed (the take is byte-capped anyway)
//   ok        proceed
//   unknown   no usage available (fetch failed) → proceed; the server enforces
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VeoRecQuotaPreflight = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MiB = 1024 * 1024;
  // docs/16 §1.1 derivation: video target + 128 kbps audio + ~2% container.
  const BYTES_PER_SEC = { high: Math.round((4_000_000 + 128_000) * 1.02 / 8), medium: Math.round((2_500_000 + 128_000) * 1.02 / 8), low: Math.round((1_000_000 + 128_000) * 1.02 / 8) };

  const MSG_STORAGE_LIMIT = "You've reached your 5 GB free storage limit. Delete a video or upgrade to continue recording.";
  const MSG_VIDEO_LIMIT = "You've reached your 50-video free limit. Delete a video or upgrade to continue recording.";
  const MSG_NEAR_LIMIT = "You're close to your free limit — this may be one of your last recordings. Free up space or upgrade.";

  /** Minutes of recording that fit in `bytes` at `quality`. */
  function minutesThatFit(bytes, quality) {
    const bps = BYTES_PER_SEC[quality] || BYTES_PER_SEC.medium;
    return Math.max(0, Math.floor(bytes / bps / 60));
  }

  /**
   * @param {object} p
   * @param {object|null} p.usage   GET /api/v1/me/usage body (docs/16 §4.5), or null
   * @param {string} [p.quality]    'high' | 'medium' | 'low'
   */
  function assess({ usage, quality = 'medium' } = {}) {
    if (!usage || !usage.storage || !usage.videos) return { state: 'unknown', reason: null, message: null, minutesThatFit: null };
    const used = Number(usage.storage.usedBytes) || 0;
    const limit = Number(usage.storage.limitBytes) || 0;
    const reserved = Number(usage.storage.reservedBytes) || 0;
    const available = Math.max(0, limit - used - reserved);
    const minStart = Number(usage.minStartBytes) || 64 * MiB;
    const maxUpload = Number(usage.maxUploadBytes) || 512 * MiB;
    const count = Number(usage.videos.count) || 0;
    const slots = Number(usage.videos.reserved) || 0;
    const max = usage.videos.max == null ? null : Number(usage.videos.max);
    const minutes = minutesThatFit(available, quality);

    if (limit > 0 && available < minStart) {
      return { state: 'blocked', reason: 'storage', message: MSG_STORAGE_LIMIT, minutesThatFit: minutes, available };
    }
    if (max != null && count + slots >= max) {
      return { state: 'blocked', reason: 'videos', message: MSG_VIDEO_LIMIT, minutesThatFit: minutes, available };
    }
    const storageNear = limit > 0 && available < maxUpload;
    const videosNear = max != null && count >= max - 5;
    if (storageNear || videosNear) {
      const detail = storageNear ? ` You have storage for about ${minutes} more minute${minutes === 1 ? '' : 's'} at this quality.` : '';
      return { state: 'warn', reason: storageNear ? 'storage' : 'videos', message: MSG_NEAR_LIMIT + detail, minutesThatFit: minutes, available };
    }
    return { state: 'ok', reason: null, message: null, minutesThatFit: minutes, available };
  }

  return { assess, minutesThatFit, BYTES_PER_SEC, MSG_STORAGE_LIMIT, MSG_VIDEO_LIMIT, MSG_NEAR_LIMIT };
}));
