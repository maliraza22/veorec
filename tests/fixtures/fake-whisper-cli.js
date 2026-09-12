#!/usr/bin/env node
// A fake whisper-cli (T-603 tests): honours the argument contract the worker
// uses — `-m model -f wav -oj -of prefix -np [-t n] [-l lang]` — and writes
// `<prefix>.json` in whisper.cpp's shape (offsets in ms). Set
// FAKE_WHISPER_FAIL=1 to exit non-zero. Windows spawns it through node, so the
// worker is pointed at it via WHISPER_BIN=node + WHISPER_ARGS_PREFIX… no:
// the worker spawns WHISPER_BIN directly, so tests point WHISPER_BIN at a .cmd
// shim that runs this file (see tests/stt.test.js).
'use strict';

const fs = require('fs');

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
if (process.env.FAKE_WHISPER_FAIL === '1') { process.stderr.write('fake whisper: forced failure\n'); process.exit(3); }
const wav = get('-f'), prefix = get('-of'), lang = get('-l') || 'auto';
if (!wav || !fs.existsSync(wav) || !prefix || !args.includes('-oj')) { process.stderr.write('fake whisper: bad args ' + args.join(' ') + '\n'); process.exit(2); }
const out = {
  params: { language: lang },
  result: { language: lang === 'auto' ? 'en' : lang },
  transcription: [
    { offsets: { from: 0, to: 1500 }, text: ' whisper cpp segment one' },
    { offsets: { from: 1500, to: 3200 }, text: ' whisper cpp segment two' },
  ],
};
fs.writeFileSync(`${prefix}.json`, JSON.stringify(out));
process.stdout.write('fake whisper ok\n');
