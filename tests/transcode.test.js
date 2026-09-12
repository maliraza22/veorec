// T-702 transcode MP4 + maybe_mark_ready (run: cd worker && npm run test:transcode)
//
// A. pure: the docs/09 §3 command, progress parsing, the faststart box scan;
// B. real ffmpeg: vp9/opus → h264/aac faststart within 2 %; 1440p capped to
//    1080p; video-only stays video-only; a VFR (dropped-frame) source keeps
//    A/V duration; progress reaches 100; abort kills ffmpeg; verification
//    rejects a bad output; C. the processor end-to-end on PostgreSQL + MinIO +
//    Redis through the real worker app: probe → transcode publishes the MP4
//    asset (asset-id-scoped key, facts, progress on the job row), promotion
//    waits for the poster, promotes once the poster is ready, promotes with a
//    placeholder when the thumbnail job failed terminally, check-before-do
//    skip, idempotent forced re-run (same asset row, object overwritten),
//    per-type concurrency (two transcodes never overlap), attempts exhausted →
//    failed(transcode_failed) with the source kept, and maybe_mark_ready's
//    guards (rejected/failed/deleted never promote; lock required).
//
// SKIPS LOUDLY without infrastructure; TRANSCODE_TESTS_REQUIRED=1 makes that a failure.
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
const REQUIRED = process.env.TRANSCODE_TESTS_REQUIRED === '1';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6380';
const MINIO = process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100';
const RUN = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silent = W.silentLogger();
const REASON = 'T-702 transcode test';
const within = (a, b, pct) => Math.abs(Number(a) - Number(b)) / Number(b) <= pct;

