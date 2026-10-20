// Converts one image with sharp.
import fs from 'node:fs';
import path from 'node:path';
import sharp from '../../core/sharp.js';
import { safeFileName, stripExtension, uniquePath } from '../../core/files.js';
import { ANIMATED_FORMATS, encoderFor, EXTENSIONS, resolveFormat } from './options.js';

/**
 * Converts the image at `input` (named `name`) into `outDir` with the parsed `options`.
 * Resolves with `{ output, format, width, height }`; rejects when it is not a readable image.
 */
export async function convertImage(input, name, outDir, { format, quality, maxSize, metadata }) {
  const info = await sharp(input).metadata();
  const outFormat = resolveFormat(info, format);
  const animated = (info.pages ?? 1) > 1 && ANIMATED_FORMATS.includes(outFormat);

  let image = sharp(input, { animated })
    // Phone photos are often stored sideways with an EXIF orientation tag: apply it for real.
    .rotate();
  if (maxSize !== 'original') {
    const size = Number(maxSize);
    image = image.resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true });
  }
  // JPEG has no transparency: put transparent areas on white instead of black.
  if (outFormat === 'jpg' && info.hasAlpha) image = image.flatten({ background: '#ffffff' });
  // By default sharp drops EXIF (camera, GPS location…) and XMP; "keep" carries them over.
  if (metadata === 'keep') image = image.keepMetadata();

  const [encoder, settings] = encoderFor(outFormat, quality);
  const output = uniquePath(outDir, safeFileName(stripExtension(name), 'image'), EXTENSIONS[outFormat]);
  try {
    const result = await image[encoder](settings).toFile(output);
    return { output, format: outFormat, width: result.width, height: result.pageHeight ?? result.height };
  } catch (err) {
    fs.rmSync(output, { force: true });
    throw err;
  }
}

/** A message for the user when sharp cannot read or write an image. */
export function describeImageError(err, name) {
  const unsupported = /unsupported image format|bad seek|Input file contains unsupported/i.test(err.message);
  const ext = path.extname(name).toLowerCase();
  if (['.heic', '.heif'].includes(ext)) return 'HEIC photos are not supported yet; export them as JPEG first';
  return unsupported ? 'Not an image this tool can read' : err.message;
}
