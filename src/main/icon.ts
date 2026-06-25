import { nativeImage, NativeImage } from 'electron';
import * as zlib from 'zlib';

// Generate a small solid-rounded PNG at runtime so we ship no binary assets and
// can theme the tray/app icon to the accent colour.

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** size x size RGBA PNG filled with the given hex colour, with rounded corners. */
export function makeIcon(size: number, hex: string): NativeImage {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const radius = Math.floor(size * 0.28);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter byte
    for (let x = 0; x < size; x++) {
      const off = y * (size * 4 + 1) + 1 + x * 4;
      const inCorner =
        (x < radius && y < radius && (radius - x) ** 2 + (radius - y) ** 2 > radius ** 2) ||
        (x >= size - radius && y < radius && (x - (size - radius)) ** 2 + (radius - y) ** 2 > radius ** 2) ||
        (x < radius && y >= size - radius && (radius - x) ** 2 + (y - (size - radius)) ** 2 > radius ** 2) ||
        (x >= size - radius && y >= size - radius && (x - (size - radius)) ** 2 + (y - (size - radius)) ** 2 > radius ** 2);
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = inCorner ? 0 : 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return nativeImage.createFromBuffer(png);
}
