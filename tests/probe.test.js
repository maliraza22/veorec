// T-701 probe job (run: cd worker && npm run test:probe)
//
// A. validation rules (pure); B. the fixture battery of docs/20 §8 generated
// with real ffmpeg (ffmpeg-static): 5 s webm vp9/opus, webm WITHOUT a
// duration header (MediaRecorder-style, `-live 1`), video-only webm, mp4
// h264/aac, 1440p, tiny dimensions, unsupported container, corrupt, 0-byte —
// facts and verdicts; C. the processor end-to-end on real PostgreSQL + MinIO
// + Redis: facts written in one transaction, uploaded → processing, fan-out
// rows by dedupe key (HLS only when earned), idempotent re-probe, corrupt →
// failed(probe_invalid) with the job in the dead-letter set, size mismatch,
// missing object, post-probe entitlement → rejected_limit (+30 s grace),
// deleted recording; D. registry/wiring.
//
// SKIPS LOUDLY without infrastructure; PROBE_TESTS_REQUIRED=1 makes that a failure.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const W = require(path.join(ROOT, 'worker', 'src', 'index.js'));
const IORedis = require(path.join(ROOT, 'worker', 'node_modules', 'ioredis'));
const { loadEnv, createPool, createClient, createRepositories, withTransaction: rawTx } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.PROBE_TESTS_REQUIRED === '1';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6380';
const MINIO = process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100';
const RUN = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silent = W.silentLogger();
const REASON = 'T-701 probe test';
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= tol;

