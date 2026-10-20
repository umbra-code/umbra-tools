// Image converter: convert, resize and compress one or many images at once.
import fs from 'node:fs';
import path from 'node:path';
import { convertImage, describeImageError } from './convert.js';
import { parseOptions } from './options.js';

export default {
  id: 'image',
  accepts: ['files'],
  multipleOutputs: true,
  parseOptions,

  async run(ctx) {
    ctx.archiveName = 'images';
    ctx.stage('converting', 0);

    // One result per input, in upload order; a file that fails does not stop the others.
    const results = [];
    for (const [i, file] of ctx.files.entries()) {
      if (ctx.cancelled) return;
      try {
        const { output, width, height } = await convertImage(file.path, file.name, ctx.outDir, ctx.options);
        results.push({ name: file.name, output: path.basename(output), size: fs.statSync(output).size, width, height });
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
