// Edits one image with sharp: orient, rotate, flip, crop, resize, encode.
import sharp from '../../core/sharp.js';
import { encoderFor, EXTENSIONS, resolveFormat } from '../image/options.js';
import { MAX_SIDE, resolveCrop, resolveSize } from './options.js';

/**
 * Applies `options` (see parseOptions) to the image at `input` and writes it to `output`
 * (without extension; it is added from the format). Resolves with `{ file, format, width, height }`.
 *
 * Two passes, so the crop means exactly what the preview showed: first the picture is turned
 * upright (EXIF), rotated and flipped; then the crop and the resize apply to that result.
 */
export async function editImage(input, output, { rotate, flipH, flipV, crop, width, height, format }) {
  let info;
  try {
    info = await sharp(input).metadata();
  } catch (err) {
    throw new Error('Not an image this tool can read', { cause: err });
  }

  let oriented = sharp(input).rotate();
  if (rotate) oriented = oriented.rotate(rotate);
  if (flipH) oriented = oriented.flop();
  if (flipV) oriented = oriented.flip();
  const { data, info: raw } = await oriented.raw().toBuffer({ resolveWithObject: true });

  const area = resolveCrop(crop, raw.width, raw.height);
  const size = resolveSize(area, width, height);
  if (size.width > MAX_SIDE || size.height > MAX_SIDE) throw new Error(`The result can be at most ${MAX_SIDE} px on each side`);

  const outFormat = resolveFormat(info, format);
  let image = sharp(data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } })
    .extract(area)
    .resize(size.width, size.height, { fit: 'fill', kernel: 'lanczos3' });
  // JPEG has no transparency: put transparent areas on white instead of black.
  if (outFormat === 'jpg' && raw.channels === 4) image = image.flatten({ background: '#ffffff' });

  const [encoder, settings] = encoderFor(outFormat, 90);
  const file = `${output}.${EXTENSIONS[outFormat]}`;
  await image[encoder](settings).toFile(file);
  return { file, format: outFormat, ...size };
}
