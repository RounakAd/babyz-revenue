#!/usr/bin/env node
/* ==========================================================================
   Babyz Pizza — invoice logo builder
   --------------------------------------------------------------------------
   Turns the big source logo PNG into `assets/logo.js`:

       window.BABYZ_LOGO = 'data:image/png;base64,...';

   WHY a data URI instead of just linking the .png:

     The invoice is drawn on a <canvas>, and the PNG/PDF downloads read that
     canvas back with toDataURL(). When you open index.html straight off disk
     (file://) the browser treats a file:// image as cross-origin, so drawing
     it would TAINT the canvas and every download would fail with
     "Tainted canvases may not be exported".

     A data: URI is treated as same-origin, so the canvas stays clean, nothing
     is requested over the network, and the invoice works identically on
     file://, on localhost and on GitHub Pages. The cost is that the image has
     to be small, which is why this script downscales it first.

   Zero dependencies — Node's own zlib does the compression and the PNG
   decode/encode (unfilter + box-resample + filter + deflate) is right here.

   USAGE
     node tools/make-logo.js 1000485959.png 384
     node tools/make-logo.js <source.png> [edge-pixels]
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'assets', 'logo.js');

/* ------------------------------------------------------------------ crc32 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ------------------------------------------------------------ png reading */
function parsePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504E47) throw new Error('not a PNG');

  let off = 8;
  const idat = [];
  let header = null;

  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('latin1');
    const data = buf.slice(off + 8, off + 8 + len);

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12]
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  if (!header) throw new Error('no IHDR');
  if (header.bitDepth !== 8) throw new Error('only 8-bit PNGs are supported (got ' + header.bitDepth + ')');
  if (header.interlace !== 0) throw new Error('interlaced PNGs are not supported');
  if (header.colorType !== 2 && header.colorType !== 6) {
    throw new Error('only RGB (2) and RGBA (6) PNGs are supported (got ' + header.colorType + ')');
  }

  const channels = header.colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  const out = Buffer.alloc(header.height * stride);

  let pos = 0;
  for (let y = 0; y < header.height; y++) {
    const filter = raw[pos++];
    const line = raw.slice(pos, pos + stride);
    pos += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y ? out.slice((y - 1) * stride, y * stride) : null;
    unfilter(filter, line, cur, prev, channels, y === 0);
  }

  return { width: header.width, height: header.height, channels, pixels: out };
}

function unfilter(filter, line, out, prev, bpp, firstRow) {
  for (let i = 0; i < line.length; i++) {
    const x = line[i];
    const a = i >= bpp ? out[i - bpp] : 0;          /* left  */
    const b = firstRow ? 0 : prev[i];               /* up    */
    const c = (firstRow || i < bpp) ? 0 : prev[i - bpp]; /* up-left */

    let v;
    switch (filter) {
      case 0: v = x; break;
      case 1: v = x + a; break;
      case 2: v = x + b; break;
      case 3: v = x + ((a + b) >> 1); break;
      case 4: v = x + paeth(a, b, c); break;
      default: throw new Error('unknown filter type ' + filter);
    }
    out[i] = v & 0xFF;
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/* ------------------------------------------------------------ box resample
   Area-average downscale: every destination pixel is the weighted average of
   the source pixels its footprint covers, so a non-integer ratio (1254 -> 384)
   still resamples cleanly. Anything with an alpha channel is composited onto
   white on the way, because that is what the invoice is printed on. */
function boxResize(img, dstW, dstH) {
  const { width: sw, height: sh, channels: ch, pixels } = img;
  const hasAlpha = ch === 4;
  const out = Buffer.alloc(dstW * dstH * 3);
  const xRatio = sw / dstW, yRatio = sh / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    const sy0 = dy * yRatio, sy1 = (dy + 1) * yRatio;
    const yStart = Math.floor(sy0), yEnd = Math.min(Math.ceil(sy1), sh);

    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = dx * xRatio, sx1 = (dx + 1) * xRatio;
      const xStart = Math.floor(sx0), xEnd = Math.min(Math.ceil(sx1), sw);

      let r = 0, g = 0, b = 0, a = 0, total = 0;
      for (let y = yStart; y < yEnd; y++) {
        /* vertical overlap of this source row with the destination footprint */
        const wy = Math.min(y + 1, sy1) - Math.max(y, sy0);
        if (wy <= 0) continue;
        for (let x = xStart; x < xEnd; x++) {
          const wx = Math.min(x + 1, sx1) - Math.max(x, sx0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (y * sw + x) * ch;
          const alpha = hasAlpha ? pixels[i + 3] / 255 : 1;
          r += pixels[i] * alpha * w;
          g += pixels[i + 1] * alpha * w;
          b += pixels[i + 2] * alpha * w;
          a += alpha * w;
          total += w;
        }
      }

      /* un-premultiply, then lay whatever is left over a white page */
      const cover = total ? a / total : 0;
      const flat = (sum) => cover > 0 ? Math.round((sum / total / cover) * cover + 255 * (1 - cover)) : 255;

      const o = (dy * dstW + dx) * 3;
      out[o] = flat(r);
      out[o + 1] = flat(g);
      out[o + 2] = flat(b);
    }
  }
  return { width: dstW, height: dstH, channels: 3, pixels: out };
}

/* If practically every pixel has equal channels the artwork is greyscale, and
   storing one byte instead of three cuts the file a lot. A handful of stray
   pixels is allowed — scans and exports carry colour noise along their edges. */
function isGreyscale(img) {
  let noisy = 0, count = 0;
  for (let i = 0; i < img.pixels.length; i += img.channels) {
    count++;
    const r = img.pixels[i], g = img.pixels[i + 1], b = img.pixels[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 8) noisy++;
  }
  return noisy / count < 0.001;
}

function toGreyscale(img) {
  const n = img.width * img.height;
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const o = i * img.channels;
    out[i] = Math.round((img.pixels[o] * 299 + img.pixels[o + 1] * 587 + img.pixels[o + 2] * 114) / 1000);
  }
  return { width: img.width, height: img.height, channels: 1, pixels: out };
}

