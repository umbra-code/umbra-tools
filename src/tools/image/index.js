// Images: convert, resize and compress many images at once, or edit one (crop, rotate, flip)
// with a live preview of the exact result.
import fs from 'node:fs';
import path from 'node:path';
import { httpError } from '../../core/errors.js';
import { stripExtension } from '../../core/files.js';
import { convertImage, describeImageError, renderImage } from './convert.js';
import { EXTENSIONS, hasEdits, MIME_TYPES, parseOptions } from './options.js';

export default {
  id: 'image',
  accepts: ['files'],
  multipleOutputs: true,
  parseOptions,

  /**
   * The exact result for one kept upload, in memory, with its format, size and weight.
   * `signal` stops the work when the client no longer waits for it.
   */
  async preview(upload, options, { signal } = {}) {
    let result;
    try {
      result = await renderImage(upload.path, options, { signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw httpError(422, describeImageError(err, upload.name));
    }
    const { data, format, width, height, quality, scale } = result;
    return {
      data,
      contentType: MIME_TYPES[format],
      meta: {
        format,
        width,
        height,
        size: data.length,
        quality,
        scale,
        name: `${stripExtension(upload.name)}.${EXTENSIONS[format]}`,
      },
    };
  },

  async run(ctx) {
    // Edits are drawn on one picture; applied to a batch, the crop would land somewhere else on each.
    if (ctx.files.length > 1 && hasEdits(ctx.options)) throw new Error('Cropping, rotating and flipping work on one image at a time');

    ctx.archiveName = 'images';
    ctx.stage('converting', 0);

    // One result per input, in upload order; a file that fails does not stop the others.
    const results = [];
    for (const [i, file] of ctx.files.entries()) {
      if (ctx.cancelled) return;
      try {
        const { output, width, height, quality, scale } = await convertImage(file.path, file.name, ctx.outDir, ctx.options);
        results.push({ name: file.name, output: path.basename(output), size: fs.statSync(output).size, width, height, quality, scale });
      } catch (err) {
        ctx.log(`${file.name}: ${err.message}`);
        results.push({ name: file.name, error: describeImageError(err, file.name) });
      }
      ctx.progress((i + 1) / ctx.files.length);
      ctx.set({ results });
    }

    const failed = results.filter((r) => r.error);
    if (failed.length === results.length) {
      throw new Error(results.length === 1 ? failed[0].error : 'None of the files could be converted');
    }
  },
};
