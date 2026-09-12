// ─────────────────────────────────────────────────────────────────────────────
// OBJECT KEY STRATEGY + VALIDATION (T-201)
//
// The canonical layout is docs/02 §2.7. Keys are built HERE and nowhere else:
// callers pass identifiers, never path fragments. That is the whole point —
// a key is an opaque handle to higher layers (`video_assets.storage_key`),
// and the only code that knows its shape is this file.
//
// SECURITY MODEL — a storage key is a path into a bucket, so an attacker who
// influences one can read or overwrite another tenant's bytes:
//   • Identifiers are validated against a strict charset BEFORE interpolation.
//     There is no escaping step; anything outside the charset is rejected.
//   • Original client filenames are NEVER used as, or inside, a key. The
//     extension is chosen from a server-side allow-list.
//   • Every key is re-validated by the provider on the way out (defence in
//     depth) so a hand-built key from a future caller cannot bypass this file.
//   • Keys carry no email, name, or other personal data — only opaque ids.
//
// Keys are deterministic: the same recording always maps to the same source
// key, which is what makes uploads and repairs idempotent (re-running a copy
// overwrites the same object rather than creating a duplicate).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { InvalidRequestError } = require('./errors');

// Identifiers we interpolate into keys. Deliberately narrow: our own ids are
// `rec_<uuid>` / `usr_<uuid>` / ULID-ish, none of which need anything else.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// A whole key, once built. Segments separated by single "/", no leading or
// trailing slash, no empty segment, no "." or ".." segment anywhere.
const KEY_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_KEY_LENGTH = 1024;      // S3/R2 hard limit
const MAX_SEGMENT_LENGTH = 255;

// Server-chosen extensions. A client never supplies one.
const SOURCE_EXTENSIONS = new Set(['webm', 'mp4', 'mov', 'mkv']);

const PREFIX = {
  sources: 'sources',
  derived: 'derived',
  audio: 'audio',
  renders: 'renders',
  uploadsTmp: 'uploads-tmp',
};

/**
 * Validate an identifier destined for interpolation into a key.
 * @throws {InvalidRequestError}
 */
function assertId(value, what) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    // Do not echo the offending value: it is attacker-controlled and this
    // message may reach a log. Say what was wrong, not what was sent.
    throw new InvalidRequestError(
      `invalid ${what}: must be 1-128 chars of [A-Za-z0-9_-] and start alphanumeric`
    );
  }
  return value;
}

/**
 * Validate a complete object key. Every provider call runs this first.
 * Rejects traversal, absolute paths, backslashes, control characters,
 * empty/dot segments, encoded traversal, and over-length keys.
 * @throws {InvalidRequestError}
 */
function assertKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new InvalidRequestError('object key must be a non-empty string');
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new InvalidRequestError(`object key exceeds ${MAX_KEY_LENGTH} characters`);
  }
  // Control characters (incl. NUL) and whitespace never appear in our keys.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\s]/.test(key)) {
    throw new InvalidRequestError('object key contains control or whitespace characters');
  }
  if (key.includes('\\')) {
    throw new InvalidRequestError('object key must not contain backslashes');
  }
  if (key.startsWith('/')) {
    throw new InvalidRequestError('object key must be relative (no leading "/")');
  }
  if (key.endsWith('/')) {
    throw new InvalidRequestError('object key must not end with "/"');
  }
  if (key.includes('//')) {
    throw new InvalidRequestError('object key must not contain empty segments');
  }
  // Percent-encoding is not part of our key vocabulary, and allowing it would
  // let "%2e%2e%2f" survive this check and be decoded by something downstream.
  if (key.includes('%')) {
    throw new InvalidRequestError('object key must not contain percent-encoding');
  }
  for (const segment of key.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new InvalidRequestError('object key must not contain path traversal segments');
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw new InvalidRequestError(`object key segment exceeds ${MAX_SEGMENT_LENGTH} characters`);
    }
    if (!KEY_SEGMENT_PATTERN.test(segment)) {
      throw new InvalidRequestError('object key contains an invalid character');
    }
  }
  return key;
}

/** True when `key` is a valid object key. Never throws. */
function isValidKey(key) {
  try { assertKey(key); return true; } catch { return false; }
}

