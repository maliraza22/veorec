// A play-button icon rendered in-process as a PNG (T-703, docs/09 §4 —
// the "play overlay" poster variant for Gmail/email embeds, where a static
// image links to the watch page). No font, no external asset: a translucent
// dark disc with a white triangle, encoded with zlib + a minimal PNG writer.
'use strict';

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/**
 * @param {number} size   square size in px (default 160)
 * @returns {Buffer} RGBA PNG
 */
function renderPlayIconPng(size = 160) {
  const S = Math.max(16, Math.round(size));
  const cx = S / 2, cy = S / 2, r = S * 0.48;
  // Triangle: slightly right of centre so it looks optically centred.
  const tw = S * 0.34, th = S * 0.40, tx = cx - tw * 0.38, ty = cy;
  const rows = [];
  for (let y = 0; y < S; y += 1) {
    const row = Buffer.alloc(1 + S * 4); row[0] = 0;   // filter: none
    for (let x = 0; x < S; x += 1) {
      const px = x + 0.5, py = y + 0.5;
      const d = Math.hypot(px - cx, py - cy);
      let R = 0, G = 0, B = 0, A = 0;
      if (d <= r) {
        const edge = Math.min(1, r - d);            // 1 px anti-alias on the disc edge
        A = Math.round(150 * edge); R = 20; G = 20; B = 24;
        // Triangle test: point in (tx,ty-th/2),(tx,ty+th/2),(tx+tw,ty)
        const u = (px - tx) / tw;                    // 0..1 across the triangle
        if (u >= 0 && u <= 1 && Math.abs(py - ty) <= (th / 2) * (1 - u)) { R = 255; G = 255; B = 255; A = 245; }
      }
      const o = 1 + x * 4; row[o] = R; row[o + 1] = G; row[o + 2] = B; row[o + 3] = A;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { renderPlayIconPng, crc32 };
