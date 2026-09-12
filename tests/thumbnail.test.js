// T-703 thumbnails / poster / preview (run: cd worker && npm run test:thumbnail)
//
// A. pure: poster time rule, candidate stepping, preview clip starts, the
//    in-process play icon PNG; B. real ffmpeg: a fixture with 3 s of black
//    lead-in → the poster skips the black frames (non-black acceptance),
//    poster 1280 w / thumb 640 w / play-overlay variant / animated WebP
//    preview under budget, no preview under 10 s, an all-black source falls
//    back loudly, abort; C. the processor end-to-end on PostgreSQL + MinIO +
//    Redis: four asset rows with asset-id-scoped keys and content types,
//    promotion in both orders (transcode-then-thumbnail, thumbnail-then-
//    transcode), no preview for short clips, idempotent re-run, and the
//    placeholder promotion when the thumbnail job fails terminally while the
//    MP4 is ready; D. wiring.
//
// SKIPS LOUDLY without infrastructure; THUMB_TESTS_REQUIRED=1 makes that a failure.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const W = require(path.join(ROOT, 'worker', 'src', 'index.js'));
const T = require(path.join(ROOT, 'worker', 'src', 'media', 'thumbnail.js'));
const { renderPlayIconPng } = require(path.join(ROOT, 'worker', 'src', 'media', 'play-icon.js'));
const IORedis = require(path.join(ROOT, 'worker', 'node_modules', 'ioredis'));
const { loadEnv, createPool, createClient, createRepositories, withTransaction: rawTx } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.THUMB_TESTS_REQUIRED === '1';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6380';
const MINIO = process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100';
const RUN = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silent = W.silentLogger();
const REASON = 'T-703 thumbnail test';

