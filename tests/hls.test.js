// T-705 HLS job (run: cd worker && npm run test:hls)
//
// A. pure: rendition selection, the per-rendition ffmpeg command, avc1 codec
//    strings, master playlist writing, playlist inspection; B. real ffmpeg: a
//    1440p source → 1080p/720p/480p fMP4 VOD renditions with init segments,
//    4 s segments, ENDLIST, a master listing every variant with
//    RESOLUTION/CODECS, decodable playlists, a small source → one rendition,
//    video-only → no audio, progress to 100, abort, a broken output fails
//    verification, no stray files outside the output directory; C. the `hls`
//    processor on PostgreSQL + MinIO + Redis: fan-out only for > 5 min or
//    > 1080p, one `hls` asset row whose key is the master playlist, every
//    file uploaded under the asset's hls/ prefix with the right content
//    types, the recording's `ready` state never depends on it, check-before-do
//    skip, forced re-run reuses the row, guards; D. wiring.
//
// SKIPS LOUDLY without infrastructure; HLS_TESTS_REQUIRED=1 makes that a failure.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const W = require(path.join(ROOT, 'worker', 'src', 'index.js'));
const H = require(path.join(ROOT, 'worker', 'src', 'media', 'hls.js'));
const IORedis = require(path.join(ROOT, 'worker', 'node_modules', 'ioredis'));
const { loadEnv, createPool, createClient, createRepositories, withTransaction: rawTx } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.HLS_TESTS_REQUIRED === '1';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6380';
const MINIO = process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100';
const RUN = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silent = W.silentLogger();
const REASON = 'T-705 hls test';
const within = (a, b, pct) => Math.abs(Number(a) - Number(b)) / Number(b) <= pct;

