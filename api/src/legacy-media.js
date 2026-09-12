// LEGACY READ FALLBACK (T-803, docs/23 Phase 7).
//
// The ONE place the v1 API knows anything about the legacy media host. While
// the backfill runs, a recording mirrored from the legacy store has a stored
// URL in `legacy.media_map` and no v1 assets yet; the list and the watch page
// fall back to that stored URL — a READ of a string the migration recorded,
// never a call to the legacy provider's API and never a write. Once a v1 asset
// lands for a recording, nothing here is consulted for it again.
'use strict';

const LEGACY_VIDEO_EXT = /\.(webm|mp4|mov|mkv)(\?.*)?$/i;

/**
 * The legacy host's poster-frame rule for a stored video URL (first frame as
 * JPEG) — exactly what the legacy library list rendered. Returns null for
 * anything that is not an absolute upload URL on the legacy host.
 */
function legacyPosterUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url) || !url.includes('/upload/')) return null;
  return url.replace(LEGACY_VIDEO_EXT, '.jpg').replace('/upload/', '/upload/so_0/');
}

module.exports = { legacyPosterUrl };
