// ─────────────────────────────────────────────────────────────────────────────
// Quota meters — the DUAL meters of docs/16 §4.5–§4.6 (T-307)
//
// Two separate meters — Storage and Videos — never one blended percentage,
// because either limit alone can block the next recording. The UI renders
// only what this module returns; the server decides everything (T-306).
//
// Source of truth, in order: the v1 `GET /api/v1/me/usage` body (the same
// live aggregates the quota guard evaluates) → the legacy `/api/me/usage`
// summary plus the plan → nothing (meters hidden). The shape is identical
// whichever source fed it, so no component branches on the source.
// ─────────────────────────────────────────────────────────────────────────────

// docs/16 §4.6 — exact copy.
export const MSG_STORAGE_LIMIT = "You've reached your 5 GB free storage limit. Delete a video or upgrade to continue recording.";
export const MSG_VIDEO_LIMIT = "You've reached your 50-video free limit. Delete a video or upgrade to continue recording.";
export const MSG_NEAR_LIMIT = "You're close to your free limit — this may be one of your last recordings. Free up space or upgrade.";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** "4.2 GB" / "5 GB" / "512 MB" — one decimal, trailing .0 dropped. */
export function fmtBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b >= GiB) {
    const g = Math.round((b / GiB) * 10) / 10;
    return `${Number.isInteger(g) ? g : g.toFixed(1)} GB`;
  }
  if (b >= MiB) return `${Math.round(b / MiB)} MB`;
  return `${Math.round(b / 1024)} KB`;
}

/** "4.2 GB / 5 GB" */
export const storageDisplay = (usedBytes, limitBytes) => `${fmtBytes(usedBytes)} / ${fmtBytes(limitBytes)}`;
/** "38 / 50", or "38" when the plan has no cap. */
export const videosDisplay = (count, max) => (max == null ? `${count}` : `${count} / ${max}`);

/**
 * Normalize either source into the dual-meter shape.
 * @param {object} p
 * @param {object|null} p.v1      body of GET /api/v1/me/usage (docs/16 §4.5)
 * @param {object|null} p.legacy  body of the legacy GET /api/me/usage
 * @param {object|null} p.plan    the entitlements plan (legacy fields)
 */
export function normalizeUsage({ v1 = null, legacy = null, plan = null } = {}) {
  if (v1 && v1.storage && v1.videos) {
    const usedBytes = Number(v1.storage.usedBytes) || 0;
    const limitBytes = Number(v1.storage.limitBytes) || 0;
    const count = Number(v1.videos.count) || 0;
    const max = v1.videos.max == null ? null : Number(v1.videos.max);
    return {
      source: 'v1',
      storage: { usedBytes, limitBytes, reservedBytes: Number(v1.storage.reservedBytes) || 0, display: storageDisplay(usedBytes, limitBytes) },
      videos: { count, max, reserved: Number(v1.videos.reserved) || 0, display: videosDisplay(count, max) },
      limits: {
        maxUploadBytes: Number(v1.maxUploadBytes) || null,
        minStartBytes: Number(v1.minStartBytes) || null,
        recordingLimitSeconds: Number(v1.recordingLimitSeconds) || null,
        model: v1.model || null,
      },
    };
  }
  if (legacy && (legacy.storageLimitBytes != null || legacy.storageUsedBytes != null)) {
    const usedBytes = Number(legacy.storageUsedBytes) || 0;
    const limitBytes = Number(legacy.storageLimitBytes) || (Number(legacy.storageLimitGB) || 0) * GiB;
    const count = Number(legacy.videoCount) || 0;
    const max = plan && plan.maxVideos != null ? Number(plan.maxVideos) : null;
    return {
      source: 'legacy',
      storage: { usedBytes, limitBytes, reservedBytes: 0, display: storageDisplay(usedBytes, limitBytes) },
      videos: { count, max, reserved: 0, display: videosDisplay(count, max) },
      limits: { maxUploadBytes: null, minStartBytes: null, recordingLimitSeconds: plan && plan.recordingLimitMinutes ? plan.recordingLimitMinutes * 60 : null, model: 'legacy' },
    };
  }
  return null;
}

/** Fill ratio for ONE meter (never combined across meters). */
export const meterRatio = (used, limit) => (limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0);

/**
 * docs/16 §4.6 / docs/03 §3.0 assessment for the dashboard hints.
 * blocked: available storage < minStartBytes, or videos at the cap.
 * nearLimit: available < maxUploadBytes (a full take may not fit), or ≥ max−5 videos.
 */
export function assessQuota(m) {
  if (!m) return { blocked: null, nearLimit: false, message: null };
  const available = Math.max(0, m.storage.limitBytes - m.storage.usedBytes - (m.storage.reservedBytes || 0));
  const minStart = m.limits.minStartBytes || 64 * MiB;
  const maxUpload = m.limits.maxUploadBytes || 512 * MiB;
  if (m.storage.limitBytes > 0 && available < minStart) return { blocked: 'storage', nearLimit: true, message: MSG_STORAGE_LIMIT };
  if (m.videos.max != null && m.videos.count + (m.videos.reserved || 0) >= m.videos.max) return { blocked: 'videos', nearLimit: true, message: MSG_VIDEO_LIMIT };
  const near = (m.storage.limitBytes > 0 && available < maxUpload) || (m.videos.max != null && m.videos.count >= m.videos.max - 5);
  return { blocked: null, nearLimit: near, message: near ? MSG_NEAR_LIMIT : null };
}
