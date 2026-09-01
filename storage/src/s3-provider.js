// ─────────────────────────────────────────────────────────────────────────────
// S3-COMPATIBLE STORAGE PROVIDER (T-201)
//
// ONE implementation serves Cloudflare R2 (production) and MinIO (local/test).
// Both speak the S3 API; only config.js differs. There is deliberately no
// `if (flavour === 'r2')` anywhere below — a second code path is exactly the
// bug this abstraction exists to prevent, because it would mean the thing we
// test locally is not the thing that runs in production.
//
// Contract notes that matter to later tasks:
//   • The API never streams video bytes (docs/02 §1.2). `putObject` exists for
//     server-side artefacts — manifests, posters, worker output — not for user
//     uploads, which go browser → R2 via presigned multipart URLs.
//   • Presigned URLs bind method + key + expiry, and optionally Content-Length,
//     which is what lets T-306 enforce a byte ceiling the client cannot exceed.
//   • Every key crosses assertKey() before it reaches the wire, even though the
//     builders already validated it: defence in depth for future callers.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const { assertKey } = require('./keys');
const {
  mapStorageError, InvalidRequestError, ObjectNotFoundError, StorageError,
} = require('./errors');

// S3 multipart rules. Enforced here so a bad part number fails locally with a
// clear error instead of a confusing 400 from the provider.
const MIN_PART_NUMBER = 1;
const MAX_PART_NUMBER = 10_000;

