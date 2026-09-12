// T-1202 / T-1203 / T-1204 render + silence_detect (run: cd worker && npm run test:render)
//
// A. pure: the common canvas (cap 1920 long edge, even), strategy planning,
//    the re-encode filter graph (trim/scale/pad/concat, silent audio for clips
//    without any, libx264 + aac + faststart), keep-ranges from silences and
//    from transcript gaps, silencedetect parsing; B. real ffmpeg: single-source
//    keyframe-aligned cuts → stream copy (verified, lossless), non-aligned cuts
//    still land within tolerance, forced encode, a multi-source timeline on the
//    base's canvas with audio synthesised for the silent clip, progress to 100,
//    abort, verification refuses a wrong duration; C. the processors on
//    PostgreSQL + MinIO + Redis: overwrite (MP4 re-pointed, stale derived rows
//    dropped, virtual edits cleared, the SOURCE untouched), copy (output
//    recording published as an immutable source, the render's reservation
//    reconciled, the probe fanned out, and the real pipeline promotes it to
//    ready), failure leaves the draft intact and releases the reservation, a
//    render through the real worker app, silence_detect → recordings.segments
//    (+ guards); D. wiring.
//
// SKIPS LOUDLY without infrastructure; RENDER_TESTS_REQUIRED=1 makes that a failure.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const W = require(path.join(ROOT, 'worker', 'src', 'index.js'));
const R = require(path.join(ROOT, 'worker', 'src', 'media', 'render.js'));
const P = require(path.join(ROOT, 'worker', 'src', 'processors', 'render.js'));
const IORedis = require(path.join(ROOT, 'worker', 'node_modules', 'ioredis'));
const { loadEnv, createPool, createClient, createRepositories, withTransaction: rawTx } = require(path.join(DB_DIR, 'src', 'index.js'));
const { sql } = require(path.join(DB_DIR, 'node_modules', 'drizzle-orm'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const REQUIRED = process.env.RENDER_TESTS_REQUIRED === '1';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6380';
const MINIO = process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9100';
const RUN = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silent = W.silentLogger();
const REASON = 'T-1202 render test';
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= tol;
const MiB = 1024 * 1024;

(async () => {
  console.log('T-1202/T-1203/T-1204 render + silence_detect tests');

  // ── A. Pure ───────────────────────────────────────────────────────────────
  console.log('\nA. Pure');
  ok(JSON.stringify(R.planCanvas({ video: { width: 1280, height: 720 } })) === '{"width":1280,"height":720}' && JSON.stringify(R.planCanvas({ video: { width: 2560, height: 1440 } })) === '{"width":1920,"height":1080}', 'the canvas is the base\'s size, capped at a 1920 long edge');
  ok(JSON.stringify(R.planCanvas({ video: { width: 1081, height: 1921 } })) === '{"width":1080,"height":1920}' && JSON.stringify(R.planCanvas({ video: { width: 641, height: 361 } })) === '{"width":640,"height":360}' && JSON.stringify(R.planCanvas(null)) === '{"width":1280,"height":720}', 'portrait is capped on its long edge, odd dimensions snap even, no facts → 720p');
  ok(R.planStrategy([{ path: 'a' }, { path: 'a' }]) === 'copy' && R.planStrategy([{ path: 'a' }, { path: 'b' }]) === 'encode', 'one source → stream copy; several → encode');
  {
    const args = R.buildEncodeArgs([{ path: '/a.mp4', in: 1, out: 3.5, hasAudio: true }, { path: '/b.mp4', in: 0, out: 2, hasAudio: false }, { path: '/a.mp4', in: 5, out: 6, hasAudio: true }], '/out.mp4', { width: 640, height: 360 });
    const fc = args[args.indexOf('-filter_complex') + 1];
    ok(args.filter((a) => a === '-i').length === 2 && args[args.indexOf('-i') + 1] === '/a.mp4', 'each distinct source is one input (the same file is not opened twice)');
    ok(/\[0:v\]trim=start=1:end=3\.5,setpts=PTS-STARTPTS,scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black,setsar=1,fps=30,format=yuv420p\[v0\]/.test(fc) && /\[1:v\]trim=start=0:end=2/.test(fc) && /\[0:v\]trim=start=5:end=6/.test(fc), 'every clip is trimmed, scaled into the canvas and letterboxed');
    ok(/\[0:a\]atrim=start=1:end=3\.5,asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo\[a0\]/.test(fc) && /anullsrc=r=48000:cl=stereo,atrim=0:2,asetpts=PTS-STARTPTS\[a1\]/.test(fc), 'audio is resampled to 48 kHz stereo; a silent clip gets synthesised silence of its own length');
    ok(/\[v0\]\[a0\]\[v1\]\[a1\]\[v2\]\[a2\]concat=n=3:v=1:a=1\[vout\]\[aout\]/.test(fc) && args[args.indexOf('-c:v') + 1] === 'libx264' && args[args.indexOf('-crf') + 1] === '23' && args[args.indexOf('-c:a') + 1] === 'aac' && args.includes('+faststart') && args[args.indexOf('-progress') + 1] === 'pipe:1' && args[args.length - 1] === '/out.mp4', 'concat in timeline order; libx264 crf 23, aac, +faststart, live progress');
  }
  ok(JSON.stringify(R.keepRangesFromSilences([{ start: 2, end: 5 }, { start: 6, end: 6.5 }], 8)) === '[{"start":0,"end":2.2},{"start":4.8,"end":8}]', 'silences → keep-ranges: padded 0.2 s on both sides, a gap under minGap is kept (speech pacing)');
  ok(JSON.stringify(R.keepRangesFromSilences([{ start: 0, end: 3 }], 8)) === '[{"start":2.8,"end":8}]' && JSON.stringify(R.keepRangesFromSilences([{ start: 5, end: 8 }], 8)) === '[{"start":0,"end":5.2}]' && R.keepRangesFromSilences([], 8).length === 1 && R.keepRangesFromSilences([], 0) === null, 'leading/trailing silence; no silence → the whole video; no duration → null');
  ok(JSON.stringify(R.keepRangesFromSilences([{ start: 1, end: 3 }, { start: 3.5, end: 6 }], 10, { pad: 0.5, minGap: 1 })) === '[{"start":0,"end":1.5},{"start":2.5,"end":4},{"start":5.5,"end":10}]', 'pad / minGap are parameters');
  ok(JSON.stringify(R.keepRangesFromTranscript([{ start: 0.5, end: 2 }, { start: 2.3, end: 4 }, { start: 6, end: 7 }], 8)) === '[{"start":0.3,"end":4.2},{"start":5.8,"end":7.2}]' && R.keepRangesFromTranscript([], 8) === null, 'the legacy transcript-gap rule (merge segments closer than minGap, pad) is the fallback');
  ok(JSON.stringify(P.parseSilenceDetect('[silencedetect @ 0x1] silence_start: 2.01\n[silencedetect @ 0x1] silence_end: 5.02 | silence_duration: 3.01\nsilence_start: 7\n')) === '[{"start":2.01,"end":5.02}]', 'silencedetect stderr → [{start,end}] (an unterminated silence is dropped)');
  let threw = null; try { R.createRenderer({ ffmpegBin: 'x' }); } catch (e) { threw = e; }
  ok(threw && /prober/.test(threw.message), 'a renderer without a prober cannot exist');

  const bins = W.resolveBinaries();
  let ffmpegOk = false;
  try { await W.runTool(bins.ffmpegBin, ['-version'], { timeout: 10000 }); await W.runTool(bins.ffprobeBin, ['-version'], { timeout: 10000 }); ffmpegOk = true; } catch {}
  if (!ffmpegOk) {
    console.log('\n  SKIPPED B–C — no ffmpeg/ffprobe');
    if (REQUIRED) { fail += 1; console.log('  FAIL: RENDER_TESTS_REQUIRED=1 but ffmpeg is unavailable'); }
  } else {
    console.log('\nB. Real ffmpeg');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1202-'));
    const f = (n) => path.join(dir, n);
    const gen = (out, args) => W.runTool(bins.ffmpegBin, ['-hide_banner', '-nostdin', '-y', ...args, out], { timeout: 180000 });
    // a: 640x360, 8 s, tone, a keyframe every second (cuts on whole seconds are stream-copyable).
    await gen(f('a.mp4'), ['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-c:a', 'aac', '-movflags', '+faststart']);
    // b: 320x240, 5 s, no audio.
    await gen(f('b.mp4'), ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart']);
    // s: 8 s with a tone that is muted between 2 s and 5 s.
    await gen(f('s.mp4'), ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '8', '-af', "volume=volume=0:enable='between(t,2,5)'", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart']);
    const prober = W.createProber({ ffprobeBin: bins.ffprobeBin, ffmpegBin: bins.ffmpegBin, logger: silent });
    const renderer = R.createRenderer({ ffmpegBin: bins.ffmpegBin, prober, logger: silent });
    const fa = await prober.probeFile(f('a.mp4'));
    const canvas = renderer.planCanvas(fa);
    ok(canvas.width === 640 && canvas.height === 360 && near(fa.durationSec, 8, 0.1) && !!fa.audio, 'fixture a: 640x360, 8 s, with audio');
    const mk = (n) => { const d = f(`work-${n}`); fs.mkdirSync(d); return d; };

    const pcts = [];
    const r1 = await renderer.render({ clips: [{ path: f('a.mp4'), in: 1, out: 3, hasAudio: true }, { path: f('a.mp4'), in: 5, out: 7, hasAudio: true }], outPath: f('r1.mp4'), canvas, dir: mk(1), onProgress: (p) => pcts.push(p) });
    ok(r1.strategy === 'copy' && r1.durationSec === 4 && near(r1.facts.durationSec, 4, 0.5) && r1.facts.video.codec === 'h264' && r1.facts.video.width === 640 && !!r1.facts.audio, 'keyframe-aligned cuts on one source → stream copy: two cuts concatenated, ~4 s, h264 + audio');
    ok(W.hasFaststart(f('r1.mp4')) && pcts[pcts.length - 1] === 100 && pcts.every((p, i) => i === 0 || p >= pcts[i - 1]), 'the copy output is faststart; progress is monotonic to 100');
    ok(fs.existsSync(f('work-1/seg_000.mp4')) && fs.existsSync(f('work-1/seg_001.mp4')) && fs.existsSync(f('work-1/concat.txt')), 'segments and the concat list live in the scratch dir');

    const r2 = await renderer.render({ clips: [{ path: f('a.mp4'), in: 0.5, out: 2.3, hasAudio: true }], outPath: f('r2.mp4'), canvas, dir: mk(2) });
    ok(['copy', 'encode'].includes(r2.strategy) && near(r2.facts.durationSec, 1.8, 0.3) && r2.facts.video.codec === 'h264', `a non-aligned cut still lands within tolerance (strategy ${r2.strategy}: a copy that misses is re-encoded)`);

    const r3 = await renderer.render({ clips: [{ path: f('a.mp4'), in: 1, out: 3, hasAudio: true }], outPath: f('r3.mp4'), canvas, dir: mk(3), forceEncode: true });
    ok(r3.strategy === 'encode' && near(r3.facts.durationSec, 2, 0.15) && r3.facts.video.width === 640 && r3.facts.video.height === 360 && r3.facts.audio && r3.facts.audio.codec === 'aac' && W.hasFaststart(f('r3.mp4')), 'forceEncode → libx264/aac on the canvas, faststart');

    const pcts4 = [];
    const r4 = await renderer.render({ clips: [{ path: f('a.mp4'), in: 0, out: 2, hasAudio: true }, { path: f('b.mp4'), in: 1, out: 3, hasAudio: false }, { path: f('a.mp4'), in: 6, out: 8, hasAudio: true }], outPath: f('r4.mp4'), canvas, dir: mk(4), onProgress: (p) => pcts4.push(p) });
    ok(r4.strategy === 'encode' && near(r4.facts.durationSec, 6, 0.3) && r4.facts.video.width === 640 && r4.facts.video.height === 360 && !!r4.facts.audio, 'a multi-source timeline is encoded on the base\'s canvas (the 320x240 clip letterboxed) with one continuous audio track');
    ok(pcts4.length >= 2 && pcts4[pcts4.length - 1] === 100 && pcts4.every((p, i) => i === 0 || p >= pcts4[i - 1]), 'encode progress streams from ffmpeg -progress to 100');
    const decoded = await W.runTool(bins.ffmpegBin, ['-hide_banner', '-nostdin', '-i', f('r4.mp4'), '-f', 'null', '-'], { timeout: 60000 }).then(() => true, () => false);
    ok(decoded, 'the encoded output decodes end to end');

    const ac = new AbortController();
    const pAbort = renderer.render({ clips: [{ path: f('a.mp4'), in: 0, out: 8, hasAudio: true }, { path: f('b.mp4'), in: 0, out: 5, hasAudio: false }], outPath: f('r5.mp4'), canvas, dir: mk(5), signal: ac.signal }).then(() => null, (e) => e);
    setTimeout(() => ac.abort(), 150);
    const aborted = await pAbort;
    ok(aborted && aborted.code === 'aborted', 'an abort signal kills ffmpeg mid-render');
    const v = await renderer.verify(f('r3.mp4'), 9, 1);
    ok(v.problems.length === 1 && /duration/.test(v.problems[0]), 'verification refuses an output whose duration disagrees with the timeline');
    threw = null; try { await renderer.render({ clips: [], outPath: f('x.mp4'), canvas, dir: mk(6) }); } catch (e) { threw = e; }
    ok(threw && threw.code === 'invalid_timeline', 'an empty timeline is refused');

    // ── C. Processors ───────────────────────────────────────────────────────
    let env = null, pgUp = false, redisUp = false, storageUp = false, pool = null;
    try { env = loadEnv({ appEnv: 'test' }); } catch (e) { console.log('  env:', e.message); }
    if (env) { pool = createPool({ env, max: 8 }); try { await pool.query('select 1'); pgUp = true; } catch {} }
    try { const c = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 1500, lazyConnect: true }); await c.connect(); redisUp = (await c.ping()) === 'PONG'; await c.quit(); } catch {}
    try { storageUp = (await fetch(`${MINIO}/minio/health/live`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
    if (!pgUp || !redisUp || !storageUp) {
      console.log(`\n  SKIPPED C — ${[!pgUp && 'PostgreSQL unreachable', !redisUp && `no Redis at ${REDIS_URL}`, !storageUp && `no object storage at ${MINIO}`].filter(Boolean).join(', ')}`);
      if (REQUIRED) { fail += 1; console.log('  FAIL: RENDER_TESTS_REQUIRED=1 but infrastructure is unavailable'); }
    } else {
      console.log('\nC. Processors on real PostgreSQL + MinIO + Redis');
      const db = createClient(pool);
      const repositories = () => createRepositories(db);
      const repos = repositories();
      const withTransaction = (fn) => rawTx(fn, db);
      const storagePkg = require(path.join(ROOT, 'storage', 'src', 'index.js'));
      const storage = storagePkg.createStorageProvider({ appEnv: 'test' });
      const keys = storagePkg.keys;
      const U = `usr_t1202_${RUN}`, U2 = `usr_t1202b_${RUN}`;
      for (const [u, n] of [[U, 'T1202'], [U2, 'Other']]) {
        await db.execute(sql`INSERT INTO users (id,email,name,password_hash) VALUES (${u}, ${`${u}@example.com`}, ${n}, 'x')`);
        await db.execute(sql`INSERT INTO usage (user_id) VALUES (${u}) ON CONFLICT DO NOTHING`);
      }
      const scope = { userId: U };
      const rid = (k) => `rec_t1202_${k}_${RUN}`;
      const created = [];
      const mkRec = async (k, file, { owner = U, withMp4 = false, status = 'ready' } = {}) => {
        const bytes = fs.readFileSync(f(file));
        const facts = await prober.probeFile(f(file));
        await db.execute(sql`INSERT INTO recordings (id,user_id,title,status,source_kind,privacy,size_bytes,duration,width,height,trim_start,trim_end,segments) VALUES (${rid(k)}, ${owner}, ${`Render ${k}`}, ${status}, 'extension', 'unlisted', ${bytes.length}, ${facts.durationSec}, ${facts.video.width}, ${facts.video.height}, 1, 7, ${JSON.stringify([{ start: 1, end: 7 }])}::jsonb)`);
        const key = `sources/${rid(k)}/source.mp4`;
        await storage.putObject(key, bytes, { contentType: 'video/mp4' });
        await db.execute(sql`INSERT INTO video_assets (id,recording_id,kind,storage_key,status,size_bytes,duration,width,height,container,counts_toward_quota,immutable) VALUES (${`ast_t1202_${k}_${RUN}`}, ${rid(k)}, 'source', ${key}, 'ready', ${bytes.length}, ${facts.durationSec}, ${facts.video.width}, ${facts.video.height}, 'mp4', true, true)`);
        if (withMp4) {
          const mkey = keys.derivedVideo(rid(k), `ast_t1202_${k}m_${RUN}`);
          await storage.putObject(mkey, bytes, { contentType: 'video/mp4' });
          await db.execute(sql`INSERT INTO video_assets (id,recording_id,kind,variant,storage_key,status,size_bytes,duration,width,height,container,counts_toward_quota,immutable) VALUES (${`ast_t1202_${k}m_${RUN}`}, ${rid(k)}, 'mp4', 'main', ${mkey}, 'ready', ${bytes.length}, ${facts.durationSec}, ${facts.video.width}, ${facts.video.height}, 'mp4', false, false)`);
          await db.execute(sql`INSERT INTO video_assets (id,recording_id,kind,storage_key,status,counts_toward_quota,immutable) VALUES (${`ast_t1202_${k}h_${RUN}`}, ${rid(k)}, 'hls', ${`derived/${rid(k)}/ast_t1202_${k}h_${RUN}/hls/master.m3u8`}, 'ready', false, false)`);
          await db.execute(sql`INSERT INTO video_assets (id,recording_id,kind,storage_key,status,counts_toward_quota,immutable) VALUES (${`ast_t1202_${k}c_${RUN}`}, ${rid(k)}, 'captions_vtt', ${`derived/${rid(k)}/ast_t1202_${k}c_${RUN}/captions.vtt`}, 'ready', false, false)`);
        }
        created.push(rid(k));
        return rid(k);
      };
      const rec = (id) => repos.recordings.getSystem(id, REASON);
      const rowOf = (key) => repos.jobs.findByDedupeKey(key);
      const assetsOf = (id) => repos.assets.listByRecordingSystem(id, REASON);
      const usageOf = async () => (await db.execute(sql`select storage_retained_bytes r, storage_reserved_bytes v, reserved_video_slots s, active_video_count c from usage where user_id = ${U}`)).rows[0];
      const until = async (fn, ms = 180000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(200); } return false; };
      const registry = W.createRegistry();
      W.registerMediaProcessors(registry);
      W.registerEditingProcessors(registry);
      const deps = { storage, withTransaction, prober, renderer, keys, ffmpegBin: bins.ffmpegBin, transcoder: W.createTranscoder({ ffmpegBin: bins.ffmpegBin, prober, logger: silent }), thumbnailer: W.createThumbnailer({ ffmpegBin: bins.ffmpegBin, prober, logger: silent }), audioExtractor: W.createAudioExtractor({ ffmpegBin: bins.ffmpegBin, prober, logger: silent }), hlsPackager: W.createHlsPackager({ ffmpegBin: bins.ffmpegBin, prober, logger: silent }), resolveLimits: async () => ({ planSlug: 'pro', maxRecordingDurationSeconds: 36000 }) };
      const direct = async (type, dedupe, recordingId, payload = {}, { maxAttempts = 2 } = {}) => {
        let job = await rowOf(dedupe);
        if (!job) job = (await repos.jobs.enqueue({ queue: type, dedupeKey: dedupe, recordingId, payload: { recordingId, ...payload }, maxAttempts })).job;
        job = await repos.jobs.markActiveSystem(job.id, REASON);
        try {
          const result = await registry.get(type).handler({ payload: { ...job.payload, ...payload }, job, signal: new AbortController().signal, logger: silent, deps, repositories });
          await repos.jobs.markCompletedSystem(job.id, result, REASON);
          return { result, job: await repos.jobs.getSystem(job.id, REASON) };
        } catch (e) { await repos.jobs.markFailedSystem(job.id, e.message, REASON, { terminal: e.retryable === false }); throw e; }
      };
      /** The router's enqueue, replayed: session → rendering, render_jobs row, (copy: output recording + reservation), processing job row. */
      const enqueueRender = async (recordingId, timeline, mode, { reserveBytes = 2 * MiB } = {}) => withTransaction(async (tx) => {
        const session = await tx.editSessions.create(scope, { recordingId, timeline });
        let outputRecordingId = null;
        if (mode === 'copy') {
          const base = await tx.recordings.get(scope, recordingId);
          const out = await tx.recordings.create(scope, { title: `${base.title} (edited)`, sourceKind: 'render', status: 'processing', privacy: base.privacy });
          outputRecordingId = out.id; created.push(out.id);
        }
        await tx.editSessions.setStatus(scope, session.id, 'rendering', { mode });
        const renderJob = await tx.renderJobs.create(scope, { editSessionId: session.id, outputRecordingId });
        if (mode === 'copy') {
          await tx.uploads.createReservation(scope, { renderJobId: renderJob.id, reservedBytes: reserveBytes, reservedSlots: 1, expiresAt: new Date(Date.now() + 3600e3) });
          await tx.usage.applyDelta(scope, { storageReservedBytes: reserveBytes, reservedVideoSlots: 1 });
        }
        const dedupe = `render:${session.id}:${renderJob.id}`;
        const { job } = await tx.jobs.enqueue({ queue: 'render', dedupeKey: dedupe, recordingId, payload: { editSessionId: session.id, renderJobId: renderJob.id, mode, outputRecordingId, timeline, canvasFrom: recordingId }, maxAttempts: 2 });
        await tx.renderJobs.updateSystem(renderJob.id, { processingJobId: job.id }, REASON);
        return { session, renderJob, job, dedupe, outputRecordingId };
      });

      try {
        const A = await mkRec('a', 'a.mp4', { withMp4: true });
        const B = await mkRec('b', 'b.mp4');
        const S = await mkRec('s', 's.mp4');
        const X = await mkRec('x', 'b.mp4', { owner: U2 });

        // 1. overwrite
        const srcKey = `sources/${A}/source.mp4`;
        const srcSizeBefore = (await storage.headObject(srcKey)).contentLength;
        const mp4Before = (await assetsOf(A)).find((a) => a.kind === 'mp4');
        const o = await enqueueRender(A, [{ recordingId: A, start: 1, end: 3 }, { recordingId: A, start: 5, end: 7 }], 'overwrite');
        const ro = await direct('render', o.dedupe, A, o.job.payload);
        ok(ro.result.mode === 'overwrite' && ro.result.strategy === 'copy' && ro.result.outputRecordingId === A && ro.job.status === 'completed' && ro.job.result.progress === 100, 'overwrite: the timeline is stream-copied and the job completes with progress 100');
        const assetsA = await assetsOf(A);
        const mp4A = assetsA.find((a) => a.kind === 'mp4' && a.variant === 'main');
        ok(mp4A && mp4A.id === mp4Before.id && mp4A.storageKey === keys.render(o.session.id, o.renderJob.id) && mp4A.status === 'ready' && near(mp4A.duration, 4, 0.5) && mp4A.width === 640 && mp4A.createdByJobId === o.job.id, 'the active MP4 row is RE-POINTED at renders/{session}/{job}.mp4 with the output\'s facts');
        ok((await storage.headObject(mp4A.storageKey)).contentLength === Number(mp4A.sizeBytes) && (await storage.headObject(mp4Before.storageKey)).contentLength > 0, 'the rendered object exists; the previous MP4 object is left for the orphan sweep');
        ok(!assetsA.some((a) => a.kind === 'hls' || a.kind === 'captions_vtt') && assetsA.some((a) => a.kind === 'source' && a.storageKey === srcKey && a.immutable), 'stale HLS / captions rows are dropped; the immutable source row is untouched');
        ok((await storage.headObject(srcKey)).contentLength === srcSizeBefore, 'the SOURCE object is byte-for-byte untouched (invariant #13)');
        const recA = await rec(A);
        ok(near(recA.duration, 4, 0.5) && recA.trimStart == null && recA.trimEnd == null && recA.segments == null && recA.status === 'ready' && Number(recA.sizeBytes) === Number(mp4A.sizeBytes), 'the recording carries the new duration/size and its virtual edits are cleared; it stays ready');
        const rjO = await repos.renderJobs.getSystem(o.renderJob.id, REASON);
        ok(rjO.status === 'done' && rjO.outputAssetId === mp4A.id && rjO.outputRecordingId === A && (await repos.editSessions.getSystem(o.session.id, REASON)).status === 'applied', 'render_jobs done (output asset = the MP4) and the session is applied');
        const again = await direct('render', o.dedupe, A, o.job.payload);
        ok(again.result.skipped === 'already_done', 'a re-delivery of a done render is skipped (check-before-do)');

        // 2. copy (multi-source → encode) with the reservation reconciled and the pipeline fanned out.
        const u0 = await usageOf();
        const c = await enqueueRender(A, [{ recordingId: A, start: 0, end: 2 }, { recordingId: B, start: 0, end: 2 }], 'copy', { reserveBytes: 2 * MiB });
        const u1 = await usageOf();
        ok(Number(u1.v) === Number(u0.v) + 2 * MiB && Number(u1.s) === Number(u0.s) + 1, 'setup: the copy holds a reservation (bytes + one slot)');
        const rc = await direct('render', c.dedupe, A, c.job.payload);
        const out = await rec(c.outputRecordingId);
        ok(rc.result.mode === 'copy' && rc.result.strategy === 'encode' && rc.result.outputRecordingId === c.outputRecordingId && out.status === 'uploaded' && out.sourceKind === 'render' && near(out.duration, 4, 0.3) && out.width === 640 && out.height === 360, 'copy: a multi-source timeline is encoded and the pre-created recording becomes uploaded with the output\'s facts');
        const outAssets = await assetsOf(c.outputRecordingId);
        const outSrc = outAssets.find((a) => a.kind === 'source');
        ok(outAssets.length === 1 && outSrc.storageKey === keys.source(c.outputRecordingId, 'mp4') && outSrc.immutable && outSrc.countsTowardQuota && outSrc.container === 'mp4' && (await storage.headObject(outSrc.storageKey)).contentLength === Number(outSrc.sizeBytes), 'the output is the new recording\'s IMMUTABLE source (billed), uploaded to sources/{id}/source.mp4');
        const u2 = await usageOf();
        const resv = await repos.uploads.findReservationByRenderJob(scope, c.renderJob.id);
        ok(resv.status === 'reconciled' && Number(resv.reconciledBytes) === Number(outSrc.sizeBytes) && Number(u2.v) === Number(u0.v) && Number(u2.s) === Number(u0.s) && Number(u2.r) === Number(u0.r) + Number(outSrc.sizeBytes) && Number(u2.c) === Number(u0.c) + 1, 'the reservation is reconciled to the real size: reserved bytes/slot released, retained bytes + one active video charged');
        const probeRow = await rowOf(`probe:${c.outputRecordingId}`);
        ok(probeRow && probeRow.status === 'queued' && probeRow.payload.trigger === 'render' && probeRow.payload.storageKey === outSrc.storageKey, 'the normal pipeline is fanned out from a probe job on the output');
        const rjC = await repos.renderJobs.getSystem(c.renderJob.id, REASON);
        ok(rjC.status === 'done' && rjC.outputAssetId === outSrc.id && (await repos.editSessions.getSystem(c.session.id, REASON)).status === 'applied', 'render_jobs done (output asset = the source) and the session is applied');
        // The real pipeline takes it to ready.
        await direct('probe', `probe:${c.outputRecordingId}`, c.outputRecordingId);
        await direct('transcode', `transcode:${c.outputRecordingId}:mp4`, c.outputRecordingId);
        await direct('thumbnail', `thumb:${c.outputRecordingId}`, c.outputRecordingId);
        ok((await rec(c.outputRecordingId)).status === 'ready' && (await assetsOf(c.outputRecordingId)).some((a) => a.kind === 'mp4' && a.status === 'ready'), 'probe → transcode → thumbnail promote the rendered recording to ready like any upload');

        // 3. failure: a clip on another user's recording → terminal; draft intact; copy output failed + reservation released.
        const u3 = await usageOf();
        const bad = await enqueueRender(A, [{ recordingId: A, start: 0, end: 2 }, { recordingId: X, start: 0, end: 2 }], 'copy', { reserveBytes: 3 * MiB });
        let err = null; try { await direct('render', bad.dedupe, A, bad.job.payload); } catch (e) { err = e; }
        ok(err && err.code === 'render_forbidden_clip' && err.retryable === false, 'a clip the owner does not own is a terminal render_forbidden_clip');
        const rjB = await repos.renderJobs.getSystem(bad.renderJob.id, REASON);
        ok(rjB.status === 'failed' && /render_forbidden_clip/.test(rjB.error) && (await repos.editSessions.getSystem(bad.session.id, REASON)).status === 'draft', 'render_jobs failed with the reason; the session is back to draft (the edit is recoverable)');
        const outBad = await rec(bad.outputRecordingId);
        const u4 = await usageOf();
        const resvBad = await repos.uploads.findReservationByRenderJob(scope, bad.renderJob.id);
        ok(outBad.status === 'failed' && outBad.failureCode === 'render_forbidden_clip' && resvBad.status === 'released' && Number(u4.v) === Number(u3.v) && Number(u4.s) === Number(u3.s) && Number(u4.r) === Number(u3.r), 'the pre-created output recording fails honestly and the reservation is released (ledger restored)');
        ok((await assetsOf(A)).find((a) => a.kind === 'mp4').storageKey === mp4A.storageKey && (await storage.headObject(srcKey)).contentLength === srcSizeBefore, 'a failed render changed nothing on the base');
        const gone = await enqueueRender(A, [{ recordingId: A, start: 0, end: 1 }], 'overwrite');
        await repos.editSessions.setStatusSystem(gone.session.id, 'discarded', REASON);
        err = null; try { await direct('render', gone.dedupe, A, gone.job.payload); } catch (e) { err = e; }
        ok(err && err.code === 'render_forbidden_clip' && (await repos.renderJobs.getSystem(gone.renderJob.id, REASON)).status === 'failed', 'a discarded session is not rendered');

        // 4. through the real worker app (BullMQ + outbox relay).
        const prefix = `t1202${RUN}`;
        const q = W.createBullJobQueue({ redisUrl: REDIS_URL, prefix, logger: silent, stalledIntervalMs: 500, lockDurationMs: 1000 });
        const config = W.loadWorkerConfig({ REDIS_URL, QUEUE_PREFIX: prefix, OUTBOX_INTERVAL_MS: '100', RECONCILE_INTERVAL_MS: '600000', WORKER_SCHEDULER: 'false', WORKER_DEFER_MS: '100' }, { appEnv: 'test' });
        const editingOnly = W.createRegistry(); W.registerEditingProcessors(editingOnly);
        const app = W.createWorkerApp({ config, logger: silent, repositories, withTransaction, jobQueue: q, registry: editingOnly, deps });
        await app.start();
        const live = await enqueueRender(A, [{ recordingId: A, start: 0, end: 2 }], 'overwrite');
        ok(await until(async () => (await rowOf(live.dedupe)).status === 'completed'), 'a render job row is relayed and completed by the real worker app');
        const rjL = await repos.renderJobs.getSystem(live.renderJob.id, REASON);
        ok(rjL.status === 'done' && near((await rec(A)).duration, 2, 0.5), 'the app run re-pointed the MP4 (recording now ~2 s)');
        // silence_detect through the app too (the media queue).
        const sd = await withTransaction((tx) => tx.jobs.enqueue({ queue: 'silence_detect', dedupeKey: `silence:${S}`, recordingId: S, payload: { recordingId: S, pad: 0.2, minGap: 0.8 }, maxAttempts: 2 }));
        ok(await until(async () => (await rowOf(`silence:${S}`)).status === 'completed'), 'a silence_detect job completes through the real worker app');
        const sdRow = await rowOf(`silence:${S}`);
        const recS = await rec(S);
        ok(sdRow.result.method === 'audio' && sdRow.result.segments.length === 2 && near(sdRow.result.segments[0].end, 2.2, 0.3) && near(sdRow.result.segments[1].start, 4.8, 0.3) && sdRow.result.removedSeconds >= 2 && sdRow.result.removedSeconds <= 3, 'silencedetect found the muted 2–5 s gap: keep-ranges [0, ~2.2], [~4.8, 8]');
        ok(Array.isArray(recS.segments) && recS.segments.length === 2 && recS.trimStart == null && recS.trimEnd == null && recS.status === 'ready', 'the keep-ranges are applied as a VIRTUAL edit (recordings.segments; trims cleared); nothing rendered');
        ok((await assetsOf(S)).length === 1 && sd.job.id === sdRow.id, 'no new asset: silence removal is instant and reversible');
        await app.stop();
        const qq = W.createBullJobQueue({ redisUrl: REDIS_URL, prefix, logger: silent }); await qq.obliterate(); await qq.close();

        // 5. silence_detect guards.
        err = null; try { await direct('silence_detect', `silence:${A}`, A, { pad: 0.2, minGap: 0.8 }); } catch (e) { err = e; }
        ok(err && err.code === 'no_silence' && err.retryable === false, 'a continuous tone has no silences → terminal no_silence (nothing changed)');
        const N = await mkRec('n', 'b.mp4', { status: 'processing' });
        err = null; try { await direct('silence_detect', `silence:${N}`, N, {}); } catch (e) { err = e; }
        ok(err && err.code === 'recording_not_ready', 'a recording that is not ready is refused');
        const V = await mkRec('v', 'b.mp4');
        err = null; try { await direct('silence_detect', `silence:${V}`, V, {}); } catch (e) { err = e; }
        ok(err && err.code === 'no_speech' && err.retryable === false, 'a video-only recording without a transcript → no_speech');
        // 6. transcript fallback: a video-only recording WITH a transcript uses the gap rule.
        const t = await repos.transcripts.upsertSystem(V, { status: 'done', language: 'en', text: 'hi' }, REASON);
        await withTransaction((tx) => tx.transcripts.replaceSegmentsSystem(t.id, [{ idx: 0, start: 0.5, end: 1.5, text: 'a' }, { idx: 1, start: 3.5, end: 4.5, text: 'b' }], REASON));
        const rv = await direct('silence_detect', `silence:${V}`, V, {}, { maxAttempts: 3 }).catch((e) => ({ error: e }));
        ok(!rv.error && rv.result.method === 'transcript' && rv.result.segments.length === 2 && near(rv.result.segments[0].start, 0.3, 0.05) && near(rv.result.segments[1].end, 4.7, 0.05), `no audio signal → the transcript-gap fallback (legacy rule) [${rv.error ? rv.error.code + ' ' + rv.error.message : JSON.stringify(rv.result.segments)}]`);
      } finally {
        for (const id of created) {
          for (const p of [`derived/${id}/`, `audio/${id}/`, `sources/${id}/`]) { const list = await storage.listObjects(p).catch(() => ({ objects: [] })); for (const o of list.objects) await storage.deleteObject(o.key).catch(() => {}); }
        }
        const renders = await storage.listObjects('renders/').catch(() => ({ objects: [] }));
        for (const o of renders.objects) if ((await db.execute(sql`select 1 from edit_sessions where id = ${o.key.split('/')[1]} and user_id = ${U}`)).rows.length) await storage.deleteObject(o.key).catch(() => {});
        await db.execute(sql`delete from users where id in (${U}, ${U2})`);
        await pool.end().catch(() => {});
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── D. Wiring ─────────────────────────────────────────────────────────────
  console.log('\nD. Wiring');
  const reg = W.createDefaultRegistry();
  ok(reg.has('render') && reg.get('render').queue === 'render' && reg.get('render').concurrency === 1 && reg.get('render').timeoutMs === 60 * 60 * 1000, 'render is registered on the render queue, serialised per process, with the long timeout');
  ok(reg.has('silence_detect') && reg.get('silence_detect').queue === 'media' && W.JOB_TYPES.silence_detect.attempts === 2, 'silence_detect is registered on the media queue (2 attempts)');
  const main = fs.readFileSync(path.join(ROOT, 'worker', 'src', 'main.js'), 'utf8');
  ok(/createRenderer\(/.test(main) && /renderer,/.test(main) && /ffmpegBin: bins\.ffmpegBin, keys/.test(main), 'main.js builds the renderer and hands renderer + ffmpegBin to the processors');
  ok(typeof W.createRenderer === 'function' && typeof W.keepRangesFromSilences === 'function' && typeof W.parseSilenceDetect === 'function', 'the worker package exports the renderer and the silence helpers');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
