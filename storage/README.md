# `@veorec/storage` — object storage for VeoRec (T-201)

Provider-agnostic access to **object bytes**. Cloudflare R2 in production, MinIO
locally — one implementation, two configurations.

```js
const { storageProvider, keys } = require('@veorec/storage');

const provider = storageProvider();
const key = keys.source('rec_abc');                        // never build keys by hand
const url = await provider.getSignedDownloadUrl(key, { expiresIn: 600 });
```

## The boundary

| Owns | System |
|---|---|
| recording, owner, status, `size_bytes`, duration, upload/processing state, quota ledger | **PostgreSQL** (`@veorec/db`) |
| source media, derived MP4/HLS, thumbnails, posters, audio, exports | **R2** (this package) |

R2 is **not** an application database. There is deliberately no
`provider.deleteRecording(userId, …)`: ownership is resolved by a repository
*before* a key is built, and no authorization decision happens in here.

## Rules

1. **Import from `@veorec/storage`, never `@aws-sdk/*`.** The SDK is confined to
   `src/s3-provider.js`; a test asserts this. That confinement is what makes R2
   replaceable by B2/Wasabi/S3 without touching business logic.
2. **Never build a key by hand** — use `keys.*`. Identifiers are validated before
   interpolation, and a client filename is never trusted as a path.
3. **Never log a signed URL.** It is a bearer credential for one object.
4. **The API never proxies video bytes.** `putObject`/`getObject` are for
   server-side artefacts and workers. User uploads go browser → R2 via presigned
   multipart URLs; playback goes browser → Cloudflare → R2.
5. **Cloudinary is not here and never will be.** It is legacy migration
   infrastructure only, and is never a `StorageProvider` target or fallback.

## Configuration

All from the environment (`.env.example`). Nothing is hardcoded; `staging` and
`production` have no defaults and fail fast when a value is missing.

| Variable | Purpose |
|---|---|
| `STORAGE_PROVIDER` | `minio` \| `r2` \| `s3` — configuration flavour only; no code branches on it |
| `STORAGE_ENDPOINT` | S3 API endpoint (https required when deployed) |
| `STORAGE_BUCKET` | bucket name — **server configuration only, never user input** |
| `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` | credentials |
| `STORAGE_REGION` | `auto` for R2 |
| `STORAGE_FORCE_PATH_STYLE` | `true` for R2 and MinIO |
| `STORAGE_MAX_SIGNED_URL_TTL` | hard ceiling on signed-URL lifetime |

Credentials never appear in `describe()`, `JSON.stringify(config)`,
`util.inspect(config)`, or any thrown message — asserted by tests.

## Object keys (docs/02 §2.7)

```
sources/{recordingId}/source.{webm|mp4}          immutable original
derived/{recordingId}/{assetId}/video.mp4        transcoded
derived/{recordingId}/{assetId}/hls/master.m3u8  + segments
derived/{recordingId}/{assetId}/poster.jpg|thumb.jpg|preview.gif
audio/{recordingId}/audio.m4a                    extraction for STT
renders/{editSessionId}/{renderJobId}.mp4        editor output
uploads-tmp/{uploadSessionId}/source.{ext}       multipart scratch (48h lifecycle)
```

Deterministic, so a retried copy overwrites rather than duplicating. Opaque to
higher layers — stored as `video_assets.storage_key`.

## Errors

`object_not_found` · `permission_denied` · `conflict` · `invalid_request` ·
`upload_not_found` · `multipart_failed` · `provider_unavailable` · `timeout` ·
`unknown_storage_error` · `storage_config_error`

Every error carries `retryable`. No raw SDK error escapes, and no HTTP status is
attached — the transport layer maps codes to responses (docs/18 §2).

## Tests

```bash
cd storage
npm run test:unit       # 110 assertions, no infrastructure needed
npm run test:contract   # needs MinIO or R2; skips loudly otherwise
```

`test:contract` is the **abstract contract suite**: it imports no SDK and names
no bucket, so the same file verifies MinIO and R2.

```bash
docker compose up -d minio          # then:
cd storage && npm run test:contract
```

Against real R2 (staging credentials only, never production):

```bash
STORAGE_PROVIDER=r2 STORAGE_CONTRACT_TARGET=r2 \
STORAGE_ENDPOINT=https://<acct>.r2.cloudflarestorage.com \
STORAGE_BUCKET=<staging-bucket> STORAGE_ACCESS_KEY_ID=… STORAGE_SECRET_ACCESS_KEY=… \
npm run test:contract
```

`STORAGE_TESTS_REQUIRED=1` turns an unreachable endpoint into a failure (CI).
The suite refuses to run when `APP_ENV=production`.

## Not implemented by T-201

Bucket provisioning/lifecycle/CORS (T-202) · upload mirroring (T-203) · backfill
(T-204) · the browser upload-session API (T-301) · quota reservation (T-306) ·
processing (Phase 5) · any application code calling this package.
