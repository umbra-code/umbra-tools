// Reads text from images with Tesseract (tesseract.js: WebAssembly, in its own worker thread).
// The language models come as npm packages (@tesseract.js-data/*), so nothing is downloaded.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createWorker } from 'tesseract.js';
import { readableImage } from '../../core/heic.js';
import { TEMP_ROOT } from '../../core/paths.js';
import sharp from '../../core/sharp.js';
import { tidyText, upscaleFactor } from './options.js';

const require = createRequire(import.meta.url);
const MODELS_DIR = path.join(TEMP_ROOT, 'tessdata');

/**
 * A folder with the models for `langs`. tesseract.js reads every language from one folder,
 * while each package keeps its own, so they are copied together (into the temp folder, which
 * is wiped on startup; it only takes a moment).
 */
function modelsFor(langs) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  for (const lang of langs) {
    const target = path.join(MODELS_DIR, `${lang}.traineddata.gz`);
    if (fs.existsSync(target)) continue;
    // "best_int": the fast LSTM model, as good as the full one for printed and on-screen text.
    const pkg = path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
    fs.copyFileSync(path.join(pkg, '4.0.0_best_int', `${lang}.traineddata.gz`), target);
  }
  return MODELS_DIR;
}

/** A Tesseract worker for `langs` (e.g. ['spa', 'eng']); terminate it when done. */
export async function createReader(langs) {
  // cacheMethod 'none': it would otherwise write the models into the current folder.
  return createWorker(langs, 1, { langPath: modelsFor(langs), gzip: true, cacheMethod: 'none' });
}

/**
 * The picture as Tesseract reads best: upright, in greys (transparent areas on white), dark
 * text on a light background (screenshots in dark mode are inverted) and small ones enlarged.
 */
export async function prepareForOcr(input) {
  const readable = await readableImage(input);
  const upright = await sharp(readable).rotate().flatten({ background: '#ffffff' }).greyscale().png().toBuffer();
  const [{ width }, stats] = await Promise.all([sharp(upright).metadata(), sharp(upright).stats()]);
  let image = sharp(upright);
  if (stats.channels[0].mean < 128) image = image.negate();
  const factor = upscaleFactor(width);
  if (factor > 1) image = image.resize({ width: Math.round(width * factor), kernel: 'lanczos3' });
  return image.toColourspace('b-w').png().toBuffer();
}

/** Reads the text in `input` (a path or buffer) with `reader`: `{ text, confidence }` (0–100). */
export async function readText(reader, input) {
  const { data } = await reader.recognize(await prepareForOcr(input));
  return { text: tidyText(data.text), confidence: Math.round(data.confidence) };
}