/* ------------------------------------------------------------ png writing */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(img) {
  const grey = img.channels === 1;
  const bpp = grey ? 1 : 3;
  const stride = img.width * bpp;
  const raw = Buffer.alloc((stride + 1) * img.height);

  const cur = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];

  for (let y = 0; y < img.height; y++) {
    const src = img.pixels.slice(y * img.width * img.channels, (y + 1) * img.width * img.channels);
    for (let x = 0; x < img.width; x++) {
      if (grey) {
        /* the three channels are already known to be equal */
        cur[x] = src[x * img.channels];
      } else {
        cur[x * 3] = src[x * img.channels];
        cur[x * 3 + 1] = src[x * img.channels + 1];
        cur[x * 3 + 2] = src[x * img.channels + 2];
      }
    }

    /* pick the filter with the smallest sum of absolute signed residuals */
    let best = 0, bestScore = Infinity;
    for (let f = 0; f < 3; f++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = y ? prev[i] : 0;
        const v = f === 0 ? cur[i] : f === 1 ? cur[i] - a : cur[i] - b;
        const byte = v & 0xFF;
        cand[f][i] = byte;
        score += byte < 128 ? byte : 256 - byte;
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }

    raw[y * (stride + 1)] = best;
    cand[best].copy(raw, y * (stride + 1) + 1);
    cur.copy(prev);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;                    /* bit depth   */
  ihdr[9] = grey ? 0 : 2;         /* 0 = greyscale, 2 = truecolour */
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* -------------------------------------------------------------------- main */
const srcArg = process.argv[2] || '1000485959.png';
const edge = parseInt(process.argv[3] || '384', 10);
const srcFile = path.isAbsolute(srcArg) ? srcArg : path.join(ROOT, srcArg);

if (!fs.existsSync(srcFile)) {
  console.error('Source image not found: ' + srcFile);
  process.exit(1);
}
if (!(edge > 16 && edge <= 2048)) {
  console.error('Edge must be between 17 and 2048 pixels.');
  process.exit(1);
}

const original = fs.readFileSync(srcFile);
const decoded = parsePng(original);

/* keep the aspect ratio if the source is not square */
const scale = edge / Math.max(decoded.width, decoded.height);
const dstW = Math.max(1, Math.round(decoded.width * scale));
const dstH = Math.max(1, Math.round(decoded.height * scale));

const resized0 = boxResize(decoded, dstW, dstH);
const grey = isGreyscale(resized0);
const resized = grey ? toGreyscale(resized0) : resized0;
const encoded = encodePng(resized);
const base64 = encoded.toString('base64');

const banner =
  '/* Babyz Pizza - invoice logo, embedded as a data URI.\n' +
  '   Generated by tools/make-logo.js - do not hand-edit.\n' +
  '   Source: ' + path.basename(srcFile) + ' (' + decoded.width + 'x' + decoded.height + ') -> ' +
  dstW + 'x' + dstH + ' ' + (grey ? 'greyscale' : 'colour') + ', ' + Math.round(encoded.length / 1024) + ' KB.\n' +
  '   Embedded (not linked) because a linked file:// image would taint the\n' +
  '   canvas and break the invoice PDF/PNG download. */\n';

fs.writeFileSync(
  OUT_FILE,
  banner + 'window.BABYZ_LOGO = "data:image/png;base64,' + base64 + '";\n',
  'utf8'
);

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('source   :', path.basename(srcFile), decoded.width + 'x' + decoded.height, kb(original.length));
console.log('resized  :', dstW + 'x' + dstH, grey ? '(greyscale)' : '(colour)', '->', kb(encoded.length));
console.log('written  :', path.relative(ROOT, OUT_FILE), kb(fs.statSync(OUT_FILE).size), '(base64)');
