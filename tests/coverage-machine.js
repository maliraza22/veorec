// Branch/block coverage of extension/machine.js under tests/machine.test.js,
// measured with V8's own precise coverage (NODE_V8_COVERAGE) — no extra
// tooling. Prints uncovered ranges (line:col → snippet) and the percentage of
// block ranges hit; exits 1 below the threshold (default 100).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'extension', 'machine.js');
const threshold = Number(process.env.MACHINE_COVERAGE_MIN || 100);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8cov-'));
const run = spawnSync(process.execPath, [path.join(__dirname, 'machine.test.js')], {
  env: { ...process.env, NODE_V8_COVERAGE: dir }, encoding: 'utf8',
});
process.stdout.write(run.stdout);
if (run.status !== 0) { console.error(run.stderr); process.exit(run.status || 1); }

const src = fs.readFileSync(TARGET, 'utf8');
// The suite loads machine.js twice: require() (file:// URL) and a vm sandbox
// (plain path) for the browser UMD branch. Identical source → identical
// ranges, so counts are merged per range.
const targetUrl = require('url').pathToFileURL(TARGET).href;
const scripts = [];
for (const f of fs.readdirSync(dir)) {
  const json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const s of json.result) if (s.url === targetUrl || s.url === TARGET || s.url.replace(/\\/g, '/') === TARGET.replace(/\\/g, '/')) scripts.push(s);
}
if (!scripts.length) { console.error('no coverage recorded for', TARGET); process.exit(1); }

// V8 reports NESTED block ranges; a zero-count range is dead in that run, and
// a block that ran is simply absorbed by its parent range (no separate entry).
// So the counts of the two copies cannot be merged by range key: instead each
// copy is expanded to a per-character count (inner ranges override outer),
// and a character is dead only if it is dead in EVERY copy.
const len = src.length;
const alive = new Uint8Array(len);
for (const s of scripts) {
  const counts = new Int32Array(len);
  const all = [];
  for (const fn of s.functions) for (const r of fn.ranges) all.push(r);
  all.sort((a, b) => (a.startOffset - b.startOffset) || (b.endOffset - a.endOffset));   // outer first
  for (const r of all) counts.fill(r.count, r.startOffset, Math.min(r.endOffset, len));
  for (let i = 0; i < len; i += 1) if (counts[i] > 0) alive[i] = 1;
}
// Every distinct zero-count range reported by any copy is a candidate block;
// it is dead only if no character inside it came alive in any copy.
const candidates = new Map();
for (const s of scripts) for (const fn of s.functions) for (const r of fn.ranges) candidates.set(`${r.startOffset}-${r.endOffset}`, r);
let total = 0, hit = 0;
const dead = [];
for (const r of candidates.values()) {
  total += 1;
  let live = false;
  for (let i = r.startOffset; i < Math.min(r.endOffset, len); i += 1) if (alive[i]) { live = true; break; }
  if (live) hit += 1; else dead.push(r);
}
const lineOf = (offset) => src.slice(0, offset).split('\n').length;
const pct = total ? (hit / total) * 100 : 100;
console.log(`\nmachine.js block coverage: ${hit}/${total} = ${pct.toFixed(2)}%`);
for (const r of dead) {
  const snippet = src.slice(r.startOffset, Math.min(r.endOffset, r.startOffset + 90)).replace(/\s+/g, ' ');
  console.log(`  UNCOVERED line ${lineOf(r.startOffset)}: ${snippet}`);
}
fs.rmSync(dir, { recursive: true, force: true });
process.exit(pct + 1e-9 >= threshold ? 0 : 1);
