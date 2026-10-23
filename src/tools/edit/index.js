// Edit image: crop, rotate, flip and resize one image.
import path from 'node:path';
import { safeFileName, stripExtension } from '../../core/files.js';
import { editImage } from './edit.js';
import { parseOptions } from './options.js';

export default {
  id: 'edit',
  accepts: ['file'],
  parseOptions,

  async run(ctx) {
    ctx.set({ attempt: 0 });
    ctx.stage('converting');
    const name = `${safeFileName(stripExtension(ctx.file.name), 'image')} (edited)`;
    const { width, height } = await editImage(ctx.file.path, path.join(ctx.outDir, name), ctx.options);
    ctx.set({ width, height });
  },
};