class S3StorageProvider {
  /**
   * @param {object} config result of loadStorageConfig()
   * @param {object} [deps] injection seam for tests (client factory)
   */
  constructor(config, deps = {}) {
    this.config = config;
    this.bucket = config.bucket;

    this.client = deps.client || new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      maxAttempts: config.maxAttempts,
      requestHandler: { requestTimeout: config.requestTimeoutMs },
    });
  }

  /** Safe-to-log description. Never includes credentials. */
  describe() { return this.config.describe(); }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Run an SDK command, translating any failure into the storage taxonomy. */
  async #send(command, operation, key) {
    try {
      return await this.client.send(command);
    } catch (err) {
      throw mapStorageError(err, { operation, key: key || null });
    }
  }

  /**
   * Resolve a TTL against the configured ceiling.
   * A caller asking for longer than the cap is a bug or an attack, not a
   * preference — refuse rather than silently shortening, so it surfaces.
   */
  #ttl(requested, fallback) {
    const ttl = requested === undefined || requested === null ? fallback : Number(requested);
    if (!Number.isInteger(ttl) || ttl < 1) {
      throw new InvalidRequestError('expiresIn must be a positive integer number of seconds');
    }
    if (ttl > this.config.maxSignedUrlTtlSeconds) {
      throw new InvalidRequestError(
        `expiresIn exceeds the configured maximum of ${this.config.maxSignedUrlTtlSeconds}s`);
    }
    return ttl;
  }

  #partNumber(n) {
    if (!Number.isInteger(n) || n < MIN_PART_NUMBER || n > MAX_PART_NUMBER) {
      throw new InvalidRequestError(
        `partNumber must be an integer in [${MIN_PART_NUMBER}, ${MAX_PART_NUMBER}]`);
    }
    return n;
  }

  // ── basic object operations ────────────────────────────────────────────────

  /**
   * Write an object. Server-side artefacts only — never a user's video stream.
   * Overwrite semantics are last-writer-wins (S3 default), which is what makes
   * a retried write idempotent for a deterministic key.
   *
   * @param {string} key
   * @param {Buffer|Uint8Array|string} body
   * @param {{contentType?: string, contentLength?: number, metadata?: object,
   *          cacheControl?: string}} [options]
   */
  async putObject(key, body, options = {}) {
    assertKey(key);
    if (body === undefined || body === null) {
      throw new InvalidRequestError('putObject requires a body');
    }
    const res = await this.#send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ...(options.contentType ? { ContentType: options.contentType } : {}),
      ...(options.contentLength !== undefined ? { ContentLength: options.contentLength } : {}),
      ...(options.cacheControl ? { CacheControl: options.cacheControl } : {}),
      ...(options.metadata ? { Metadata: sanitizeMetadata(options.metadata) } : {}),
    }), 'putObject', key);
    return { key, etag: stripQuotes(res.ETag) };
  }

  /**
   * Read an object. Returns a stream plus metadata.
   * Workers use this; request handlers must not (docs/02 §1.2).
   */
  async getObject(key) {
    assertKey(key);
    const res = await this.#send(new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      'getObject', key);
    return {
      key,
      body: res.Body,
      contentType: res.ContentType || null,
      contentLength: numberOrNull(res.ContentLength),
      etag: stripQuotes(res.ETag),
      lastModified: res.LastModified || null,
      metadata: res.Metadata || {},
    };
  }

  /** Read an object fully into a Buffer. Small artefacts only (manifests). */
  async getObjectBuffer(key) {
    const object = await this.getObject(key);
    const chunks = [];
    for await (const chunk of object.body) chunks.push(Buffer.from(chunk));
    return { ...object, body: Buffer.concat(chunks) };
  }

  /** Object metadata without the bytes. Throws ObjectNotFoundError if absent. */
  async headObject(key) {
    assertKey(key);
    const res = await this.#send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      'headObject', key);
    return {
      key,
      contentType: res.ContentType || null,
      contentLength: numberOrNull(res.ContentLength),
      etag: stripQuotes(res.ETag),
      lastModified: res.LastModified || null,
      metadata: res.Metadata || {},
    };
  }

  /** Existence check. Never throws for a missing object. */
  async objectExists(key) {
    try {
      await this.headObject(key);
      return true;
    } catch (err) {
      if (err instanceof ObjectNotFoundError) return false;
      throw err;
    }
  }

  /**
   * Delete an object. Idempotent: S3 reports success for a key that is already
   * gone, and we preserve that — a retried delete must not fail a cleanup job.
   */
  async deleteObject(key) {
    assertKey(key);
    await this.#send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      'deleteObject', key);
    return { key, deleted: true };
  }

  /** Delete many objects in one round trip. Also idempotent. */
  async deleteObjects(keys) {
    if (!Array.isArray(keys) || keys.length === 0) return { deleted: 0, errors: [] };
    if (keys.length > 1000) {
      throw new InvalidRequestError('deleteObjects accepts at most 1000 keys per call');
    }
    keys.forEach((k) => assertKey(k));
    const res = await this.#send(new DeleteObjectsCommand({
      Bucket: this.bucket,
      Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
    }), 'deleteObjects');
    return {
      deleted: keys.length - ((res.Errors && res.Errors.length) || 0),
      // Codes and keys only — provider messages can carry endpoint detail.
      errors: (res.Errors || []).map((e) => ({ key: e.Key, code: e.Code })),
    };
  }

  /**
   * List objects under a prefix. For maintenance/reconciliation only —
   * R2 is NOT the application database (docs/02 §2.7); ownership and lifecycle
   * live in PostgreSQL, and no request path may list to answer a user query.
   */
  async listObjects(prefix, options = {}) {
    if (typeof prefix !== 'string' || prefix.length === 0) {
      throw new InvalidRequestError('listObjects requires a prefix');
    }
    // A prefix is not a whole key (it may end mid-segment), so validate the
    // dangerous parts only — traversal must still be impossible.
    if (prefix.includes('..') || prefix.startsWith('/') || prefix.includes('\\') || prefix.includes('%')) {
      throw new InvalidRequestError('invalid listObjects prefix');
    }
    const res = await this.#send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix,
      ...(options.continuationToken ? { ContinuationToken: options.continuationToken } : {}),
      MaxKeys: options.maxKeys || 1000,
    }), 'listObjects');
    return {
      objects: (res.Contents || []).map((o) => ({
        key: o.Key,
        size: numberOrNull(o.Size),
        etag: stripQuotes(o.ETag),
        lastModified: o.LastModified || null,
      })),
      truncated: !!res.IsTruncated,
      continuationToken: res.NextContinuationToken || null,
    };
  }

  // ── signed URLs ────────────────────────────────────────────────────────────

  /**
   * Time-limited GET URL for one object.
   *
   * The signature covers the method, the bucket, the key and the expiry, so a
   * URL for one object cannot be edited into a URL for another — that is the
   * whole basis of keeping the bucket private (docs/02 §2.7, docs/12 §6).
   * The result is a bearer credential: never log it (docs/17), never store it.
   */
  async getSignedDownloadUrl(key, options = {}) {
    assertKey(key);
    const expiresIn = this.#ttl(options.expiresIn, this.config.defaultGetTtlSeconds);
    try {
      return await getSignedUrl(this.client, new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // Lets the watch page force a download or set a filename without the
        // object itself being rewritten.
        ...(options.responseContentType
          ? { ResponseContentType: options.responseContentType } : {}),
        ...(options.responseContentDisposition
          ? { ResponseContentDisposition: options.responseContentDisposition } : {}),
      }), { expiresIn });
    } catch (err) {
      throw mapStorageError(err, { operation: 'getSignedDownloadUrl', key });
    }
  }

  /**
   * Time-limited PUT URL for one object.
   *
   * When `contentLength` is supplied it is signed, so the provider rejects a
   * body of any other size. That is the enforceable ceiling T-306 needs — an
   * actual constraint at the storage layer rather than a client-side promise.
   */
  async getSignedUploadUrl(key, options = {}) {
    assertKey(key);
    const expiresIn = this.#ttl(options.expiresIn, this.config.defaultPutTtlSeconds);
    if (options.contentLength !== undefined) {
      if (!Number.isInteger(options.contentLength) || options.contentLength < 0) {
        throw new InvalidRequestError('contentLength must be a non-negative integer');
      }
    }
    try {
      return await getSignedUrl(this.client, new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(options.contentType ? { ContentType: options.contentType } : {}),
        ...(options.contentLength !== undefined ? { ContentLength: options.contentLength } : {}),
        ...(options.metadata ? { Metadata: sanitizeMetadata(options.metadata) } : {}),
      }), {
        expiresIn,
        // Sign Content-Length/Content-Type when present so the client cannot
        // drop or alter them; unsignable headers would make the limit advisory.
        ...(options.contentLength !== undefined || options.contentType
          ? { signableHeaders: new Set(['host', 'content-length', 'content-type']) }
          : {}),
      });
    } catch (err) {
      throw mapStorageError(err, { operation: 'getSignedUploadUrl', key });
    }
  }

  // ── multipart lifecycle ────────────────────────────────────────────────────
  //
  // create → presign part URLs → (browser PUTs parts) → complete | abort.
  // The API orchestrates and signs; the bytes go browser → R2 directly.
  // The browser-facing session API on top of this is T-301, NOT T-201.

  /**
   * Begin a multipart upload. Returns the provider's upload id, which the
   * caller must persist (PostgreSQL owns that state, not R2) to be able to
   * complete or abort later — including after an API restart.
   */
  async createMultipartUpload(key, options = {}) {
    assertKey(key);
    const res = await this.#send(new CreateMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      ...(options.contentType ? { ContentType: options.contentType } : {}),
      ...(options.metadata ? { Metadata: sanitizeMetadata(options.metadata) } : {}),
    }), 'createMultipartUpload', key);
    if (!res.UploadId) {
      throw mapStorageError(new Error('provider returned no UploadId'),
        { operation: 'createMultipartUpload', key });
    }
    return { key, uploadId: res.UploadId };
  }

  /** Time-limited PUT URL for one part of a multipart upload. */
  async getSignedPartUrl(key, uploadId, partNumber, options = {}) {
    assertKey(key);
    assertUploadId(uploadId);
    this.#partNumber(partNumber);
    const expiresIn = this.#ttl(options.expiresIn, this.config.defaultPutTtlSeconds);
    if (options.contentLength !== undefined
      && (!Number.isInteger(options.contentLength) || options.contentLength < 0)) {
      throw new InvalidRequestError('contentLength must be a non-negative integer');
    }
    try {
      return await getSignedUrl(this.client, new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ...(options.contentLength !== undefined ? { ContentLength: options.contentLength } : {}),
      }), {
        expiresIn,
        ...(options.contentLength !== undefined
          ? { signableHeaders: new Set(['host', 'content-length']) }
          : {}),
      });
    } catch (err) {
      throw mapStorageError(err, { operation: 'getSignedPartUrl', key });
    }
  }

  /** Parts the provider has actually received. The truth for a resumed upload. */
  async listParts(key, uploadId) {
    assertKey(key);
    assertUploadId(uploadId);
    const res = await this.#send(new ListPartsCommand({
      Bucket: this.bucket, Key: key, UploadId: uploadId,
    }), 'listParts', key);
    return (res.Parts || []).map((p) => ({
      partNumber: p.PartNumber,
      etag: stripQuotes(p.ETag),
      size: numberOrNull(p.Size),
    }));
  }

  /**
   * Finish a multipart upload; the object becomes visible at `key` only now.
   *
   * Retry safety: completion is keyed by (key, uploadId), so a retry after a
   * lost response either completes the same upload again or reports the upload
   * as gone — it can never produce a second object. Callers treat
   * UploadNotFoundError on retry as "already completed" and re-check with head.
   */
  async completeMultipartUpload(key, uploadId, parts) {
    assertKey(key);
    assertUploadId(uploadId);
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new InvalidRequestError('completeMultipartUpload requires at least one part');
    }
    const normalized = parts.map((p) => {
      this.#partNumber(p && p.partNumber);
      if (typeof p.etag !== 'string' || !p.etag) {
        throw new InvalidRequestError(`part ${p.partNumber} is missing its etag`);
      }
      return { PartNumber: p.partNumber, ETag: ensureQuotes(p.etag) };
    }).sort((a, b) => a.PartNumber - b.PartNumber);

    // S3 requires ascending order and rejects duplicates; catch it here so the
    // caller gets a precise error rather than a generic InvalidPartOrder.
    for (let i = 1; i < normalized.length; i += 1) {
      if (normalized[i].PartNumber === normalized[i - 1].PartNumber) {
        throw new InvalidRequestError(`duplicate part number ${normalized[i].PartNumber}`);
      }
    }

    const res = await this.#send(new CompleteMultipartUploadCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: normalized },
    }), 'completeMultipartUpload', key);

    return { key, etag: stripQuotes(res.ETag), location: res.Location || null };
  }

  /**
   * Abort a multipart upload and discard its parts.
   *
   * Safely repeatable: an already-aborted or unknown upload resolves rather
   * than throwing, because cleanup paths (and the 48h lifecycle rule in T-202)
   * must be able to run more than once without special-casing.
   */
  async abortMultipartUpload(key, uploadId) {
    assertKey(key);
    assertUploadId(uploadId);
    try {
      await this.client.send(new AbortMultipartUploadCommand({
        Bucket: this.bucket, Key: key, UploadId: uploadId,
      }));
      return { key, uploadId, aborted: true };
    } catch (err) {
      const mapped = mapStorageError(err, { operation: 'abortMultipartUpload', key });
      if (mapped.code === 'upload_not_found' || mapped.code === 'object_not_found') {
        return { key, uploadId, aborted: false, alreadyGone: true };
      }
      throw mapped;
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function assertUploadId(uploadId) {
  if (typeof uploadId !== 'string' || !uploadId || uploadId.length > 1024) {
    throw new InvalidRequestError('uploadId must be a non-empty string');
  }
  return uploadId;
}

/**
 * User metadata rides in HTTP headers, so a newline would be header injection
 * and a non-ASCII byte is silently mangled. Keep it to safe ASCII, and keep it
 * small — this is not where application state belongs (PostgreSQL owns that).
 */
function sanitizeMetadata(metadata) {
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(metadata || {})) {
    const key = String(rawKey).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) {
      throw new InvalidRequestError(`invalid metadata key "${key}"`);
    }
    const value = String(rawValue);
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(value) || /[^\x20-\x7e]/.test(value)) {
      throw new InvalidRequestError(`metadata value for "${key}" must be printable ASCII`);
    }
    if (value.length > 512) {
      throw new InvalidRequestError(`metadata value for "${key}" exceeds 512 characters`);
    }
    out[key] = value;
  }
  return out;
}

const stripQuotes = (v) => (typeof v === 'string' ? v.replace(/^"|"$/g, '') : null);
const ensureQuotes = (v) => (/^".*"$/.test(v) ? v : `"${v}"`);
const numberOrNull = (v) => (v === undefined || v === null ? null : Number(v));

module.exports = { S3StorageProvider, MIN_PART_NUMBER, MAX_PART_NUMBER };