(async () => {
  console.log('T-701 probe job tests');

  // ── A. Validation rules ───────────────────────────────────────────────────
  console.log('\nA. Validation rules (pure)');
  const v = W.createProber({ ffprobeBin: 'x', ffmpegBin: 'x' }).validate;
  const good = { unreadable: false, container: 'webm', formatNames: ['matroska', 'webm'], video: { codec: 'vp9', width: 1280, height: 720 }, audio: { codec: 'opus' }, durationSec: 5, sizeBytes: 1000 };
  ok(v(good).ok === true, 'a sane vp9/opus webm validates');
  ok(v({ ...good, audio: null }).ok === true, 'video-only is valid');
  ok(v({ ...good, audio: { codec: 'pcm_s16le' } }).ok === true, 'pcm_* audio is accepted');
  ok(v({ ...good, container: 'avi' }).code === 'container_unsupported', 'avi is refused');
  ok(v({ ...good, video: null }).code === 'no_video_stream', 'no video stream is refused');
  ok(v({ ...good, video: { ...good.video, codec: 'mjpeg' } }).code === 'video_codec_unsupported', 'mjpeg video is refused');
  ok(v({ ...good, audio: { codec: 'flac' } }).code === 'audio_codec_unsupported', 'flac audio is refused');
  ok(v({ ...good, durationSec: 0.4 }).code === 'duration_invalid' && v({ ...good, durationSec: null }).code === 'duration_invalid', 'duration must be > 0.5 s and known');
  ok(v({ ...good, video: { ...good.video, width: 8 } }).code === 'dimensions_invalid' && v({ ...good, video: { ...good.video, height: 9000 } }).code === 'dimensions_invalid', 'dimensions must be 16..7680');
  ok(v(good, { expectedSize: 1000 }).ok && v(good, { expectedSize: 999 }).code === 'size_mismatch' && v(good, { expectedSize: null }).ok, 'the stored size must match the upload record when one exists');
  ok(v({ unreadable: true, error: 'x' }).code === 'unreadable' && v(null).code === 'unreadable', 'unreadable input is reported as such');
  ok(W.containerOf('matroska,webm') === 'webm' && W.containerOf('mov,mp4,m4a,3gp,3g2,mj2') === 'mp4' && W.containerOf('avi') === 'avi' && W.containerOf('') === null, 'ffprobe format_name lists map to one container');
  ok(W.parseDecodedDuration('frame=1 time=00:00:01.50 x\nframe=2 time=00:01:02.25 bitrate=...') === 62.25 && W.parseDecodedDuration('') === null, 'the last time= of a null decode is the duration');
  ok(W.DURATION_GRACE_SEC === 30 && W.HLS_MIN_DURATION_SEC === 300, 'docs/16 §3 grace and docs/09 §5 HLS threshold');

  // ── B. Fixture battery with real ffmpeg ───────────────────────────────────
  const bins = W.resolveBinaries();
  let ffmpegOk = false;
  try { await W.runTool(bins.ffmpegBin, ['-version'], { timeout: 10000 }); await W.runTool(bins.ffprobeBin, ['-version'], { timeout: 10000 }); ffmpegOk = true; } catch {}
  if (!ffmpegOk) {
    console.log('\n  SKIPPED B–C — no ffmpeg/ffprobe (install worker devDependencies or set FFMPEG_BIN/FFPROBE_BIN)');
    if (REQUIRED) { fail += 1; console.log('  FAIL: PROBE_TESTS_REQUIRED=1 but ffmpeg is unavailable'); }
  } else {
    console.log('\nB. Fixture battery (docs/20 §8) with real ffmpeg');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't701-'));
    const f = (n) => path.join(dir, n);
    const gen = (out, args) => W.runTool(bins.ffmpegBin, ['-hide_banner', '-nostdin', '-y', ...args, out], { timeout: 120000 });
    const SRC = ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440'];
    await gen(f('vp9.webm'), [...SRC, '-t', '5', '-c:v', 'libvpx-vp9', '-b:v', '200k', '-c:a', 'libopus']);
    await gen(f('live.webm'), [...SRC, '-t', '3', '-c:v', 'libvpx-vp9', '-b:v', '200k', '-c:a', 'libopus', '-live', '1']);
    await gen(f('vo.webm'), ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-t', '2', '-c:v', 'libvpx', '-b:v', '200k', '-an']);
    await gen(f('h264.mp4'), [...SRC, '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart']);
    await gen(f('big.mp4'), ['-f', 'lavfi', '-i', 'testsrc=size=2560x1440:rate=30', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an']);
    await gen(f('tiny.webm'), ['-f', 'lavfi', '-i', 'testsrc=size=8x8:rate=30', '-t', '1', '-c:v', 'libvpx', '-an']);
    await gen(f('mjpeg.avi'), ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-t', '1', '-c:v', 'mjpeg', '-q:v', '5', '-an']);
    await gen(f('long.webm'), ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-t', '35', '-c:v', 'libvpx', '-b:v', '60k', '-an']);
    fs.writeFileSync(f('corrupt.webm'), 'this is definitely not a video file, just text');
    fs.writeFileSync(f('empty.webm'), '');
    const prober = W.createProber({ ffprobeBin: bins.ffprobeBin, ffmpegBin: bins.ffmpegBin, logger: silent });
    const P = async (n) => { const facts = await prober.probeFile(f(n)); return { facts, verdict: prober.validate(facts) }; };

    let r = await P('vp9.webm');
    ok(r.verdict.ok && r.facts.container === 'webm' && r.facts.video.codec === 'vp9' && r.facts.audio.codec === 'opus' && near(r.facts.durationSec, 5, 0.2) && r.facts.video.width === 320 && r.facts.video.height === 240 && r.facts.durationSource === 'format' && r.facts.sizeBytes === fs.statSync(f('vp9.webm')).size, '5 s vp9/opus webm: facts from the container');
    r = await P('live.webm');
    ok(r.verdict.ok && r.facts.durationSource === 'decoded' && near(r.facts.durationSec, 3, 0.3), 'a webm WITHOUT a duration header (MediaRecorder-style) is decoded to the end for its duration');
    r = await P('vo.webm');
    ok(r.verdict.ok && r.facts.audio === null && r.facts.video.codec === 'vp8', 'video-only webm is valid (no synthesized audio)');
    r = await P('h264.mp4');
    ok(r.verdict.ok && r.facts.container === 'mp4' && r.facts.video.codec === 'h264' && r.facts.audio.codec === 'aac' && near(r.facts.video.fps, 30, 0.01), 'mp4 h264/aac upload validates with fps');
    r = await P('big.mp4');
    ok(r.verdict.ok && r.facts.video.width === 2560 && r.facts.video.height === 1440, '1440p source: facts (HLS candidate)');
    r = await P('tiny.webm');
    ok(!r.verdict.ok && r.verdict.code === 'dimensions_invalid', '8x8 → dimensions_invalid');
    r = await P('mjpeg.avi');
    ok(!r.verdict.ok && r.verdict.code === 'container_unsupported', 'avi/mjpeg → container_unsupported');
    r = await P('corrupt.webm');
    ok(!r.verdict.ok && r.verdict.code === 'unreadable' && r.facts.unreadable === true, 'corrupt bytes → unreadable');
    r = await P('empty.webm');
    ok(!r.verdict.ok && r.verdict.code === 'unreadable', '0-byte file → unreadable');
    const ac = new AbortController(); ac.abort();
    let threw = null; try { await prober.probeFile(f('vp9.webm'), { signal: ac.signal }); } catch (e) { threw = e; }
    ok(threw && threw.code === 'aborted', 'an aborted signal stops the probe');
    threw = null; try { await W.createProber({ ffprobeBin: f('nope.exe'), ffmpegBin: bins.ffmpegBin }).probeFile(f('vp9.webm')); } catch (e) { threw = e; }
    ok(threw && threw.code === 'ENOENT', 'a missing ffprobe surfaces as ENOENT (transient in the job)');

    // ── C. Processor end-to-end ─────────────────────────────────────────────
    let env = null, pgUp = false, redisUp = false, storageUp = false, pool = null;
    try { env = loadEnv({ appEnv: 'test' }); } catch (e) { console.log('  env:', e.message); }
    if (env) { pool = createPool({ env, max: 8 }); try { await pool.query('select 1'); pgUp = true; } catch {} }
    try { const c = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 1500, lazyConnect: true }); await c.connect(); redisUp = (await c.ping()) === 'PONG'; await c.quit(); } catch {}
    try { storageUp = (await fetch(`${MINIO}/minio/health/live`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
    if (!pgUp || !redisUp || !storageUp) {
      console.log(`\n  SKIPPED C — ${[!pgUp && 'PostgreSQL unreachable', !redisUp && `no Redis at ${REDIS_URL}`, !storageUp && `no object storage at ${MINIO}`].filter(Boolean).join(', ')}`);
      if (REQUIRED) { fail += 1; console.log('  FAIL: PROBE_TESTS_REQUIRED=1 but infrastructure is unavailable'); }
    } else {
      console.log('\nC. Processor on real PostgreSQL + MinIO + Redis');
      const db = createClient(pool);
      const repositories = () => createRepositories(db);
      const repos = repositories();
      const withTransaction = (fn) => rawTx(fn, db);
      const storage = require(path.join(ROOT, 'storage', 'src', 'index.js')).createStorageProvider({ appEnv: 'test' });
      const U = `usr_t701_${RUN}`;
      await db.execute(sql`INSERT INTO users (id,email,name,password_hash) VALUES (${U}, ${`t701-${RUN}@example.com`}, 'T701', 'x')`);
      const rid = (k) => `rec_t701_${k}_${RUN}`;
      const mkRec = async (k, file, { status = 'uploaded', sizeBytes = 'real', withSource = true, withObject = true } = {}) => {
        const bytes = fs.readFileSync(f(file));
        const size = sizeBytes === 'real' ? bytes.length : sizeBytes;
        await db.execute(sql`INSERT INTO recordings (id,user_id,title,status,source_kind,privacy,size_bytes) VALUES (${rid(k)}, ${U}, ${k}, ${status}, 'extension', 'unlisted', ${size})`);
        const key = `sources/${rid(k)}/source.${path.extname(file).slice(1)}`;
        if (withObject) await storage.putObject(key, bytes, { contentType: 'video/webm' });
        if (withSource) await db.execute(sql`INSERT INTO video_assets (id,recording_id,kind,storage_key,status,size_bytes,counts_toward_quota) VALUES (${`ast_t701_${k}_${RUN}`}, ${rid(k)}, 'source', ${key}, 'ready', ${size}, true)`);
        return rid(k);
      };
      const rec = (id) => repos.recordings.getSystem(id, REASON);
      const rowOf = (key) => repos.jobs.findByDedupeKey(key);
      const jobsOf = (id) => repos.jobs.listByRecordingSystem(id, REASON);
      const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };
      const limitsFree = async () => ({ planSlug: 'free', maxRecordingDurationSeconds: 600 });
      const registry = W.createRegistry();
      W.registerMediaProcessors(registry);
      const handler = registry.get('probe').handler;
      const deps = { storage, withTransaction, prober, resolveLimits: limitsFree };
      const runProbe = async (recordingId, extra = {}) => {
        const { job } = await repos.jobs.enqueue({ queue: 'probe', dedupeKey: `probe:${recordingId}`, recordingId, payload: { storageKey: `sources/${recordingId}/source.webm` } });
        return handler({ payload: job.payload, job, signal: new AbortController().signal, logger: silent, deps: { ...deps, ...extra }, repositories });
      };
      const enqueueProbe = (recordingId) => repos.jobs.enqueue({ queue: 'probe', dedupeKey: `probe:${recordingId}`, recordingId, payload: { storageKey: `sources/${recordingId}/source.webm` } }).then((r) => r.job);

      try {
        // Happy path through the REAL worker app (relay → runner → processor).
        const A = await mkRec('a', 'vp9.webm');
        const prefix = `t701${RUN}`;
        const q = W.createBullJobQueue({ redisUrl: REDIS_URL, prefix, logger: silent, stalledIntervalMs: 500, lockDurationMs: 1000 });
        const config = W.loadWorkerConfig({ REDIS_URL, QUEUE_PREFIX: prefix, OUTBOX_INTERVAL_MS: '100', RECONCILE_INTERVAL_MS: '600000', WORKER_SCHEDULER: 'false', WORKER_DEFER_MS: '100' }, { appEnv: 'test' });
        // A probe-ONLY worker: proves the fan-out rows wait in the transport for
        // workers that carry the other processors (deferred, not consumed).
        const probeOnly = W.createRegistry();
        probeOnly.register('probe', registry.get('probe').handler);
        const app = W.createWorkerApp({ config, logger: silent, repositories, jobQueue: q, registry: probeOnly, deps });
        await app.start();
        ok(app.status().queues.join() === 'media', 'a media-only worker subscribes to the media queue');
        await enqueueProbe(A);
        ok(await until(async () => (await rowOf(`probe:${A}`)).status === 'completed'), 'probe job completes through the real pipeline');
        const rA = await rec(A);
        ok(rA.status === 'processing' && near(rA.duration, 5, 0.2) && rA.width === 320 && rA.height === 240 && Number(rA.sizeBytes) === fs.statSync(f('vp9.webm')).size, 'uploaded → processing with FFprobed duration/dimensions/size');
        const assetA = (await repos.assets.listByRecordingSystem(A, REASON)).find((a) => a.kind === 'source');
        ok(assetA.status === 'ready' && assetA.codecVideo === 'vp9' && assetA.codecAudio === 'opus' && assetA.container === 'webm' && near(assetA.duration, 5, 0.2) && assetA.width === 320, 'the source asset carries codec/container/duration/dimension facts');
        const fan = (await jobsOf(A)).filter((j) => j.queue !== 'probe').map((j) => `${j.queue}:${j.status}`).sort();
        ok(fan.join() === 'audio_extract:queued,thumbnail:queued,transcode:queued', 'fan-out rows: transcode + thumbnail + audio_extract, all queued (no HLS for a 5 s 240p clip)');
        const res = (await rowOf(`probe:${A}`)).result;
        ok(res.valid === true && res.fanout.length === 3 && res.videoCodec === 'vp9' && res.durationSource === 'format' && res.hls === false, 'the job result summarises the facts and the fan-out');
        // The derived rows are in the transport, waiting for T-702+ workers (deferred by this media-only worker, never failed).
        await sleep(400);
        ok((await rowOf(`audio:${A}`)).status === 'queued' && (await rowOf(`audio:${A}`)).attempts === 0, 'a media-queue job this worker cannot run yet (audio_extract, T-704) is deferred, not consumed (no attempt burnt)');
        await app.stop();
        const qq = W.createBullJobQueue({ redisUrl: REDIS_URL, prefix, logger: silent }); await qq.obliterate(); await qq.close();

        // Idempotent re-probe: same facts, same rows, derived jobs requeued.
        await repos.jobs.markActiveSystem((await rowOf(`thumb:${A}`)).id, REASON); await repos.jobs.markCompletedSystem((await rowOf(`thumb:${A}`)).id, {}, REASON);
        const r2 = await runProbe(A);
        const jobsA2 = await jobsOf(A);
        ok(r2.valid && jobsA2.filter((j) => j.queue === 'thumbnail').length === 1 && (await rowOf(`thumb:${A}`)).status === 'queued' && (await rowOf(`thumb:${A}`)).attempts === 0, 're-probe is idempotent: one row per derived job; a settled derived job is requeued for the new facts');
        ok((await rec(A)).status === 'processing' && near((await rec(A)).duration, 5, 0.2), 'facts unchanged on re-probe');

        // HLS when earned.
        const B = await mkRec('b', 'big.mp4');
        const rB = await runProbe(B);
        ok(rB.hls === true && (await rowOf(`hls:${B}`)) && (await rec(B)).width === 2560, 'a > 1080p source fans out an HLS job too');

        // Video-only + mp4 + no-duration webm all land facts.
        const Cn = await mkRec('c', 'live.webm');
        const rC = await runProbe(Cn);
        ok(rC.valid && rC.durationSource === 'decoded' && near((await rec(Cn)).duration, 3, 0.3), 'a duration-less webm is probed via the decode path and the facts land');

        // Corrupt → failed(probe_invalid), job terminal (dead-letter), no fan-out.
        const D = await mkRec('d', 'corrupt.webm');
        let threw2 = null; try { await runProbe(D); } catch (e) { threw2 = e; }
        const rD = await rec(D);
        ok(threw2 && threw2.code === 'probe_invalid' && threw2.retryable === false, 'corrupt source → terminal probe_invalid');
        ok(rD.status === 'failed' && rD.failureCode === 'probe_invalid' && (await jobsOf(D)).length === 1, 'recording failed(probe_invalid); nothing fanned out');
        const dJobId = (await rowOf(`probe:${D}`)).id;
        ok(fs.readdirSync(path.join(os.tmpdir(), 'veorec-scratch')).every((n) => !n.includes(dJobId)), 'scratch cleaned up');

        // Size mismatch → probe_invalid (the object is not what the upload recorded).
        const E = await mkRec('e', 'vp9.webm', { sizeBytes: 12345 });
        threw2 = null; try { await runProbe(E); } catch (e) { threw2 = e; }
        ok(threw2 && threw2.code === 'probe_invalid' && /size_mismatch/.test(threw2.message) && (await rec(E)).status === 'failed', 'a stored size different from the upload record fails the probe');

        // Missing object → probe_invalid; no source row → probe_invalid.
        const F = await mkRec('f', 'vp9.webm', { withObject: false });
        threw2 = null; try { await runProbe(F); } catch (e) { threw2 = e; }
        ok(threw2 && /source_missing/.test(threw2.message) && (await rec(F)).failureCode === 'probe_invalid', 'a missing object fails the probe');
        const G = await mkRec('g', 'vp9.webm', { withSource: false });
        threw2 = null; try { await runProbe(G); } catch (e) { threw2 = e; }
        ok(threw2 && /no_source/.test(threw2.message), 'no source asset row → probe_invalid');

        // Post-probe entitlement: 35 s clip, limit 1 s (+30 s grace) → rejected; pro → ok.
        const H = await mkRec('h', 'long.webm');
        const rH = await runProbe(H, { resolveLimits: async () => ({ planSlug: 'free', maxRecordingDurationSeconds: 1 }) });
        const recH = await rec(H);
        ok(rH.rejected === 'recording_limit' && rH.fanout.length === 0 && recH.status === 'rejected_limit' && recH.failureCode === 'recording_limit' && near(recH.duration, 35, 0.5), 'over the plan duration (+30 s grace) → rejected_limit, facts kept, no fan-out');
        ok((await jobsOf(H)).length === 1, 'nothing derived for a rejected recording');
        const H2 = await mkRec('h2', 'long.webm');
        const rH2 = await runProbe(H2, { resolveLimits: async () => ({ planSlug: 'free', maxRecordingDurationSeconds: 5 }) });
        ok(rH2.rejected === null && (await rec(H2)).status === 'processing', 'within limit + grace (35 s ≤ 5 + 30) → processing');
        // Upgrade rescues: re-probe the rejected one with a pro limit.
        const rH3 = await runProbe(H, { resolveLimits: async () => ({ planSlug: 'pro', maxRecordingDurationSeconds: 36000 }) });
        ok(rH3.rejected === null && (await rec(H)).status === 'processing' && (await rec(H)).failureCode === null && rH3.fanout.length === 3, 'reprocess after an upgrade clears rejected_limit and fans out');
        const rNoLimits = await runProbe(H2, { resolveLimits: null });
        ok(rNoLimits.valid && rNoLimits.rejected === null, 'without a plan resolver the probe still records facts (no entitlement decision)');

        // Deleted recording.
        const I = await mkRec('i', 'vp9.webm');
        await db.execute(sql`update recordings set deleted_at = now() where id = ${I}`);
        threw2 = null; try { await runProbe(I); } catch (e) { threw2 = e; }
        ok(threw2 && threw2.code === 'recording_gone' && threw2.retryable === false, 'a deleted recording is a terminal no-op');
        // Ready recordings stay ready on re-probe.
        const J = await mkRec('j', 'vp9.webm', { status: 'ready' });
        await runProbe(J);
        ok((await rec(J)).status === 'ready', 'a re-probe never demotes a ready recording');
      } finally {
        for (const k of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'h2', 'i', 'j']) { await storage.deleteObject(`sources/${rid(k)}/source.webm`).catch(() => {}); await storage.deleteObject(`sources/${rid(k)}/source.mp4`).catch(() => {}); }
        await db.execute(sql`delete from users where id = ${U}`);
        await pool.end().catch(() => {});
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── D. Wiring ─────────────────────────────────────────────────────────────
  console.log('\nD. Wiring');
  const reg = W.createDefaultRegistry();
  ok(reg.has('probe') && reg.get('probe').queue === 'media' && reg.get('probe').timeoutMs === 5 * 60 * 1000, 'the shipped registry runs probe on the media queue with the 5-minute timeout');
  ok(reg.has('transcode') && reg.has('thumbnail') && reg.has('audio_extract') && reg.has('hls') && reg.has('render') && reg.has('silence_detect'), 'every media processor of Phase 7 is registered, and the Phase 12 editing processors alongside');
  const main = fs.readFileSync(path.join(ROOT, 'worker', 'src', 'main.js'), 'utf8');
  ok(/createProber\(/.test(main) && /resolveBinaries\(/.test(main), 'main.js builds the prober from the resolved binaries');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
