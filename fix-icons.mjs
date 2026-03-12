// Fix PNG icons → RGBA using only Node.js built-ins
// Tauri requires all PNG icons to be RGBA (color type 6)

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { createDeflate, inflateSync, deflateSync } from 'zlib';

const ICONS_DIR = 'src-tauri/icons';
const PNG_SIG = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);

function readUInt32BE(buf, off) { return buf.readUInt32BE(off); }
function writeUInt32BE(buf, val, off) { buf.writeUInt32BE(val, off); }

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  const table = makeCRCTable();
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

let _crcTable = null;
function makeCRCTable() {
  if (_crcTable) return _crcTable;
  _crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    _crcTable[n] = c >>> 0;
  }
  return _crcTable;
}

function parseChunks(buf) {
  const chunks = [];
  let offset = 8; // skip PNG signature
  while (offset < buf.length) {
    const len = readUInt32BE(buf, offset);
    const type = buf.slice(offset + 4, offset + 8).toString('ascii');
    const data = buf.slice(offset + 8, offset + 8 + len);
    const crc = readUInt32BE(buf, offset + 8 + len);
    chunks.push({ len, type, data, crc, offset });
    offset += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}

function buildChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function convertRGBtoRGBA(pngBuf) {
  const chunks = parseChunks(pngBuf);

  const ihdrChunk = chunks.find(c => c.type === 'IHDR');
  if (!ihdrChunk) throw new Error('No IHDR chunk');

  const ihdr = Buffer.from(ihdrChunk.data);
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];

  // 6 = RGBA, already good
  if (colorType === 6) return null; // already RGBA
  // 4 = gray+alpha, also fine for alpha
  if (colorType === 4) return null;

  if (colorType !== 2 && colorType !== 0 && colorType !== 3) {
    console.log(`  Unknown color type ${colorType}, skipping`);
    return null;
  }

  // Decompress IDAT
  const idatChunks = chunks.filter(c => c.type === 'IDAT');
  const compressedData = Buffer.concat(idatChunks.map(c => c.data));
  const rawData = inflateSync(compressedData);

  let newRaw;
  if (colorType === 2) {
    // RGB → RGBA: add alpha=255 after each pixel
    const bytesPerRow = 1 + width * 3; // filter byte + RGB pixels
    const newBytesPerRow = 1 + width * 4;
    newRaw = Buffer.allocUnsafe(newBytesPerRow * height);

    for (let y = 0; y < height; y++) {
      const srcRow = rawData.slice(y * bytesPerRow, (y + 1) * bytesPerRow);
      const dstRow = newRaw.slice(y * newBytesPerRow, (y + 1) * newBytesPerRow);
      dstRow[0] = srcRow[0]; // filter byte
      for (let x = 0; x < width; x++) {
        dstRow[1 + x * 4 + 0] = srcRow[1 + x * 3 + 0]; // R
        dstRow[1 + x * 4 + 1] = srcRow[1 + x * 3 + 1]; // G
        dstRow[1 + x * 4 + 2] = srcRow[1 + x * 3 + 2]; // B
        dstRow[1 + x * 4 + 3] = 255;                    // A
      }
    }
  } else if (colorType === 0) {
    // Grayscale → RGBA
    const bytesPerRow = 1 + width;
    const newBytesPerRow = 1 + width * 4;
    newRaw = Buffer.allocUnsafe(newBytesPerRow * height);
    for (let y = 0; y < height; y++) {
      const srcRow = rawData.slice(y * bytesPerRow, (y + 1) * bytesPerRow);
      const dstRow = newRaw.slice(y * newBytesPerRow, (y + 1) * newBytesPerRow);
      dstRow[0] = srcRow[0];
      for (let x = 0; x < width; x++) {
        const g = srcRow[1 + x];
        dstRow[1 + x * 4 + 0] = g;
        dstRow[1 + x * 4 + 1] = g;
        dstRow[1 + x * 4 + 2] = g;
        dstRow[1 + x * 4 + 3] = 255;
      }
    }
  } else {
    // Palette mode (3) - more complex, skip for now
    console.log(`  Palette PNG - skipping complex conversion`);
    return null;
  }

  // Update IHDR: colorType → 6 (RGBA)
  const newIhdr = Buffer.from(ihdr);
  newIhdr[9] = 6;

  // Recompress
  const newCompressed = deflateSync(newRaw);

  // Rebuild PNG
  const parts = [PNG_SIG, buildChunk('IHDR', newIhdr)];
  for (const chunk of chunks) {
    if (chunk.type === 'IHDR' || chunk.type === 'IDAT' || chunk.type === 'IEND') continue;
    parts.push(buildChunk(chunk.type, chunk.data));
  }
  parts.push(buildChunk('IDAT', newCompressed));
  parts.push(buildChunk('IEND', Buffer.alloc(0)));

  return Buffer.concat(parts);
}

const files = readdirSync(ICONS_DIR).filter(f => f.endsWith('.png'));
for (const fname of files) {
  const p = join(ICONS_DIR, fname);
  const buf = readFileSync(p);

  try {
    const result = convertRGBtoRGBA(buf);
    if (result === null) {
      console.log(`✓ ${fname} — already RGBA`);
    } else {
      writeFileSync(p, result);
      console.log(`✅ ${fname} — converted to RGBA`);
    }
  } catch (e) {
    console.log(`⚠️  ${fname} — error: ${e.message}`);
  }
}

console.log('\nAll icons processed.');
