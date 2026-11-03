// Text from image: reads the text in screenshots and photos (OCR), ready to copy.
import fs from 'node:fs';
import path from 'node:path';
import { safeFileName, stripExtension } from '../../core/files.js';
import { createReader, readText } from './ocr.js';
import { LANGUAGES, parseOptions } from './options.js';

/** A message for a file Tesseract could not read. */
const describeError = (err) =>
  /unsupported image format|Input file contains unsupported|bad seek/i.test(err.message) ? 'Not an image this tool can read' : err.message;

export default {
  id: 'ocr',
  accepts: ['files'],
  parseOptions,

  async run(ctx) {
    ctx.stage('reading', 0);
    const reader = await createReader(LANGUAGES[ctx.options.lang]);
    const results = [];
    try {
      for (const [i, file] of ctx.files.entries()) {
        if (ctx.cancelled) return;
        try {
          results.push({ name: file.name, ...(await readText(reader, file.path)) });
        } catch (err) {
          ctx.log(`${file.name}: ${err.message}`);
          results.push({ name: file.name, error: describeError(err) });
        }
        ctx.progress((i + 1) / ctx.files.length);
        ctx.set({ results });
      }
    } finally {
      await reader.terminate();
    }

    const read = results.filter((r) => !r.error);
    if (!read.length) throw new Error(results.length === 1 ? results[0].error : 'None of the images could be read');

    // Also as a .txt: one image's text, or those with text under their names.
    const single = results.length === 1;
    const name = single ? safeFileName(stripExtension(results[0].name), 'text') : 'text';
    const text = single
      ? read[0].text
      : read
          .filter((r) => r.text)
          .map((r) => `── ${r.name} ──\n\n${r.text}`)
          .join('\n\n\n');
    fs.writeFileSync(path.join(ctx.outDir, `${name}.txt`), `${text}\n`);
  },
};
