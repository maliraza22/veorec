// maybe_mark_ready (docs/09 §1, docs/10 §3/§6): the ONLY place
// recordings.status becomes 'ready'. Runs inside the caller's transaction with
// the recording row locked, so whichever of transcode/thumbnail finishes
// second promotes and two concurrent finishes cannot both skip.
//
//   ready ⇔ a ready MP4 asset AND (a ready poster asset OR the thumbnail job
//   failed terminally — docs/09 §4: a placeholder poster never blocks
//   availability; logged loudly).
'use strict';

const REASON = 'T-702 maybe_mark_ready: promote a processed recording';
const PROMOTABLE = new Set(['processing', 'uploaded']);

/**
 * @param {object} o
 * @param {object} o.tx           transaction repositories (withTransaction)
 * @param {string} o.recordingId
 * @param {object} [o.logger]
 * @returns {Promise<{promoted:boolean, reason:string|null, posterPlaceholder:boolean, status:string|null}>}
 */
async function maybeMarkReady({ tx, recordingId, logger = null }) {
  const recording = await tx.recordings.getForUpdateSystem(recordingId, REASON);
  if (!recording || recording.deletedAt) return { promoted: false, reason: 'recording_gone', posterPlaceholder: false, status: recording ? recording.status : null };
  if (recording.status === 'ready') return { promoted: false, reason: 'already_ready', posterPlaceholder: false, status: 'ready' };
  if (!PROMOTABLE.has(recording.status)) return { promoted: false, reason: `status_${recording.status}`, posterPlaceholder: false, status: recording.status };
  const assets = await tx.assets.listByRecordingSystem(recordingId, REASON);
  const mp4 = assets.find((a) => a.kind === 'mp4' && a.status === 'ready');
  if (!mp4) return { promoted: false, reason: 'mp4_not_ready', posterPlaceholder: false, status: recording.status };
  const poster = assets.find((a) => a.kind === 'poster' && a.status === 'ready');
  let posterPlaceholder = false;
  if (!poster) {
    const thumbJob = await tx.jobs.findByDedupeKey(`thumb:${recordingId}`);
    if (!(thumbJob && thumbJob.status === 'failed')) return { promoted: false, reason: 'poster_not_ready', posterPlaceholder: false, status: recording.status };
    posterPlaceholder = true;
  }
  await tx.recordings.updateSystem(recordingId, { status: 'ready', failureCode: null }, REASON);
  if (logger) {
    if (posterPlaceholder) logger.error({ recording_id: recordingId }, 'maybe_mark_ready: promoted WITHOUT a poster (thumbnail job failed terminally) — placeholder poster served, triage the thumbnail job');
    else logger.info({ recording_id: recordingId, mp4_asset_id: mp4.id, poster_asset_id: poster.id }, 'maybe_mark_ready: recording is ready');
  }
  return { promoted: true, reason: null, posterPlaceholder, status: 'ready' };
}

module.exports = { maybeMarkReady, PROMOTABLE, REASON };
