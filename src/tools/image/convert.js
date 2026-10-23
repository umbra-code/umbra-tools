// Renders one image with sharp: orient, edit (rotate, flip, crop, resize), encode.
import fs from 'node:fs';
import path from 'node:path';
import sharp from '../../core/sharp.js';
import { safeFileName, stripExtension, uniquePath } from '../../core/files.js';
import {
  ANIMATED_FORMATS,
  encoderFor,
  EXTENSIONS,
  hasEdits,
  MAX_SIDE,
  resolveCrop,
  resolveFormat,
  resolveSize,
} from './options.js';

/**
 * Renders the image at `input` with the parsed `options`, in memory.
 * Resolves with `{ data, format, width, height }`; rejects when it is not a readable image.
 *
 * Without edits, it is one pass (and animations survive as webp or gif). With edits it is
 * two, so the crop means exactly what the preview showed: first the picture is turned upright
 * (EXIF), rotated and flipped; then the crop and the resize apply to that result.
 */
export async function renderImage(input, options) {
  const { format, quality, maxSize, metadata, rotate, flipH, flipV, crop, width, height } = options;
  const info = await sharp(input).metadata();
  const outFormat = resolveFormat(info, format);
  const keep = metadata === 'keep';
  const maxSide = maxSize === 'original' ? null : Number(maxSize);

  let image;
  if (!hasEdits(options)) {
    const animated = (info.pages ?? 1) > 1 && ANIMATED_FORMATS.includes(outFormat);
    // Phone photos are often stored sideways with an EXIF orientation tag: apply it for real.
    image = sharp(input, { animated }).rotate();
    if (maxSide) image = image.resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true });
  } else {
    let oriented = sharp(input).rotate();
    if (rotate) oriented = oriented.rotate(rotate);
    if (flipH) oriented = oriented.flop();
    if (flipV) oriented = oriented.flip();
    // Lossless and fast in between; PNG also carries the metadata over when it is kept.
    if (keep) oriented = oriented.keepMetadata();
    const { data, info: upright } = await oriented.png({ compressionLevel: 0 }).toBuffer({ resolveWithObject: true });

    const area = resolveCrop(crop, upright.width, upright.height);
    const size = resolveSize(area, width, height, maxSide);
    if (size.width > MAX_SIDE || size.height > MAX_SIDE) throw new Error(`The result can be at most ${MAX_SIDE} px on each side`);
    image = sharp(data).extract(area).resize(size.width, size.height, { fit: 'fill', kernel: 'lanczos3' });
  }

  // JPEG has no transparency: put transparent areas on white instead of black.
  if (outFormat === 'jpg' && info.hasAlpha) image = image.flatten({ background: '#ffffff' });
  // By default sharp drops EXIF (camera, GPS location…) and XMP; "keep" carries them over.
  if (keep) image = image.keepMetadata();

  const [encoder, settings] = encoderFor(outFormat, quality);
  const { data, info: out } = await image[encoder](settings).toBuffer({ resolveWithObject: true });
  return { data, format: outFormat, width: out.width, height: out.pageHeight ?? out.height };
}

/**
 * Converts the image at `input` (named `name`) into `outDir` with the parsed `options`.
 * Resolves with `{ output, format, width, height }`; rejects when it is not a readable image.
 */
export async function convertImage(input, name, outDir, options) {
  const { data, format, width, height } = await renderImage(input, options);
  const output = uniquePath(outDir, safeFileName(stripExtension(name), 'image'), EXTENSIONS[format]);
  fs.writeFileSync(output, data);
  return { output, format, width, height };
}

/** A message for the user when sharp cannot read or write an image. */
export function describeImageError(err, name) {
  const unsupported = /unsupported image format|bad seek|Input file contains unsupported/i.test(err.message);
  const ext = path.extname(name).toLowerCase();
  if (['.heic', '.heif'].includes(ext)) return 'HEIC photos are not supported yet; export them as JPEG first';
  return unsupported ? 'Not an image this tool can read' : err.message;
}