(async () => {
  console.log('T-703 thumbnails / poster / preview tests');

  // ── A. Pure ───────────────────────────────────────────────────────────────
  console.log('\nA. Pure');
  ok(T.basePosterTime(60) === 2 && T.basePosterTime(12) === 1.2 && T.basePosterTime(0) === 0, 'poster time = min(2 s, 10 % of duration)');
  ok(T.posterCandidates(60).join() === '2,3,4,5,6' && T.posterCandidates(3.5).join() === '0.35,1.35,2.35,3.35' && T.posterCandidates(0.2).join() === '0.02', 'candidates step +1 s and never pass the end');
  ok(T.previewClipStarts(12).join() === '1.2,6,10.8' && T.previewClipStarts(10).join() === '1,5,9', 'preview clips start at 10/50/90 % clamped so 1 s fits');
  const png = renderPlayIconPng(160);
  ok(png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && png.readUInt32BE(16) === 160 && png.readUInt32BE(20) === 160 && png[24] === 8 && png[25] === 6, 'the play icon is a valid 160×160 8-bit RGBA PNG');
  ok(T.DARK_YAVG === 24 && T.POSTER_WIDTH === 1280 && T.THUMB_WIDTH === 640 && T.PREVIEW_MIN_DURATION_SEC === 10 && T.PREVIEW_BUDGET_BYTES === 400 * 1024, 'docs/09 §4 constants');
  {
    const seen = [];
    const fakeLuma = async (_p, t) => { seen.push(t); return t < 2.9 ? 5 : 90; };
    const th = T.createThumbnailer({ ffmpegBin: 'x', prober: { probeFile: async () => ({}) } });
    const pick = await th.pickPosterTime('f', 30, { luma: fakeLuma });
    ok(pick.t === 3 && pick.dark === false && pick.tried === 2 && seen.join() === '2,3', 'the first non-dark candidate wins (unit, injected luma)');
    const dark = await th.pickPosterTime('f', 30, { luma: async () => 3 });
    ok(dark.dark === true && dark.t === 2 && dark.tried === 5, 'all-dark → base frame, flagged dark');
    let threw = null; try { T.createThumbnailer({ ffmpegBin: 'x' }); } catch (e) { threw = e; }
    ok(threw && /prober/.test(threw.message), 'a thumbnailer without a prober cannot exist');
  }

  const bins = W.resolveBinaries();
  let ffmpegOk = false;
  try { await W.runTool(bins.ffmpegBin, ['-version'], { timeout: 10000 }); await W.runTool(bins.ffprobeBin, ['-version'], { timeout: 10000 }); ffmpegOk = true; } catch {}
  if (!ffmpegOk) {
    console.log('\n  SKIPPED B–C — no ffmpeg/ffprobe');
    if (REQUIRED) { fail += 1; console.log('  FAIL: THUMB_TESTS_REQUIRED=1 but ffmpeg is unavailable'); }
  } else {
    console.log('\nB. Real ffmpeg');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't703-'));
    const f = (n) => path.join(dir, n);
    const gen = (out, a) => W.runTool(bins.ffmpegBin, ['-hide_banner', '-nostdin', '-y', ...a, out], { timeout: 120000 });
    // 3 s black + 9 s test pattern = 12 s (a screen recording with a blank start).
    // 1080p so the 1280-wide poster / 640-wide thumbnail caps are exercised (smaller sources are never upscaled).
    await gen(f('lead.webm'), ['-f', 'lavfi', '-i', 'color=black:size=1920x1080:rate=30:duration=3', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=9', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libvpx', '-b:v', '600k', '-deadline', 'realtime', '-cpu-used', '8']);
    await gen(f('short.webm'), ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-t', '4', '-c:v', 'libvpx', '-b:v', '200k', '-an']);
    await gen(f('black.webm'), ['-f', 'lavfi', '-i', 'color=black:size=320x240:rate=30', '-t', '6', '-c:v', 'libvpx', '-b:v', '100k', '-an']);
    const prober = W.createProber({ ffprobeBin: bins.ffprobeBin, ffmpegBin: bins.ffmpegBin, logger: silent });
    const th = T.createThumbnailer({ ffmpegBin: bins.ffmpegBin, prober, logger: silent });
    const out1 = fs.mkdtempSync(path.join(dir, 'out1-'));
    const r = await th.generateAll(f('lead.webm'), out1, { durationSec: 12 });
    ok(r.time.t >= 3 && r.time.dark === false && r.time.luma >= T.DARK_YAVG, `the poster skips the black lead-in (picked t=${r.time.t}, luma ${r.time.luma})`);
    ok(r.poster.width === 1280 && r.poster.height === 720 && r.poster.bytes > 5000 && fs.readFileSync(r.poster.path).subarray(0, 2).toString('hex') === 'ffd8', 'poster: 1280 w jpeg');
    ok(r.thumb.width === 640 && r.thumb.height === 360, 'thumbnail: 640 w');
    ok(r.posterPlay.width === 1280 && r.posterPlay.height === 720 && r.posterPlay.bytes !== r.poster.bytes, 'play-overlay poster: same size, different pixels');
    ok(r.preview && r.preview.bytes > 0 && r.preview.bytes <= T.PREVIEW_BUDGET_BYTES && r.preview.starts.join() === '1.2,6,10.8' && fs.readFileSync(r.preview.path).subarray(0, 12).toString('latin1').endsWith('WEBP'), 'preview: 3 clips at 10/50/90 % as an animated WebP under budget');
    const out2 = fs.mkdtempSync(path.join(dir, 'out2-'));
    const r2 = await th.generateAll(f('short.webm'), out2, { durationSec: 4 });
    ok(r2.preview === null && r2.poster.width === 320 && r2.time.t === 0.4, 'under 10 s → no preview; a small source is not upscaled');
    const out3 = fs.mkdtempSync(path.join(dir, 'out3-'));
    const r3 = await th.generateAll(f('black.webm'), out3, { durationSec: 6 });
    ok(r3.time.dark === true && r3.poster.bytes > 0, 'an all-black source still yields a poster (flagged dark, logged)');
    const ac = new AbortController();
    const p = th.generateAll(f('lead.webm'), fs.mkdtempSync(path.join(dir, 'out4-')), { durationSec: 12, signal: ac.signal }).then(() => null, (e) => e);
    setTimeout(() => ac.abort(), 30);
    const aborted = await p;
    ok(aborted && aborted.code === 'aborted', 'an abort signal stops generation');

    // ── C. Processor end-to-end ─────────────────────────────────────────────
    let env = null, pgUp = false, redisUp = false, storageUp = false, pool = null;
    try { env = loadEnv({ appEnv: 'test' }); } catch (e) { console.log('  env:', e.message); }
    if (env) { pool = createPool({ env, max: 8 }); try { await pool.query('select 1'); pgUp = true; } catch {} }
    try { const c = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 1500, lazyConnect: true }); await c.connect(); redisUp = (await c.ping()) === 'PONG'; await c.quit(); } catch {}
    try { storageUp = (await fetch(`${MINIO}/minio/health/live`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
    if (!pgUp || !redisUp || !storageUp) {
      console.log(`\n  SKIPPED C — ${[!pgUp && 'PostgreSQL unreachable', !redisUp && `no Redis at ${REDIS_URL}`, !storageUp && `no object storage at ${MINIO}`].filter(Boolean).join(', ')}`);
      if (REQUIRED) { fail += 1; console.log('  FAIL: THUMB_TESTS_REQUIRED=1 but infrastructure is unavailable'); }
    } else {
      console.log('\nC. Processor on real PostgreSQL + MinIO + Redis');
      const db = createClient(pool);
      const repositories = () => createRepositories(db);
      const repos = repositories();
      const withTransaction = (fn) => rawTx(fn, db);
      const storagePkg = require(path.join(ROOT, 'storage', 'src', 'index.js'));
      const storage = storagePkg.createStorageProvider({ appEnv: 'test' });
      const keys = storagePkg.keys;
      const U = `usr_t703_${RUN}`;
      await db.execute(sql`INSERT INTO users (id,email,name,password_hash) VALUES (${U}, ${`t703-${RUN}@example.com`}, 'T703', 'x')`);
      const rid = (k) => `rec_t703_${k}_${RUN}`;
      const created = [];
      const mkRec = async (k, file) => {
        const bytes = fs.readFileSync(f(file));
        await db.execute(sql`INSERT INTO recordings (id,user_id,title,status,source_kind,privacy,size_bytes) VALUES (${rid(k)}, ${U}, ${k}, 'uploaded', 'extension', 'unlisted', ${bytes.length})`);
        const key = `sources/${rid(k)}/source.webm`;
        await storage.putObject(key, bytes, { contentType: 'video/webm' });
        await db.execute(sql`INSERT INTO video_assets (id,recording_id,kind,storage_key,status,size_bytes,counts_toward_quota) VALUES (${`ast_t703_${k}_${RUN}`}, ${rid(k)}, 'source', ${key}, 'ready', ${bytes.length}, true)`);
        created.push(rid(k));
        return rid(k);
      };
      const rec = (id) => repos.recordings.getSystem(id, REASON);
      const rowOf = (key) => repos.jobs.findByDedupeKey(key);
      const assetsOf = (id) => repos.assets.listByRecordingSystem(id, REASON);
      const until = async (fn, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(150); } return false; };
      const transcoder = W.createTranscoder({ ffmpegBin: bins.ffmpegBin, prober, logger: silent });
      const registry = W.createRegistry();
      W.registerMediaProcessors(registry);
      const deps = { storage, withTransaction, prober, transcoder, thumbnailer: th, keys, resolveLimits: async () => ({ planSlug: 'pro', maxRecordingDurationSeconds: 36000 }) };
      const direct = (type, recordingId, extra = {}) => (async () => {
        const dedupe = type === 'transcode' ? `transcode:${recordingId}:mp4` : type === 'thumbnail' ? `thumb:${recordingId}` : `${type}:${recordingId}`;
        let job = await rowOf(dedupe);
        if (!job) job = (await repos.jobs.enqueue({ queue: type, dedupeKey: dedupe, recordingId, payload: { recordingId } })).job;
        job = await repos.jobs.markActiveSystem(job.id, REASON);
        try {
          const result = await registry.get(type).handler({ payload: job.payload, job, signal: new AbortController().signal, logger: silent, deps: { ...deps, ...extra }, repositories });
          await repos.jobs.markCompletedSystem(job.id, result, REASON);
          return { result, job };
        } catch (e) { await repos.jobs.markFailedSystem(job.id, e.message, REASON, { terminal: e.retryable === false }); throw e; }
      })();
      const kindsOf = async (id) => (await assetsOf(id)).filter((a) => a.kind !== 'source').map((a) => `${a.kind}${a.variant ? '/' + a.variant : ''}:${a.status}`).sort().join();

      try {
        // Through the real worker app: probe → fan-out → thumbnail (media-only registry).
        const A = await mkRec('a', 'lead.webm');
        const prefix = `t703${RUN}`;
        const q = W.createBullJobQueue({ redisUrl: REDIS_URL, prefix, logger: silent, stalledIntervalMs: 500, lockDurationMs: 1000 });
        const config = W.loadWorkerConfig({ REDIS_URL, QUEUE_PREFIX: prefix, OUTBOX_INTERVAL_MS: '100', RECONCILE_INTERVAL_MS: '600000', WORKER_SCHEDULER: 'false', WORKER_DEFER_MS: '100' }, { appEnv: 'test' });
        const app = W.createWorkerApp({ config, logger: silent, repositories, jobQueue: q, registry: W.createDefaultRegistry({ maintenance: false, stt: false }), deps });
        await app.start();
        await repos.jobs.enqueue({ queue: 'probe', dedupeKey: `probe:${A}`, recordingId: A, payload: {} });
        ok(await until(async () => { const j = await rowOf(`thumb:${A}`); const t = await rowOf(`transcode:${A}:mp4`); return j && j.status === 'completed' && t && t.status === 'completed'; }, 120000), 'probe fans out; thumbnail and transcode both complete through the real pipeline');
        ok((await kindsOf(A)) === 'mp4/main:ready,poster/play:ready,poster:ready,preview_gif:ready,thumbnail:ready', 'asset rows: mp4, poster, poster/play, thumbnail, preview (all ready)');
        const aA = await assetsOf(A);
        const poster = aA.find((a) => a.kind === 'poster' && !a.variant), play = aA.find((a) => a.kind === 'poster' && a.variant === 'play'), thumb = aA.find((a) => a.kind === 'thumbnail'), prev = aA.find((a) => a.kind === 'preview_gif');
        ok(poster.storageKey === keys.image(A, poster.id, 'poster') && play.storageKey === keys.image(A, play.id, 'poster') && thumb.storageKey === keys.image(A, thumb.id, 'thumb') && prev.storageKey === keys.image(A, prev.id, 'preview_webp'), 'every image lives under its own asset-id-scoped key');
        ok(poster.width === 1280 && thumb.width === 640 && prev.container === 'webp' && [poster, play, thumb, prev].every((a) => a.countsTowardQuota === false && Number(a.sizeBytes) > 0), 'facts on the rows; derived images never bill the user');
        const hp = await storage.headObject(poster.storageKey), hv = await storage.headObject(prev.storageKey);
        ok(hp.contentType === 'image/jpeg' && hp.contentLength === Number(poster.sizeBytes) && hv.contentType === 'image/webp', 'objects stored with the right content types and sizes');
        ok((await rec(A)).status === 'ready', 'MP4 + poster → ready (whichever finished second promoted)');
        const thumbRes = (await rowOf(`thumb:${A}`)).result;
        ok(thumbRes.time.t >= 3 && thumbRes.assets.length === 4 && thumbRes.preview === true, 'the job result records the chosen frame and the assets');
        await app.stop();
        const qq = W.createBullJobQueue({ redisUrl: REDIS_URL, prefix, logger: silent }); await qq.obliterate(); await qq.close();

        // Thumbnail first, then transcode promotes.
        const B = await mkRec('b', 'short.webm');
        await direct('probe', B);
        const rB = await direct('thumbnail', B);
        ok(rB.result.ready.promoted === false && rB.result.ready.reason === 'mp4_not_ready' && (await rec(B)).status === 'processing' && rB.result.preview === false, 'thumbnail before transcode: not promoted yet; a 4 s clip gets no preview');
        ok((await kindsOf(B)) === 'poster/play:ready,poster:ready,thumbnail:ready', 'three image rows, no preview row');
        const tB = await direct('transcode', B);
        ok(tB.result.ready.promoted === true && (await rec(B)).status === 'ready', 'transcode promotes once the poster exists');

        // Idempotent re-run: the same rows, objects overwritten.
        const idsBefore = (await assetsOf(B)).map((a) => a.id).sort().join();
        await direct('thumbnail', B);
        ok((await assetsOf(B)).map((a) => a.id).sort().join() === idsBefore && (await rec(B)).status === 'ready', 're-running thumbnail reuses the same asset rows and never demotes ready');

        // Attempts exhausted while the MP4 is ready → placeholder promotion from the settlement hook.
        const Cn = await mkRec('c', 'short.webm');
        await direct('probe', Cn);
        await direct('transcode', Cn);
        ok((await rec(Cn)).status === 'processing', 'MP4 ready but no poster → still processing');
        const broken = { generateAll: async () => { const e = new Error('ffmpeg exploded'); e.code = 'tool_failed'; e.stderrTail = 'x'; throw e; } };
        const runner = W.createJobRunner({ repositories, registry, logger: silent, deps: { ...deps, thumbnailer: broken } });
        const tj = await rowOf(`thumb:${Cn}`);
        await db.execute(sql`update processing_jobs set max_attempts = 1 where id = ${tj.id}`);
        let last = null; try { await runner.runJob({ id: tj.id, type: 'thumbnail', payload: tj.payload }); } catch (e) { last = e; }
        ok(last && last.unrecoverable && (await rowOf(`thumb:${Cn}`)).status === 'failed', 'the thumbnail job fails terminally');
        ok((await rec(Cn)).status === 'ready', 'the recording is promoted anyway (placeholder poster; docs/09 §4) via the settlement hook');
        // Guards.
        const D = await mkRec('d', 'short.webm');
        let threw = null; try { await direct('thumbnail', D); } catch (e) { threw = e; }
        ok(threw && threw.code === 'probe_required', 'thumbnail before probe → probe_required');
        await db.execute(sql`update recordings set deleted_at = now() where id = ${D}`);
        threw = null; try { await direct('thumbnail', D); } catch (e) { threw = e; }
        ok(threw && threw.code === 'recording_gone', 'a deleted recording is a terminal no-op');
      } finally {
        for (const id of created) {
          const list = await storage.listObjects(`derived/${id}/`).catch(() => ({ objects: [] }));
          for (const o of list.objects) await storage.deleteObject(o.key).catch(() => {});
          await storage.deleteObject(`sources/${id}/source.webm`).catch(() => {});
        }
        await db.execute(sql`delete from users where id = ${U}`);
        await pool.end().catch(() => {});
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── D. Wiring ─────────────────────────────────────────────────────────────
  console.log('\nD. Wiring');
  const reg = W.createDefaultRegistry();
  ok(reg.has('thumbnail') && reg.get('thumbnail').queue === 'media' && reg.get('thumbnail').concurrency === null, 'thumbnail is registered on the media queue, not serialised');
  const keysPkg = require(path.join(ROOT, 'storage', 'src', 'keys.js')).keys;
  ok(keysPkg.image('rec_x', 'ast_y', 'preview_webp') === 'derived/rec_x/ast_y/preview.webp', 'the key contract gained the animated-WebP preview');
  const main = fs.readFileSync(path.join(ROOT, 'worker', 'src', 'main.js'), 'utf8');
  ok(/createThumbnailer\(/.test(main), 'main.js builds the thumbnailer');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