(async () => {
  console.log('T-705 HLS tests');

  // ── A. Pure ───────────────────────────────────────────────────────────────
  console.log('\nA. Pure');
  ok(H.renditionsFor(1440).map((r) => r.name).join() === '1080p,720p,480p' && H.renditionsFor(1080).map((r) => r.name).join() === '1080p,720p,480p', '≥ 1080p → three renditions');
  ok(H.renditionsFor(720).map((r) => r.name).join() === '720p,480p' && H.renditionsFor(600).map((r) => r.name).join() === '480p', 'never taller than the source');
  ok(H.renditionsFor(240).length === 1 && H.renditionsFor(240)[0].height === 240 && H.renditionsFor(240)[0].name === '240p', 'a small source gets one rendition at its own height');
  ok(H.RENDITIONS[0].videoKbps === 5000 && H.RENDITIONS[1].videoKbps === 2800 && H.RENDITIONS[2].videoKbps === 1200 && H.SEGMENT_SECONDS === 4 && H.AUDIO_KBPS === 128, 'docs/09 §5 bitrates, 4 s segments, aac 128k');
  const a = H.buildArgs('/in.mp4', '/out', H.RENDITIONS[1], { hasAudio: true, fps: 30 });
  ok(a.includes('-vf') && a[a.indexOf('-vf') + 1] === 'scale=-2:720:flags=bicubic' && a[a.indexOf('-b:v') + 1] === '2800k' && a[a.indexOf('-g') + 1] === '120' && a.includes('fmp4') && a[a.indexOf('-hls_time') + 1] === '4' && a[a.indexOf('-hls_playlist_type') + 1] === 'vod', 'per-rendition command: scale, bitrate, 4 s GOP, fMP4 VOD');
  ok(a[a.indexOf('-hls_fmp4_init_filename') + 1] === '720p_init.mp4' && a[a.indexOf('-hls_segment_filename') + 1] === '720p_seg_%05d.m4s' && a[a.length - 1] === '720p_index.m3u8', 'flat, relative output names (run with cwd = outDir)');
  const vo = H.buildArgs('/in.mp4', '/out', H.RENDITIONS[2], { hasAudio: false });
  ok(vo.includes('-an') && !vo.includes('aac'), 'video-only sources get no audio track');
  ok(H.avc1Codec('High', 41) === 'avc1.640029' && H.avc1Codec('Main', 31) === 'avc1.4d001f' && H.avc1Codec(null, null) === 'avc1.640029', 'avc1 codec strings from profile/level');
  {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 't705m-'));
    const text = H.writeMaster(d, [{ name: '720p', videoKbps: 2800, hasAudio: true, width: 1280, height: 720, fps: 30, codecVideo: 'avc1.640029' }, { name: '480p', videoKbps: 1200, hasAudio: false, width: 854, height: 480, fps: 30, codecVideo: 'avc1.640029' }]);
    ok(/#EXT-X-STREAM-INF:BANDWIDTH=3220800,AVERAGE-BANDWIDTH=2928000,RESOLUTION=1280x720,CODECS="avc1.640029,mp4a.40.2",FRAME-RATE=30\n720p_index.m3u8/.test(text) && /BANDWIDTH=1320000,[^\n]*CODECS="avc1.640029",FRAME-RATE=30\n480p_index.m3u8/.test(text), 'the master playlist carries bandwidth (+10 %), resolution, codecs (no audio codec for a silent variant)');
    fs.rmSync(d, { recursive: true, force: true });
  }

  const bins = W.resolveBinaries();
  let ffmpegOk = false;
  try { await W.runTool(bins.ffmpegBin, ['-version'], { timeout: 10000 }); await W.runTool(bins.ffprobeBin, ['-version'], { timeout: 10000 }); ffmpegOk = true; } catch {}
  if (!ffmpegOk) {
    console.log('\n  SKIPPED B–C — no ffmpeg/ffprobe');
    if (REQUIRED) { fail += 1; console.log('  FAIL: HLS_TESTS_REQUIRED=1 but ffmpeg is unavailable'); }
  } else {
    console.log('\nB. Real ffmpeg');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't705-'));
    const f = (n) => path.join(dir, n);
    const gen = (out, args) => W.runTool(bins.ffmpegBin, ['-hide_banner', '-nostdin', '-y', ...args, out], { timeout: 180000 });
    await gen(f('big.mp4'), ['-f', 'lavfi', '-i', 'testsrc=size=2560x1440:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '9', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
    await gen(f('small.webm'), ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-t', '5', '-c:v', 'libvpx', '-b:v', '200k', '-an']);
    const prober = W.createProber({ ffprobeBin: bins.ffprobeBin, ffmpegBin: bins.ffmpegBin, logger: silent });
    const pk = H.createHlsPackager({ ffmpegBin: bins.ffmpegBin, prober, logger: silent });
    const cwdBefore = fs.readdirSync(process.cwd()).length;
    const bf = await prober.probeFile(f('big.mp4'));
    const pcts = [];
    const r = await pk.packageHls(f('big.mp4'), f('out-big'), { sourceFacts: bf, onProgress: (p) => pcts.push(p) });
    ok(r.renditions.map((x) => x.name).join() === '1080p,720p,480p' && r.inspect.masterStreams === 3 && r.inspect.referenced.join() === '1080p_index.m3u8,720p_index.m3u8,480p_index.m3u8', '1440p → three renditions listed in the master');
    ok(r.inspect.variants.every((v) => v.endlist && v.init === `${v.name}_init.mp4` && v.segments.length === 3 && within(v.durationSec, 9, 0.02)) && fs.existsSync(f('out-big/1080p_init.mp4')), 'every variant is a finished VOD playlist: init segment, 3 × ~4 s fMP4 segments, duration within 2 %');
    ok(r.variants.find((v) => v.name === '1080p').width === 1920 && r.variants.find((v) => v.name === '480p').width === 854 && r.variants.every((v) => v.codecVideo === 'avc1.640029' && v.hasAudio), 'variant facts from the init segments: resolutions, High@4.1 codec string, audio present');
    ok(r.variants.every((v) => v.decodedSec != null && within(v.decodedSec, 9, 0.05)), 'each variant playlist decodes end to end (ffmpeg null decode) to the source duration');
    ok(/CODECS="avc1.640029,mp4a.40.2"/.test(r.master) && /RESOLUTION=1920x1080/.test(r.master) && /RESOLUTION=854x480/.test(r.master), 'the master carries codecs and resolutions');
    ok(r.files.length === 16 && r.files.every((x) => ['application/vnd.apple.mpegurl', 'video/mp4', 'video/iso.segment'].includes(x.contentType)) && r.bytes > 100000, '16 files (master + 3 × (playlist + init + 3 segments)) with content types');
    ok(r.files.every((x) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(x.name)), 'every file name satisfies the segment-key contract (no slashes)');
    ok(pcts.length >= 3 && pcts[pcts.length - 1] === 100 && pcts.every((p, i) => i === 0 || p >= pcts[i - 1]), 'progress spans the renditions monotonically to 100');
    ok(fs.readdirSync(process.cwd()).length === cwdBefore, 'no stray files in the process cwd (init segments land in the output directory)');
    const sf = await prober.probeFile(f('small.webm'));
    const rs = await pk.packageHls(f('small.webm'), f('out-small'), { sourceFacts: sf });
    ok(rs.renditions.length === 1 && rs.renditions[0].height === 240 && rs.hasAudio === false && !rs.variants[0].hasAudio && !/mp4a/.test(rs.master), 'a 240p video-only source → one silent 240p rendition');
    const ac = new AbortController();
    const p = pk.packageHls(f('big.mp4'), f('out-abort'), { sourceFacts: bf, signal: ac.signal }).then(() => null, (e) => e);
    setTimeout(() => ac.abort(), 200);
    const aborted = await p;
    ok(aborted && aborted.code === 'aborted', 'an abort signal kills ffmpeg mid-package');
    let threw = null; try { await pk.packageHls(f('big.mp4'), f('out-bad'), { sourceFacts: { ...bf, durationSec: 40 } }); } catch (e) { threw = e; }
    ok(threw && threw.code === 'output_invalid' && /duration/.test(threw.message), 'verification rejects output whose duration disagrees with the source facts');
    threw = null; try { H.createHlsPackager({ ffmpegBin: 'x' }); } catch (e) { threw = e; }
    ok(threw && /prober/.test(threw.message), 'a packager without a prober cannot exist');

    // ── C. Processor ────────────────────────────────────────────────────────
    let env = null, pgUp = false, redisUp = false, storageUp = false, pool = null;
    try { env = loadEnv({ appEnv: 'test' }); } catch (e) { console.log('  env:', e.message); }
    if (env) { pool = createPool({ env, max: 8 }); try { await pool.query('select 1'); pgUp = true; } catch {} }
    try { const c = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 1500, lazyConnect: true }); await c.connect(); redisUp = (await c.ping()) === 'PONG'; await c.quit(); } catch {}
    try { storageUp = (await fetch(`${MINIO}/minio/health/live`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
    if (!pgUp || !redisUp || !storageUp) {
      console.log(`\n  SKIPPED C — ${[!pgUp && 'PostgreSQL unreachable', !redisUp && `no Redis at ${REDIS_URL}`, !storageUp && `no object storage at ${MINIO}`].filter(Boolean).join(', ')}`);
      if (REQUIRED) { fail += 1; console.log('  FAIL: HLS_TESTS_REQUIRED=1 but infrastructure is unavailable'); }
    } else {
      console.log('\nC. Processor on real PostgreSQL + MinIO + Redis');
      const db = createClient(pool);
      const repositories = () => createRepositories(db);
      const repos = repositories();
      const withTransaction = (fn) => rawTx(fn, db);
      const storagePkg = require(path.join(ROOT, 'storage', 'src', 'index.js'));
      const storage = storagePkg.createStorageProvider({ appEnv: 'test' });
      const keys = storagePkg.keys;
      const U = `usr_t705_${RUN}`;
      await db.execute(sql`INSERT INTO users (id,email,name,password_hash) VALUES (${U}, ${`t705-${RUN}@example.com`}, 'T705', 'x')`);
      const rid = (k) => `rec_t705_${k}_${RUN}`;
      const created = [];
      const mkRec = async (k, file, ext) => {
        const bytes = fs.readFileSync(f(file));
        await db.execute(sql`INSERT INTO recordings (id,user_id,title,status,source_kind,privacy,size_bytes) VALUES (${rid(k)}, ${U}, ${k}, 'uploaded', 'extension', 'unlisted', ${bytes.length})`);
        const key = `sources/${rid(k)}/source.${ext}`;
        await storage.putObject(key, bytes, { contentType: ext === 'mp4' ? 'video/mp4' : 'video/webm' });
        await db.execute(sql`INSERT INTO video_assets (id,recording_id,kind,storage_key,status,size_bytes,counts_toward_quota) VALUES (${`ast_t705_${k}_${RUN}`}, ${rid(k)}, 'source', ${key}, 'ready', ${bytes.length}, true)`);
        created.push(rid(k));
        return rid(k);
      };
      const rec = (id) => repos.recordings.getSystem(id, REASON);
      const rowOf = (key) => repos.jobs.findByDedupeKey(key);
      const assetsOf = (id) => repos.assets.listByRecordingSystem(id, REASON);
      const until = async (fn, ms = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(200); } return false; };
      const registry = W.createRegistry();
      W.registerMediaProcessors(registry);
      const deps = { storage, withTransaction, prober, hlsPackager: pk, keys, transcoder: W.createTranscoder({ ffmpegBin: bins.ffmpegBin, prober, logger: silent }), thumbnailer: W.createThumbnailer({ ffmpegBin: bins.ffmpegBin, prober, logger: silent }), audioExtractor: W.createAudioExtractor({ ffmpegBin: bins.ffmpegBin, prober, logger: silent }), resolveLimits: async () => ({ planSlug: 'pro', maxRecordingDurationSeconds: 36000 }) };
      const direct = async (type, dedupe, recordingId, payload = {}) => {
        let job = await rowOf(dedupe);
        if (!job) job = (await repos.jobs.enqueue({ queue: type, dedupeKey: dedupe, recordingId, payload: { recordingId, ...payload } })).job;
        job = await repos.jobs.markActiveSystem(job.id, REASON);
        try {
          const result = await registry.get(type).handler({ payload: { ...job.payload, ...payload }, job, signal: new AbortController().signal, logger: silent, deps, repositories });
          await repos.jobs.markCompletedSystem(job.id, result, REASON);
          return { result, job };
        } catch (e) { await repos.jobs.markFailedSystem(job.id, e.message, REASON, { terminal: e.retryable === false }); throw e; }
      };

      try {
        // 1440p → the probe fans out an hls job; run it through the real worker app (hls-only registry).
        const A = await mkRec('a', 'big.mp4', 'mp4');
        await direct('probe', `probe:${A}`, A);
        ok(!!(await rowOf(`hls:${A}`)) && !(await rowOf(`hls:${await mkRec('s', 'small.webm', 'webm')}`)), 'the probe fans out hls only for > 1080p (or > 5 min) sources');
        const prefix = `t705${RUN}`;
        const q = W.createBullJobQueue({ redisUrl: REDIS_URL, prefix, logger: silent, stalledIntervalMs: 500, lockDurationMs: 1000 });
        const config = W.loadWorkerConfig({ REDIS_URL, QUEUE_PREFIX: prefix, OUTBOX_INTERVAL_MS: '100', RECONCILE_INTERVAL_MS: '600000', WORKER_SCHEDULER: 'false', WORKER_DEFER_MS: '100' }, { appEnv: 'test' });
        const hlsOnly = W.createRegistry(); hlsOnly.register('hls', registry.get('hls').handler);
        const app = W.createWorkerApp({ config, logger: silent, repositories, jobQueue: q, registry: hlsOnly, deps });
        await app.start();
        ok(await until(async () => (await rowOf(`hls:${A}`)).status === 'completed', 240000), 'the hls job completes through the real pipeline');
        const hlsA = (await assetsOf(A)).find((x) => x.kind === 'hls');
        ok(hlsA && hlsA.status === 'ready' && hlsA.storageKey === keys.hlsMaster(A, hlsA.id) && hlsA.container === 'hls' && hlsA.width === 1920 && hlsA.height === 1080 && hlsA.codecVideo === 'h264' && hlsA.codecAudio === 'aac' && hlsA.countsTowardQuota === false && Number(hlsA.sizeBytes) > 100000, 'one hls asset row: key = master playlist, facts of the top rendition, not billed');
        const listed = await storage.listObjects(`derived/${A}/${hlsA.id}/hls/`);
        const names = listed.objects.map((o) => o.key.split('/').pop()).sort();
        ok(names.length === 16 && names.includes('master.m3u8') && names.includes('1080p_init.mp4') && names.includes('480p_seg_00002.m4s'), 'all 16 files live under the asset\'s hls/ prefix');
        const masterHead = await storage.headObject(hlsA.storageKey), segHead = await storage.headObject(keys.hlsSegment(A, hlsA.id, '720p_seg_00000.m4s')), initHead = await storage.headObject(keys.hlsSegment(A, hlsA.id, '720p_init.mp4'));
        ok(masterHead.contentType === 'application/vnd.apple.mpegurl' && segHead.contentType === 'video/iso.segment' && initHead.contentType === 'video/mp4', 'playlists / init / segments carry their content types');
        const jA = await rowOf(`hls:${A}`);
        ok(jA.result.progress === 100 && jA.result.renditions.length === 3 && jA.result.files === 16, 'the job result records renditions, files and progress');
        ok((await rec(A)).status === 'processing', 'HLS never gates ready: the recording stays processing without an MP4 + poster');
        await app.stop();
        const qq = W.createBullJobQueue({ redisUrl: REDIS_URL, prefix, logger: silent }); await qq.obliterate(); await qq.close();
        // Check-before-do + forced re-run.
        const skip = await direct('hls', `hls:${A}`, A);
        ok(skip.result.skipped === 'already_ready' && skip.result.assetId === hlsA.id, 'a ready HLS asset with its master in storage is skipped');
        const forced = await direct('hls', `hls:${A}`, A, { force: true });
        ok(!forced.result.skipped && forced.result.assetId === hlsA.id && (await assetsOf(A)).filter((x) => x.kind === 'hls').length === 1, 'a forced re-run repackages into the same asset row');
        // Still never gates ready even after the rest lands.
        await direct('transcode', `transcode:${A}:mp4`, A);
        await direct('thumbnail', `thumb:${A}`, A);
        ok((await rec(A)).status === 'ready', 'MP4 + poster promote the recording (HLS was an enhancement on top)');
        // Guards.
        const D = await mkRec('d', 'small.webm', 'webm');
        let threw2 = null; try { await direct('hls', `hls:${D}`, D); } catch (e) { threw2 = e; }
        ok(threw2 && threw2.code === 'probe_required', 'hls before probe → probe_required');
        await direct('probe', `probe:${D}`, D);
        await repos.recordings.updateSystem(D, { status: 'rejected_limit', failureCode: 'recording_limit' }, REASON);
        threw2 = null; try { await direct('hls', `hls:${D}`, D); } catch (e) { threw2 = e; }
        ok(threw2 && threw2.code === 'recording_not_processable', 'a rejected recording is not packaged');
      } finally {
        for (const id of created) {
          for (const p of [`derived/${id}/`, `audio/${id}/`, `sources/${id}/`]) { const list = await storage.listObjects(p).catch(() => ({ objects: [] })); for (const o of list.objects) await storage.deleteObject(o.key).catch(() => {}); }
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
  ok(reg.has('hls') && reg.get('hls').queue === 'media' && reg.get('hls').concurrency === 1 && reg.get('hls').timeoutMs === 60 * 60 * 1000, 'hls is registered on the media queue, serialised per process, with the long timeout');
  const main = fs.readFileSync(path.join(ROOT, 'worker', 'src', 'main.js'), 'utf8');
  ok(/createHlsPackager\(/.test(main), 'main.js builds the HLS packager');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
