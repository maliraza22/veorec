// T-307 quota UX tests (run: cd server && npm run test:quota-ux)
//
// Part A — the client meter module (ESM, loaded via dynamic import): both
//          sources normalize to the same dual-meter shape, the display strings
//          are the docs/16 §4.6 copy exactly, and no blended percentage exists.
// Part B — the recorder pre-flight module (UMD): blocked / warn / ok / unknown
//          per docs/03 §3.0 with the exact messages and the minutes estimate.
// Part C — wiring at source level: both meters rendered in the sidebar and on
//          the billing page; the recorder gates Start on the pre-flight; the
//          finalize and recovery quota paths offer the docs/03 §3.0 / docs/05
//          §6.1.3 options. The rendered meters are also read in the in-app
//          browser against the real server (recorded in docs/24).
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, 'extension', 'quotaPreflight.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const GiB = 1024 ** 3, MiB = 1024 ** 2;
const STORAGE_MSG = "You've reached your 5 GB free storage limit. Delete a video or upgrade to continue recording.";
const VIDEO_MSG = "You've reached your 50-video free limit. Delete a video or upgrade to continue recording.";
const NEAR_MSG = "You're close to your free limit — this may be one of your last recordings. Free up space or upgrade.";

(async () => {
  console.log('T-307 quota UX tests');
  const Q = await import(pathToFileURL(path.join(ROOT, 'client', 'src', 'lib', 'quotaMeters.js')).href);

  // ── A. Dual meters ───────────────────────────────────────────────────────
  console.log('\nA. Dual meters (client)');
  ok(Q.MSG_STORAGE_LIMIT === STORAGE_MSG && Q.MSG_VIDEO_LIMIT === VIDEO_MSG && Q.MSG_NEAR_LIMIT === NEAR_MSG, 'the three messages are the docs/16 §4.6 copy, exactly');
  ok(Q.fmtBytes(4.2 * GiB) === '4.2 GB' && Q.fmtBytes(5 * GiB) === '5 GB' && Q.fmtBytes(512 * MiB) === '512 MB' && Q.fmtBytes(1 * GiB) === '1 GB', 'bytes format as "4.2 GB", "5 GB", "512 MB"');
  ok(Q.storageDisplay(4.2 * GiB, 5 * GiB) === '4.2 GB / 5 GB', 'the storage reading is "4.2 GB / 5 GB" — the spec example');
  ok(Q.videosDisplay(38, 50) === '38 / 50' && Q.videosDisplay(38, null) === '38', 'the videos reading is "38 / 50", or just the count with no cap');

  const v1 = { storage: { usedBytes: 4.2 * GiB, reservedBytes: 0, limitBytes: 5 * GiB }, videos: { count: 38, reserved: 0, max: 50 }, recordingLimitSeconds: 600, maxUploadBytes: 512 * MiB, minStartBytes: 64 * MiB, model: 'v2' };
  const m1 = Q.normalizeUsage({ v1 });
  ok(m1.source === 'v1' && m1.storage.display === '4.2 GB / 5 GB' && m1.videos.display === '38 / 50', 'the v1 body normalizes to the dual-meter shape with the spec strings');
  ok(m1.limits.maxUploadBytes === 512 * MiB && m1.limits.minStartBytes === 64 * MiB, 'and carries the plan limits the pre-flight needs');
  const legacy = { storageUsedBytes: 1.5 * GiB, storageLimitBytes: 20 * GiB, storageLimitGB: 20, storagePercent: 7.5, videoCount: 12 };
  const m2 = Q.normalizeUsage({ legacy, plan: { maxVideos: 30, recordingLimitMinutes: 10 } });
  ok(m2.source === 'legacy' && m2.storage.display === '1.5 GB / 20 GB' && m2.videos.display === '12 / 30', 'the legacy summary + plan normalizes to the SAME shape');
  ok(Q.normalizeUsage({ v1, legacy }).source === 'v1', 'v1 wins when both are present');
  ok(Q.normalizeUsage({}) === null, 'nothing → null (meters hidden, never a guess)');
  for (const m of [m1, m2]) {
    ok(!('storagePercent' in m) && !('percent' in m) && !('percent' in m.storage) && !('percent' in m.videos), 'no blended or single percentage field anywhere in the shape');
  }
  ok(Q.meterRatio(4.2 * GiB, 5 * GiB) > 0.83 && Q.meterRatio(4.2 * GiB, 5 * GiB) < 0.85 && Q.meterRatio(5, 0) === 0, 'each meter has its OWN fill ratio');

  // Dashboard assessment.
  ok(Q.assessQuota(m1).blocked === null && Q.assessQuota(m1).nearLimit === false, '4.2/5 GiB leaves 0.8 GiB — a full 512 MiB take still fits, so no warning');
  const m47 = Q.normalizeUsage({ v1: { ...v1, storage: { usedBytes: 4.7 * GiB, reservedBytes: 0, limitBytes: 5 * GiB } } });
  ok(Q.assessQuota(m47).blocked === null && Q.assessQuota(m47).nearLimit === true && Q.assessQuota(m47).message === NEAR_MSG, '4.7/5 GiB → near limit (a full 512 MiB take may not fit), not blocked');
  const full = Q.normalizeUsage({ v1: { ...v1, storage: { usedBytes: 5 * GiB - 10 * MiB, reservedBytes: 0, limitBytes: 5 * GiB } } });
  ok(Q.assessQuota(full).blocked === 'storage' && Q.assessQuota(full).message === STORAGE_MSG, '10 MiB left (< 64 MiB floor) → blocked with the storage message');
  const capped = Q.normalizeUsage({ v1: { ...v1, storage: { usedBytes: 0, reservedBytes: 0, limitBytes: 5 * GiB }, videos: { count: 50, reserved: 0, max: 50 } } });
  ok(Q.assessQuota(capped).blocked === 'videos' && Q.assessQuota(capped).message === VIDEO_MSG, '50 of 50 videos → blocked with the video message');
  const near45 = Q.normalizeUsage({ v1: { ...v1, storage: { usedBytes: 0, reservedBytes: 0, limitBytes: 5 * GiB }, videos: { count: 45, reserved: 0, max: 50 } } });
  ok(Q.assessQuota(near45).nearLimit === true && Q.assessQuota(near45).blocked === null, '45 of 50 videos → near limit');
  const fine = Q.normalizeUsage({ v1: { ...v1, storage: { usedBytes: 1 * GiB, reservedBytes: 0, limitBytes: 5 * GiB }, videos: { count: 3, reserved: 0, max: 50 } } });
  ok(Q.assessQuota(fine).nearLimit === false && Q.assessQuota(fine).message === null, '1/5 GiB and 3/50 → nothing to say');
  ok(Q.assessQuota(null).blocked === null, 'no meters → no verdict');

  // ── B. Recorder pre-flight ───────────────────────────────────────────────
  console.log('\nB. Recorder pre-flight');
  ok(P.MSG_STORAGE_LIMIT === STORAGE_MSG && P.MSG_VIDEO_LIMIT === VIDEO_MSG && P.MSG_NEAR_LIMIT === NEAR_MSG, 'the recorder uses the same exact copy');
  ok(P.assess({ usage: null }).state === 'unknown' && P.assess({}).state === 'unknown', 'no usage → unknown (recording proceeds; the server enforces)');
  const U = (usedBytes, count, extra = {}) => ({ storage: { usedBytes, reservedBytes: 0, limitBytes: 5 * GiB }, videos: { count, reserved: 0, max: 50 }, maxUploadBytes: 512 * MiB, minStartBytes: 64 * MiB, ...extra });
  ok(P.assess({ usage: U(1 * GiB, 3) }).state === 'ok', 'plenty of room → ok');
  const b1 = P.assess({ usage: U(5 * GiB - 10 * MiB, 3) });
  ok(b1.state === 'blocked' && b1.reason === 'storage' && b1.message === STORAGE_MSG, 'under the 64 MiB floor → blocked, storage message');
  const b2 = P.assess({ usage: U(0, 50) });
  ok(b2.state === 'blocked' && b2.reason === 'videos' && b2.message === VIDEO_MSG, 'videos at the cap → blocked, video message');
  ok(P.assess({ usage: U(0, 49, { videos: { count: 49, reserved: 1, max: 50 } }) }).state === 'blocked', 'a reserved slot counts toward the cap');
  const w1 = P.assess({ usage: U(4.7 * GiB, 3), quality: 'high' });
  ok(w1.state === 'warn' && w1.reason === 'storage' && w1.message.startsWith(NEAR_MSG) && /about \d+ more minutes at this quality/.test(w1.message), 'under a full take of headroom → warn with the minutes that fit');
  const minsHigh = P.minutesThatFit(300 * MiB, 'high'), minsLow = P.minutesThatFit(300 * MiB, 'low');
  ok(w1.minutesThatFit === P.minutesThatFit(w1.available, 'high') && minsHigh < minsLow && minsHigh >= 9 && minsHigh <= 10, `the estimate follows the quality bitrate (300 MiB ≈ ${minsHigh} min high, ${minsLow} min low)`);
  ok(P.assess({ usage: U(0, 45) }).state === 'warn' && P.assess({ usage: U(0, 45) }).reason === 'videos', '45 of 50 videos → warn');
  ok(P.assess({ usage: U(0, 44) }).state === 'ok', '44 of 50 → ok');
  ok(P.assess({ usage: U(0, 0, { videos: { count: 999, reserved: 0, max: null } }) }).state === 'ok', 'no video cap → never blocked on videos');
  ok(P.BYTES_PER_SEC.high > P.BYTES_PER_SEC.medium && P.BYTES_PER_SEC.medium > P.BYTES_PER_SEC.low && P.BYTES_PER_SEC.high === Math.round((4_000_000 + 128_000) * 1.02 / 8), 'bytes/sec follow the docs/16 §1.1 derivation');

  // ── C. Wiring ────────────────────────────────────────────────────────────
  console.log('\nC. Wiring');
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const shell = read('client/src/components/AppShell.jsx');
  const billing = read('client/src/components/BillingCard.jsx');
  const meter = read('client/src/components/StorageMeter.jsx');
  const hook = read('client/src/hooks/useBilling.js');
  ok(/<DualMeters usage=\{usage\}/.test(shell) && !/plan\.maxVideos != null \?/.test(shell), 'the sidebar renders BOTH meters, always — no either/or');
  ok(/<StorageMeter usage=\{usage\}/.test(billing) && /<VideosMeter usage=\{usage\}/.test(billing) && !/label="Videos recorded" used=\{usage\.videoCount\} limit=\{null\}/.test(billing), 'the billing page renders both meters against their limits');
  ok(/data-meter="storage"/.test(meter) && /data-meter="videos"/.test(meter) && /usage\.storage\.display/.test(meter) && /usage\.videos\.display/.test(meter), 'each meter shows its own "x / y" reading from the module');
  ok(!/storagePercent/.test(meter) && !/storagePercent/.test(shell) && !/storagePercent/.test(billing), 'no component reads a blended percentage');
  ok(/\/api\/v1\/me\/usage/.test(hook) && /\/api\/me\/usage/.test(hook) && /normalizeUsage\(\{ v1, legacy, plan/.test(hook), 'the hook fetches v1 usage and falls back to the legacy summary through one normalizer');
  const rec = read('extension/recorder.js');
  const html = read('extension/recorder.html');
  const code = rec.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok(/quotaPreflight\.js/.test(html), 'recorder.html loads quotaPreflight.js');
  ok(/const quota = await loadQuotaPreflight\(\);\s*if \(quota\.state === 'blocked'\) \{ showQuotaBlocked\(quota\); return; \}/.test(code), 'the recorder gates Start on the pre-flight AFTER the recovery scan');
  ok(/if \(quota\.state === 'warn'\) overlayMsg\(/.test(code) && /startRecording\(\);\n\}\)\(\);/.test(code), 'near-limit warns and still records (T-503: starts through the machine)');
  ok(/if \(!res\.ok\) return \{ state: 'unknown' \}/.test(code), 'a usage fetch failure never blocks recording');
  ok(/mainBtn\.style\.display = 'none';\s*setStatus\(verdict\.message/.test(code) && /Manage videos/.test(rec) && /Upgrade/.test(rec) && /Check again/.test(rec), 'blocked: Start replaced by the exact message with Manage videos / Upgrade (and Check again)');
  ok(/showQuotaOptions\(\);/.test(code) && /Delete a video & retry/.test(rec) && /showDownloadFallback\(\);/.test(code.slice(code.indexOf('function showQuotaOptions'))), 'a quota refusal at finalize offers Save to device / Delete a video & retry / Upgrade');
  ok(/out\.kind === 'quota'/.test(code) && /Delete a video & retry/.test(rec) && /data-quota-action/.test(rec), 'the recovery card keeps Download / Delete a video & retry / Upgrade on a quota verdict (docs/05 §6.1.3)');
  ok(/assess\(\{ usage, quality: opts\.quality \}\)/.test(code), 'the minutes estimate uses the chosen quality');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
