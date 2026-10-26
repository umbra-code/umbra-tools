// HEIC photos (iPhones save them by default). sharp reads what they say about themselves (size,
// EXIF) but cannot decode their pictures: those use HEVC, which its libvips leaves out over
// patents. libheif compiled to WebAssembly (heic-decode) decodes them instead, and the picture
// goes on as a PNG that sharp handles like any other image.
import fs from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import zlib from 'node:zlib';
import sharp from './sharp.js';

function decodeInWorker(buffer) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./heic-worker.js', import.meta.url), { workerData: buffer });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => code !== 0 && reject(new Error(`The HEIC decoder stopped (code ${code})`)));
  });
}

/**
 * A copy of the TIFF part of an EXIF block with its orientation set to "upright": libheif
 * already turns the picture as the file says, so the tag must not turn it a second time.
 */
export function uprightExif(tiff) {
  const exif = Buffer.from(tiff);
  const little = exif.toString('latin1', 0, 2) === 'II';
  const u16 = (at) => (little ? exif.readUInt16LE(at) : exif.readUInt16BE(at));
  const ifd = little ? exif.readUInt32LE(4) : exif.readUInt32BE(4);
  for (let i = 0, count = u16(ifd); i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (u16(entry) !== 0x0112) continue;
    if (little) exif.writeUInt16LE(1, entry + 8);
    else exif.writeUInt16BE(1, entry + 8);
  }
  return exif;
}

/** `png` with an eXIf chunk (raw TIFF EXIF) right after its header chunk. */
export function addPngExif(png, tiff) {
  const head = 8 + 25; // signature, then IHDR (length, type, 13 bytes of data, CRC)
  const type = Buffer.from('eXIf', 'latin1');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(tiff.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, tiff])));
  return Buffer.concat([png.subarray(0, head), length, type, tiff, crc, png.subarray(head)]);
}

/** The TIFF data inside an EXIF block, which may or may not start with "Exif\0\0"; null if none. */
function tiffOf(exif) {
  const start = [exif.indexOf('II*\0', 0, 'latin1'), exif.indexOf('MM\0*', 0, 'latin1')].filter((i) => i >= 0 && i <= 16);
  return start.length ? exif.subarray(Math.min(...start)) : null;
}

const heicInfo = async (input) => {
  const info = await sharp(input)
    .metadata()
    .catch(() => null);
  return info?.format === 'heif' && info.compression === 'hevc' ? info : null;
};

/** Whether `input` (a path or a buffer) is a HEIC photo, which sharp cannot decode by itself. */
export const isHeic = async (input) => Boolean(await heicInfo(input));

/**
 * `input` (a path or a buffer) ready for sharp: unchanged, unless it is a HEIC photo, which
 * comes back decoded as a PNG buffer, upright and with its EXIF (camera, GPS…) kept, so the
 * metadata option still decides whether that goes on to the result.
 */
export async function readableImage(input) {
  const info = await heicInfo(input);
  if (!info) return input;

  const buffer = Buffer.isBuffer(input) ? input : await fs.readFile(input);
  let picture;
  try {
    picture = await decodeInWorker(buffer);
  } catch {
    throw new Error('This HEIC photo could not be read');
  }
  const { width, height, data } = picture;
  let image = sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 } });
  if (!info.hasAlpha) image = image.removeAlpha();
  // Uncompressed: it is only passed on, so writing it fast matters more than its size.
  const png = await image.png({ compressionLevel: 0 }).toBuffer();
  const tiff = info.exif && tiffOf(info.exif);
  return tiff ? addPngExif(png, uprightExif(tiff)) : png;
}