(async () => {
  console.log('T-702 transcode + maybe_mark_ready tests');

  // ── A. Pure ───────────────────────────────────────────────────────────────
  console.log('\nA. Pure');
  const args = W.buildTranscodeArgs('in.webm', 'out.mp4', { hasAudio: true });
  ok(args.includes('libx264') && args.includes('veryfast') && args[args.indexOf('-crf') + 1] === '23' && args.includes('high') && args[args.indexOf('-level') + 1] === '4.1' && args.includes('+faststart') && args[args.indexOf('-r') + 1] === '30' && args.includes('yuv420p'), 'the docs/09 §3 encoder settings');
  ok(args[args.indexOf('-vf') + 1].includes("min(1920,iw)") && args[args.indexOf('-vf') + 1].includes('force_divisible_by=2'), 'scale caps at 1080p with even dimensions');
  ok(args.includes('aac') && args[args.indexOf('-b:a') + 1] === '128k' && args[args.indexOf('-ar') + 1] === '48000', 'aac 128k 48 kHz stereo');
  const vo = W.buildTranscodeArgs('in.webm', 'out.mp4', { hasAudio: false });
  ok(vo.includes('-an') && !vo.includes('aac'), 'a video-only source gets a video-only MP4 (no silence synthesised)');
  ok(args.includes('-progress') && args[args.indexOf('-progress') + 1] === 'pipe:1', 'progress is streamed on stdout');
  const st = W.parseProgress('frame=10\nout_time_us=1500000\nprogress=continue\n');
  ok(st.outTimeSec === 1.5 && st.ended === false, 'out_time_us parses to seconds');
  const st2 = W.parseProgress('out_time=00:00:02.500000\nprogress=end\n', st);
  ok(st2.outTimeSec === 2.5 && st2.ended === true, 'out_time HH:MM:SS parses; progress=end is detected');

  const bins = W.resolveBinaries();
  let ffmpegOk = false;
  try { await W.runTool(bins.ffmpegBin, ['-version'], { timeout: 10000 }); await W.runTool(bins.ffprobeBin, ['-version'], { timeout: 10000 }); ffmpegOk = true; } catch {}
  if (!ffmpegOk) {
    console.log('\n  SKIPPED B–C — no ffmpeg/ffprobe');
    if (REQUIRED) { fail += 1; console.log('  FAIL: TRANSCODE_TESTS_REQUIRED=1 but ffmpeg is unavailable'); }
  } else {
    console.log('\nB. Real ffmpeg');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't702-'));
    const f = (n) => path.join(dir, n);
    const gen = (out, a) => W.runTool(bins.ffmpegBin, ['-hide_banner', '-nostdin', '-y', ...a, out], { timeout: 120000 });
    const SRC = ['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440'];
    await gen(f('src.webm'), [...SRC, '-t', '4', '-c:v', 'libvpx-vp9', '-b:v', '300k', '-c:a', 'libopus']);
    await gen(f('big.mp4'), ['-f', 'lavfi', '-i', 'testsrc=size=2560x1440:rate=30', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an']);
    await gen(f('vo.webm'), ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-t', '2', '-c:v', 'libvpx', '-b:v', '200k', '-an']);
    // VFR: drop 2 of every 3 frames with variable timestamps (MediaRecorder-like), keep the audio.
    await gen(f('vfr.webm'), [...SRC, '-t', '4', '-vf', "select='not(mod(n,3))'", '-vsync', 'vfr', '-c:v', 'libvpx', '-b:v', '200k', '-c:a', 'libopus']);
    await gen(f('nofast.mp4'), [...SRC, '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
    const prober = W.createProber({ ffprobeBin: bins.ffprobeBin, ffmpegBin: bins.ffmpegBin, logger: silent });
    const tc = W.createTranscoder({ ffmpegBin: bins.ffmpegBin, prober, logger: silent });

    ok(W.hasFaststart(f('nofast.mp4')) === false, 'an mp4 written without +faststart has mdat before moov');
    const sf = await prober.probeFile(f('src.webm'));
    const pcts = [];
    const r = await tc.transcodeToMp4(f('src.webm'), f('out.mp4'), { sourceFacts: sf, onProgress: (p) => pcts.push(p) });
    ok(r.verified && r.facts.video.codec === 'h264' && r.facts.audio.codec === 'aac' && r.facts.container === 'mp4', 'vp9/opus → h264/aac mp4');
    ok(within(r.facts.durationSec, sf.durationSec, 0.02) && r.facts.video.width === 640 && r.facts.video.height === 360 && r.facts.video.fps === 30, 'duration within 2 %, dimensions kept, 30 fps');
    ok(W.hasFaststart(f('out.mp4')), 'moov precedes mdat (+faststart) — instant seek');
    ok(pcts.length >= 1 && pcts[pcts.length - 1] === 100 && pcts.every((p, i) => i === 0 || p >= pcts[i - 1]), 'progress callbacks are monotonic and end at 100');
    const bf = await prober.probeFile(f('big.mp4'));
    const rb = await tc.transcodeToMp4(f('big.mp4'), f('big-out.mp4'), { sourceFacts: bf });
    ok(rb.facts.video.width === 1920 && rb.facts.video.height === 1080 && !rb.facts.audio, '1440p is capped to 1080p; video-only stays video-only');
    const vf = await prober.probeFile(f('vo.webm'));
    const rv = await tc.transcodeToMp4(f('vo.webm'), f('vo-out.mp4'), { sourceFacts: vf });
    ok(rv.hasAudio === false && !rv.facts.audio && rv.facts.video.codec === 'h264', 'video-only webm → video-only mp4 (no synthesized silence)');
    const vfrF = await prober.probeFile(f('vfr.webm'));
    const rvfr = await tc.transcodeToMp4(f('vfr.webm'), f('vfr-out.mp4'), { sourceFacts: vfrF });
    ok(rvfr.facts.audio && within(rvfr.facts.durationSec, vfrF.durationSec, 0.02) && rvfr.facts.video.fps === 30, 'a VFR (dropped-frame) source is normalised to 30 fps with A/V duration preserved (sync check)');
    const ac = new AbortController();
    const p = tc.transcodeToMp4(f('src.webm'), f('abort.mp4'), { sourceFacts: sf, signal: ac.signal }).then(() => null, (e) => e);
    setTimeout(() => ac.abort(), 60);
    const aborted = await p;
    ok(aborted && aborted.code === 'aborted', 'an abort signal kills ffmpeg');
    let threw = null; try { await tc.transcodeToMp4(f('src.webm'), f('bad.mp4'), { sourceFacts: { ...sf, durationSec: 40 } }); } catch (e) { threw = e; }
    ok(threw && threw.code === 'output_invalid' && /duration/.test(threw.message), 'verification rejects an output whose duration is not within 2 % of the source facts');
    threw = null; try { await W.createTranscoder({ ffmpegBin: f('nope.exe'), prober }).transcodeToMp4(f('src.webm'), f('x.mp4'), { sourceFacts: sf }); } catch (e) { threw = e; }
    ok(threw && threw.code === 'ENOENT', 'a missing ffmpeg surfaces as ENOENT (transient in the job)');
    threw = null; try { W.createTranscoder({ ffmpegBin: bins.ffmpegBin }); } catch (e) { threw = e; }
    ok(threw && /prober/.test(threw.message), 'a transcoder without a prober cannot exist (verification is mandatory)');

    // ── C. Processor end-to-end ─────────────────────────────────────────────
    let env = null, pgUp = false, redisUp = false, storageUp = false, pool = null;
    try { env = loadEnv({ appEnv: 'test' }); } catch (e) { console.log('  env:', e.message); }
    if (env) { pool = createPool({ env, max: 8 }); try { await pool.query('select 1'); pgUp = true; } catch {} }
    try { const c = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 1500, lazyConnect: true }); await c.connect(); redisUp = (await c.ping()) === 'PONG'; await c.quit(); } catch {}
    try { storageUp = (await fetch(`${MINIO}/minio/health/live`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
    if (!pgUp || !redisUp || !storageUp) {
      console.log(`\n  SKIPPED C — ${[!pgUp && 'PostgreSQL unreachable', !redisUp && `no Redis at ${REDIS_URL}`, !storageUp && `no object storage at ${MINIO}`].filter(Boolean).join(', ')}`);
      if (REQUIRED) { fail += 1; console.log('  FAIL: TRANSCODE_TESTS_REQUIRED=1 but infrastructure is unavailable'); }
    } else {
      console.log('\nC. Processor on real PostgreSQL + MinIO + Redis');
      const db = createClient(pool);
      const repositories = () => createRepositories(db);
      const repos = repositories();
      const withTransaction = (fn) => rawTx(fn, db);
      const storagePkg = require(path.join(ROOT, 'storage', 'src', 'index.js'));
      const storage = storagePkg.createStorageProvider({ appEnv: 'test' });
      const keys = storagePkg.keys;
      const U = `usr_t702_${RUN}`;
      await db.execute(sql`INSERT INTO users (id,email,name,password_hash) VALUES (${U}, ${`t702-${RUN}@example.com`}, 'T702', 'x')`);
      const rid = (k) => `rec_t702_${k}_${RUN}`;
      const created = [];
      const mkRec = async (k, file, { status = 'uploaded' } = {}) => {
        const bytes = fs.readFileSync(f(file));
        await db.execute(sql`INSERT INTO recordings (id,user_id,title,status,source_kind,privacy,size_bytes) VALUES (${rid(k)}, ${U}, ${k}, ${status}, 'extension', 'unlisted', ${bytes.length})`);
        const key = `sources/${rid(k)}/source.${path.extname(file).slice(1)}`;
        await storage.putObject(key, bytes, { contentType: 'video/webm' });
        await db.execute(sql`INSERT INTO video_assets (id,recording_id,kind,storage_key,status,size_bytes,counts_toward_quota) VALUES (${`ast_t702_${k}_${RUN}`}, ${rid(k)}, 'source', ${key}, 'ready', ${bytes.length}, true)`);
        created.push(rid(k));
        return rid(k);
      };
      const rec = (id) => repos.recordings.getSystem(id, REASON);
      const rowOf = (key) => repos.jobs.findByDedupeKey(key);
      const assetsOf = (id) => repos.assets.listByRecordingSystem(id, REASON);
      const until = async (fn, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(150); } return false; };
      const registry = W.createRegistry();
      W.registerMediaProcessors(registry);
      const deps = { storage, withTransaction, prober, transcoder: tc, keys, resolveLimits: async () => ({ planSlug: 'pro', maxRecordingDurationSeconds: 36000 }) };
      const direct = (type, recordingId, extra = {}, payload = {}) => (async () => {
        const dedupe = type === 'transcode' ? `transcode:${recordingId}:mp4` : `${type}:${recordingId}`;
        let job = await rowOf(dedupe);
        if (!job) job = (await repos.jobs.enqueue({ queue: type, dedupeKey: dedupe, recordingId, payload: { recordingId, ...payload } })).job;
        job = await repos.jobs.markActiveSystem(job.id, REASON);
        try {
          const result = await registry.get(type).handler({ payload: { ...job.payload, ...payload }, job, signal: new AbortController().signal, logger: silent, deps: { ...deps, ...extra }, repositories });
          await repos.jobs.markCompletedSystem(job.id, result, REASON);
          return { result, job };
        } catch (e) { await repos.jobs.markFailedSystem(job.id, e.message, REASON, { terminal: e.retryable === false }); throw e; }
      })();
      const addPoster = async (id) => db.execute(sql`INSERT INTO video_assets (id,recording_id,kind,storage_key,status,counts_toward_quota) VALUES (${`ast_t702_poster_${id}`}, ${id}, 'poster', ${`derived/${id}/poster/poster.jpg`}, 'ready', false)`);

      try {
        // Full pipeline through the real worker app: relay → probe → fan-out → transcode.
        const A = await mkRec('a', 'src.webm');
        const prefix = `t702${RUN}`;
        const q = W.createBullJobQueue({ redisUrl: REDIS_URL, prefix, logger: silent, stalledIntervalMs: 500, lockDurationMs: 1000 });
        const config = W.loadWorkerConfig({ REDIS_URL, QUEUE_PREFIX: prefix, OUTBOX_INTERVAL_MS: '100', RECONCILE_INTERVAL_MS: '600000', WORKER_SCHEDULER: 'false', WORKER_DEFER_MS: '100' }, { appEnv: 'test' });
        const app = W.createWorkerApp({ config, logger: silent, repositories, jobQueue: q, registry: W.createDefaultRegistry({ maintenance: false, stt: false }), deps });
        await app.start();
        await repos.jobs.enqueue({ queue: 'probe', dedupeKey: `probe:${A}`, recordingId: A, payload: {} });
        ok(await until(async () => { const j = await rowOf(`transcode:${A}:mp4`); return j && j.status === 'completed'; }), 'probe fans out and the transcode job completes through the real pipeline');
        const mp4A = (await assetsOf(A)).find((a) => a.kind === 'mp4');
        ok(mp4A && mp4A.status === 'ready' && mp4A.variant === 'main' && mp4A.storageKey === keys.derivedVideo(A, mp4A.id) && mp4A.codecVideo === 'h264' && mp4A.codecAudio === 'aac' && mp4A.container === 'mp4' && mp4A.countsTowardQuota === false && mp4A.immutable === false && Number(mp4A.sizeBytes) > 0 && within(mp4A.duration, 4, 0.05), 'the MP4 asset row is ready with facts, an asset-id-scoped key, not billed, not immutable');
        const head = await storage.headObject(mp4A.storageKey);
        ok(head.contentLength === Number(mp4A.sizeBytes) && head.contentType === 'video/mp4', 'the object is in storage with the recorded size and video/mp4');
        const jA = await rowOf(`transcode:${A}:mp4`);
        ok(jA.result.progress === 100 && jA.result.assetId === mp4A.id && jA.result.ready.promoted === false && jA.result.ready.reason === 'poster_not_ready', 'the job result carries progress=100 and the promotion verdict: waiting for the poster');
        ok((await rec(A)).status === 'processing', 'no poster yet → the recording stays processing (ready needs MP4 AND poster)');
        await app.stop();
        const qq = W.createBullJobQueue({ redisUrl: REDIS_URL, prefix, logger: silent }); await qq.obliterate(); await qq.close();

        // Poster arrives → the check-before-do re-run promotes without re-encoding.
        await addPoster(A);
        const sizeBefore = Number(mp4A.sizeBytes);
        const rerun = await direct('transcode', A);
        ok(rerun.result.skipped === 'already_ready' && rerun.result.ready.promoted === true && (await rec(A)).status === 'ready' && (await rec(A)).failureCode === null, 'MP4 already ready → skipped (check-before-do) and maybe_mark_ready promotes now that the poster exists');
        ok((await assetsOf(A)).filter((a) => a.kind === 'mp4').length === 1 && Number((await assetsOf(A)).find((a) => a.kind === 'mp4').sizeBytes) === sizeBefore, 'one MP4 asset row, untouched by the skip');
        // Forced re-run: same asset row, object overwritten.
        const forced = await direct('transcode', A, {}, { force: true });
        const mp4A2 = (await assetsOf(A)).find((a) => a.kind === 'mp4');
        ok(!forced.result.skipped && mp4A2.id === mp4A.id && mp4A2.status === 'ready' && (await assetsOf(A)).filter((a) => a.kind === 'mp4').length === 1 && (await rec(A)).status === 'ready', 'a forced re-run re-encodes into the SAME asset row/key (idempotent) and never demotes ready');

        // Promotion order: poster first, then transcode promotes.
        const B = await mkRec('b', 'vo.webm');
        await direct('probe', B);
        await addPoster(B);
        const rB = await direct('transcode', B);
        ok(rB.result.ready.promoted === true && (await rec(B)).status === 'ready' && rB.result.audio === false, 'whichever finishes second promotes — here transcode after the poster; video-only stays video-only');

        // Thumbnail failed terminally → promote with a placeholder poster.
        const Cn = await mkRec('c', 'src.webm');
        await direct('probe', Cn);
        const thumb = await rowOf(`thumb:${Cn}`);
        await repos.jobs.markActiveSystem(thumb.id, REASON); await repos.jobs.markFailedSystem(thumb.id, 'boom', REASON, { terminal: true });
        const rC = await direct('transcode', Cn);
        ok(rC.result.ready.promoted === true && rC.result.ready.posterPlaceholder === true && (await rec(Cn)).status === 'ready', 'a terminally failed thumbnail job never blocks ready (placeholder poster, logged loudly)');

        // Guards: rejected / failed / deleted are never promoted; probe required; lock required.
        const D = await mkRec('d', 'src.webm');
        await direct('probe', D);
        await repos.recordings.updateSystem(D, { status: 'rejected_limit', failureCode: 'recording_limit' }, REASON);
        let threw2 = null; try { await direct('transcode', D); } catch (e) { threw2 = e; }
        ok(threw2 && threw2.code === 'recording_not_processable' && threw2.retryable === false, 'a rejected recording is not transcoded');
        const E = await mkRec('e', 'src.webm');
        threw2 = null; try { await direct('transcode', E); } catch (e) { threw2 = e; }
        ok(threw2 && threw2.code === 'probe_required', 'transcode before probe → probe_required (facts missing)');
        const verdict = await withTransaction((tx) => W.maybeMarkReady({ tx, recordingId: E }));
        ok(verdict.promoted === false && verdict.reason === 'mp4_not_ready', 'maybe_mark_ready without an MP4 → not promoted');
        threw2 = null; try { await W.maybeMarkReady({ tx: repos, recordingId: E }); } catch (e) { threw2 = e; }
        ok(threw2 && threw2.code === 'invalid_state', 'maybe_mark_ready refuses to run outside a transaction (the row lock is the point)');
        await db.execute(sql`update recordings set deleted_at = now() where id = ${E}`);
        ok((await withTransaction((tx) => W.maybeMarkReady({ tx, recordingId: E }))).reason === 'recording_gone', 'a deleted recording is never promoted');

        // Attempts exhausted → failed(transcode_failed), source kept.
        const F = await mkRec('f', 'src.webm');
        await direct('probe', F);
        const failing = { transcodeToMp4: async () => { const e = new Error('ffmpeg exploded'); e.code = 'tool_failed'; e.stderrTail = 'x'; throw e; } };
        const runner = W.createJobRunner({ repositories, registry, logger: silent, deps: { ...deps, transcoder: failing } });
        const tj = await rowOf(`transcode:${F}:mp4`);
        await db.execute(sql`update processing_jobs set max_attempts = 2 where id = ${tj.id}`);
        let last = null;
        for (let i = 0; i < 2; i += 1) { try { await runner.runJob({ id: tj.id, type: 'transcode', payload: tj.payload }); } catch (e) { last = e; } }
        ok(last && last.unrecoverable === true && (await rowOf(`transcode:${F}:mp4`)).status === 'failed' && /ffmpeg_failed/.test((await rowOf(`transcode:${F}:mp4`)).lastError), 'after the last attempt the job is failed with the ffmpeg error');
        const rF = await rec(F);
        ok(rF.status === 'failed' && rF.failureCode === 'transcode_failed' && (await assetsOf(F)).some((a) => a.kind === 'source' && a.status === 'ready'), 'the recording is failed(transcode_failed) and the source is kept for a retry');
        const okRunner = W.createJobRunner({ repositories, registry, logger: silent, deps });
        await repos.jobs.requeueSystem(tj.id, REASON, { resetAttempts: true, fromStatuses: ['failed'] });
        await repos.recordings.updateSystem(F, { status: 'processing', failureCode: null }, REASON);
        await okRunner.runJob({ id: tj.id, type: 'transcode', payload: tj.payload });
        ok((await rowOf(`transcode:${F}:mp4`)).status === 'completed' && (await assetsOf(F)).find((a) => a.kind === 'mp4').status === 'ready', 'a retry with a working transcoder recovers (reprocess path)');

        // Per-type concurrency: two transcodes in one process never overlap.
        const G1 = await mkRec('g1', 'src.webm'), G2 = await mkRec('g2', 'src.webm');
        await direct('probe', G1); await direct('probe', G2);
        let active = 0, maxActive = 0;
        const slowTc = { transcodeToMp4: async (...a) => { active += 1; maxActive = Math.max(maxActive, active); await sleep(300); try { return await tc.transcodeToMp4(...a); } finally { active -= 1; } } };
        const conc = W.createJobRunner({ repositories, registry, logger: silent, deps: { ...deps, transcoder: slowTc } });
        const j1 = await rowOf(`transcode:${G1}:mp4`), j2 = await rowOf(`transcode:${G2}:mp4`);
        await Promise.all([conc.runJob({ id: j1.id, type: 'transcode', payload: j1.payload }), conc.runJob({ id: j2.id, type: 'transcode', payload: j2.payload })]);
        ok(maxActive === 1 && (await rowOf(`transcode:${G1}:mp4`)).status === 'completed' && (await rowOf(`transcode:${G2}:mp4`)).status === 'completed', 'transcode runs one at a time per worker process (docs/09 §9) while both jobs still complete');
        ok(W.createDefaultRegistry().get('transcode').concurrency === 1 && W.createDefaultRegistry().get('probe').concurrency === null, 'the catalog serialises transcode/hls/render only');
      } finally {
        for (const id of created) {
          const list = await storage.listObjects(`derived/${id}/`).catch(() => ({ objects: [] }));
          for (const o of list.objects) await storage.deleteObject(o.key).catch(() => {});
          await storage.deleteObject(`sources/${id}/source.webm`).catch(() => {});
          await storage.deleteObject(`sources/${id}/source.mp4`).catch(() => {});
        }
        await db.execute(sql`delete from users where id = ${U}`);
        await pool.end().catch(() => {});
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
