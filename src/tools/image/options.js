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

/** Largest output side, in pixels (also what libvips handles comfortably). */
export const MAX_SIDE = 16384;

/** File extension for each output format. */
export const EXTENSIONS = { jpg: 'jpg', png: 'png', webp: 'webp', avif: 'avif', gif: 'gif', tiff: 'tiff' };

/** MIME type for each output format. */
export const MIME_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', tiff: 'image/tiff' };

/** Formats that keep every frame of an animation (the others take the first one). */
export const ANIMATED_FORMATS = ['webp', 'gif'];

const EDIT_OPTIONS = {
  rotate: ['0', '90', '180', '270'],
  flipH: ['0', '1'],
  flipV: ['0', '1'],
};
const EDIT_DEFAULTS = { rotate: '0', flipH: '0', flipV: '0' };

/** A whole number from `min` to `max`, or null when blank; a 400 for anything else. */
function wholeNumber(value, name, min, max) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw httpError(400, `${name} must be a whole number from ${min} to ${max}`);
  }
  return number;
}

/**
 * Allowed options plus `quality` (1–100) and the edits of a single image: rotation (degrees,
 * clockwise), flips, the crop (x, y, width, height in pixels of the image once oriented,
 * rotated and flipped, as the preview shows it) and an exact output size. Edits are optional.
 */
export function parseOptions(body = {}) {
  const options = pickAllowed(body, OPTIONS, DEFAULTS);
  const quality = body.quality == null || body.quality === '' ? DEFAULT_QUALITY : Number(body.quality);
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw httpError(400, 'Quality must be a whole number from 1 to 100');
  }

  const edits = pickAllowed(body, EDIT_OPTIONS, EDIT_DEFAULTS);
  const crop = ['cropX', 'cropY', 'cropWidth', 'cropHeight'].map((key, i) =>
    wholeNumber(body[key], key, i < 2 ? 0 : 1, MAX_SIDE * 4),
  );
  const given = crop.filter((value) => value != null).length;
  if (given && given < 4) throw httpError(400, 'The crop needs x, y, width and height');

  return {
    ...options,
    quality,
    rotate: Number(edits.rotate),
    flipH: edits.flipH === '1',
    flipV: edits.flipV === '1',
    crop: given ? { left: crop[0], top: crop[1], width: crop[2], height: crop[3] } : null,
    width: wholeNumber(body.width, 'width', 1, MAX_SIDE),
    height: wholeNumber(body.height, 'height', 1, MAX_SIDE),
  };
}

/** True when the options edit the picture itself (not just how it is saved). */
export const hasEdits = ({ rotate, flipH, flipV, crop, width, height }) =>
  Boolean(rotate || flipH || flipV || crop || width || height);

/**
 * The crop, checked against the image it applies to (`width`×`height`): it must lie inside it.
 * No crop means the whole image.
 */
export function resolveCrop(crop, width, height) {
  if (!crop) return { left: 0, top: 0, width, height };
  if (crop.left + crop.width > width || crop.top + crop.height > height) {
    throw new Error(`The crop goes outside the image (${width}×${height})`);
  }
  return crop;
}

/**
 * The output size for a crop: the one asked for (given one side, the other keeps the
 * proportions), or else the crop's own size, shrunk to fit `maxSide` when one is set.
 */
export function resolveSize(crop, width, height, maxSide = null) {
  if (width && height) return { width, height };
  if (width) return { width, height: Math.max(1, Math.round((crop.height * width) / crop.width)) };
  if (height) return { width: Math.max(1, Math.round((crop.width * height) / crop.height)), height };
  const scale = maxSide ? Math.min(1, maxSide / crop.width, maxSide / crop.height) : 1;
  return { width: Math.max(1, Math.round(crop.width * scale)), height: Math.max(1, Math.round(crop.height * scale)) };
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
