// Image converter options and encoder settings (pure, so they can be tested without images).
import { httpError } from '../../core/errors.js';
import { pickAllowed } from '../../core/input.js';

export const OPTIONS = {
  format: ['original', 'jpg', 'png', 'webp', 'avif'],
  maxSize: ['original', '3840', '2560', '1920', '1280', '800', '400'],
  metadata: ['remove', 'keep'],
};

export const DEFAULTS = {
  format: 'webp',
  maxSize: 'original',
  metadata: 'remove',
};

export const DEFAULT_QUALITY = 80;

/** File extension for each output format. */
export const EXTENSIONS = { jpg: 'jpg', png: 'png', webp: 'webp', avif: 'avif', gif: 'gif', tiff: 'tiff' };

/** Formats that keep every frame of an animation (the others take the first one). */
export const ANIMATED_FORMATS = ['webp', 'gif'];

/** Allowed options plus `quality` (1–100). */
export function parseOptions(body = {}) {
  const options = pickAllowed(body, OPTIONS, DEFAULTS);
  const quality = body.quality == null || body.quality === '' ? DEFAULT_QUALITY : Number(body.quality);
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw httpError(400, 'Quality must be a whole number from 1 to 100');
  }
  return { ...options, quality };
}

/**
 * The output format: the chosen one, or for "original" the input's own format
 * (formats that cannot be written back, like SVG or HEIC, become PNG).
 * `input` is what sharp's metadata() says: `{ format, compression }`.
 */
export function resolveFormat(input, chosen) {
  if (chosen !== 'original') return chosen;
  if (input.format === 'jpeg') return 'jpg';
  if (input.format === 'heif') return input.compression === 'av1' ? 'avif' : 'png';
  return EXTENSIONS[input.format] ? input.format : 'png';
}

/**
 * The sharp encoder and its settings for `format` at `quality` (1–100, like JPEG's scale).
 * PNG, GIF and TIFF are lossless here, so the quality does not apply.
 */
export function encoderFor(format, quality) {
  switch (format) {
    case 'jpg':
      return ['jpeg', { quality, mozjpeg: true }];
    case 'webp':
      return ['webp', { quality, effort: 5 }];
    case 'avif':
      // AVIF's scale is harsher: its default of 50 looks about like JPEG at 80.
      return ['avif', { quality: Math.max(1, Math.round(quality * 0.625)), effort: 4 }];
    case 'png':
      return ['png', { compressionLevel: 9, effort: 7 }];
    case 'gif':
      return ['gif', { effort: 7 }];
    default:
      return ['tiff', { compression: 'lzw' }];
  }
}
