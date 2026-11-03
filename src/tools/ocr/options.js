// Text from image options (pure, so they can be tested without the OCR engine).
import { pickAllowed } from '../../core/input.js';

/** The languages offered, as the Tesseract models each choice loads. */
export const LANGUAGES = {
  'spa+eng': ['spa', 'eng'],
  spa: ['spa'],
  eng: ['eng'],
};

export const OPTIONS = { lang: Object.keys(LANGUAGES) };
export const DEFAULTS = { lang: 'spa+eng' };

export const parseOptions = (body = {}) => pickAllowed(body, OPTIONS, DEFAULTS);

/**
 * Tesseract's text, tidied for pasting: no trailing spaces, at most one empty line in a row,
 * nothing before or after.
 */
export const tidyText = (text) =>
  text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * How much to enlarge an image of `width` px before reading it: Tesseract reads small text far
 * better once enlarged (screenshots are often ~1000 px wide), up to 3×. Big images stay as they are.
 */
export const upscaleFactor = (width, target = 1600) => (width >= target ? 1 : Math.min(3, target / width));