/**
 * Choose the stored extension for a source object.
 * The client's filename is NEVER trusted — the caller passes a container
 * format it determined server-side (from the negotiated MIME type).
 */
function sourceExtension(container) {
  const ext = String(container || 'webm').toLowerCase().replace(/^\./, '');
  if (!SOURCE_EXTENSIONS.has(ext)) {
    throw new InvalidRequestError(
      `unsupported source container "${ext}" (allowed: ${[...SOURCE_EXTENSIONS].join(', ')})`
    );
  }
  return ext;
}

// ── Key builders (docs/02 §2.7) ──────────────────────────────────────────────
// Each returns a validated key. Signatures take ids, never paths.

const keys = {
  /** Immutable original upload. `sources/{recordingId}/source.{ext}` */
  source(recordingId, container = 'webm') {
    assertId(recordingId, 'recordingId');
    return assertKey(`${PREFIX.sources}/${recordingId}/source.${sourceExtension(container)}`);
  },

  /** Transcoded MP4. `derived/{recordingId}/{assetId}/video.mp4` */
  derivedVideo(recordingId, assetId) {
    assertId(recordingId, 'recordingId');
    assertId(assetId, 'assetId');
    return assertKey(`${PREFIX.derived}/${recordingId}/${assetId}/video.mp4`);
  },

  /** HLS master playlist. `derived/{recordingId}/{assetId}/hls/master.m3u8` */
  hlsMaster(recordingId, assetId) {
    assertId(recordingId, 'recordingId');
    assertId(assetId, 'assetId');
    return assertKey(`${PREFIX.derived}/${recordingId}/${assetId}/hls/master.m3u8`);
  },

  /** One HLS segment. `derived/{recordingId}/{assetId}/hls/{name}` */
  hlsSegment(recordingId, assetId, segmentName) {
    assertId(recordingId, 'recordingId');
    assertId(assetId, 'assetId');
    if (typeof segmentName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(segmentName)) {
      throw new InvalidRequestError('invalid HLS segment name');
    }
    return assertKey(`${PREFIX.derived}/${recordingId}/${assetId}/hls/${segmentName}`);
  },

  /** Poster / thumbnail / preview. `derived/{recordingId}/{assetId}/{kind}` */
  image(recordingId, assetId, kind) {
    assertId(recordingId, 'recordingId');
    assertId(assetId, 'assetId');
    // T-703: the hover preview is an animated WebP (docs/09 §4); `preview`
    // (gif) stays for compatibility with anything already keyed that way.
    const allowed = { poster: 'poster.jpg', thumb: 'thumb.jpg', preview: 'preview.gif', preview_webp: 'preview.webp' };
    const file = allowed[kind];
    if (!file) {
      throw new InvalidRequestError(`invalid image kind (allowed: ${Object.keys(allowed).join(', ')})`);
    }
    return assertKey(`${PREFIX.derived}/${recordingId}/${assetId}/${file}`);
  },

  /** Extracted audio for STT. `audio/{recordingId}/audio.m4a` */
  audio(recordingId) {
    assertId(recordingId, 'recordingId');
    return assertKey(`${PREFIX.audio}/${recordingId}/audio.m4a`);
  },

  /** Editor render output. `renders/{editSessionId}/{renderJobId}.mp4` */
  render(editSessionId, renderJobId) {
    assertId(editSessionId, 'editSessionId');
    assertId(renderJobId, 'renderJobId');
    return assertKey(`${PREFIX.renders}/${editSessionId}/${renderJobId}.mp4`);
  },

  /**
   * Scratch space for an in-progress multipart upload.
   * `uploads-tmp/{uploadSessionId}/part-assembly` — swept by the 48h
   * incomplete-multipart lifecycle rule (docs/02 §2.7, provisioned in T-202).
   */
  uploadTemp(uploadSessionId, container = 'webm') {
    assertId(uploadSessionId, 'uploadSessionId');
    return assertKey(`${PREFIX.uploadsTmp}/${uploadSessionId}/source.${sourceExtension(container)}`);
  },
};

module.exports = {
  keys, assertKey, assertId, isValidKey, sourceExtension,
  PREFIX, MAX_KEY_LENGTH, SOURCE_EXTENSIONS,
};
