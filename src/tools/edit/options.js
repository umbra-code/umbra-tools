// Edit image options (pure, so they can be tested without images).
import { httpError } from '../../core/errors.js';
import { pickAllowed } from '../../core/input.js';

export const OPTIONS = {
  rotate: ['0', '90', '180', '270'],
  flipH: ['0', '1'],
  flipV: ['0', '1'],
  format: ['original', 'jpg', 'png', 'webp', 'avif'],
};

export const DEFAULTS = {
  rotate: '0',
  flipH: '0',
  flipV: '0',
  format: 'original',
};

/** Largest output side, in pixels (also what libvips handles comfortably). */
export const MAX_SIDE = 16384;

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
 * Rotation (degrees, clockwise), flips, the crop (x, y, width, height in pixels of the image
 * once oriented, rotated and flipped, as the preview shows it), the output size and format.
 * The crop and the size are optional.
 */
export function parseOptions(body = {}) {
  const options = pickAllowed(body, OPTIONS, DEFAULTS);

  const crop = ['cropX', 'cropY', 'cropWidth', 'cropHeight'].map((key, i) =>
    wholeNumber(body[key], key, i < 2 ? 0 : 1, MAX_SIDE * 4),
  );
  const given = crop.filter((value) => value != null).length;
  if (given && given < 4) throw httpError(400, 'The crop needs x, y, width and height');

  return {
    rotate: Number(options.rotate),
    flipH: options.flipH === '1',
    flipV: options.flipV === '1',
    format: options.format,
    crop: given ? { left: crop[0], top: crop[1], width: crop[2], height: crop[3] } : null,
    width: wholeNumber(body.width, 'width', 1, MAX_SIDE),
    height: wholeNumber(body.height, 'height', 1, MAX_SIDE),
  };
}

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
 * The output size: the one asked for, or the crop's. Given only one side, the other keeps
 * the crop's proportions.
 */
export function resolveSize(crop, width, height) {
  if (width && height) return { width, height };
  if (width) return { width, height: Math.max(1, Math.round((crop.height * width) / crop.width)) };
  if (height) return { width: Math.max(1, Math.round((crop.width * height) / crop.height)), height };
  return { width: crop.width, height: crop.height };
}
