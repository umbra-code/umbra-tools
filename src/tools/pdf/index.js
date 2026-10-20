// PDF tool: merge PDFs, turn images into a PDF, or extract pages.
import fs from 'node:fs/promises';
import path from 'node:path';
import { safeFileName, stripExtension } from '../../core/files.js';
import { extractPages, imagesToPdf, mergePdfs } from './pdf.js';
import { parseOptions } from './options.js';

/** "1-3, 5, 8-" → "pages 1-3, 5, 8-end", for the output name. */
const describeRanges = (ranges) =>
  `pages ${ranges.map(({ from, to }) => (to === from ? `${from}` : `${from}-${to ?? 'end'}`)).join(', ')}`;

export default {
  id: 'pdf',
  accepts: ['files'],
  parseOptions,

  async run(ctx) {
    const { files, options } = ctx;
    const first = safeFileName(stripExtension(files[0].name), 'document');
    const onFile = (i) => ctx.progress((i + 1) / files.length);
    ctx.stage('converting', 0);

    let name;
    let bytes;
    if (options.mode === 'merge') {
      if (files.length < 2) throw new Error('Add at least two PDFs to merge');
      name = `${first} (merged)`;
      bytes = await mergePdfs(files, { onFile });
    } else if (options.mode === 'images') {
      name = files.length === 1 ? first : `${first} (+${files.length - 1} images)`;
      bytes = await imagesToPdf(files, options.pageSize, { onFile });
    } else {
      if (files.length > 1) throw new Error('Extract pages from one PDF at a time');
      ({ bytes } = await extractPages(files[0], options.ranges));
      name = `${first} (${describeRanges(options.ranges)})`;
    }

    if (ctx.cancelled) return;
    await fs.writeFile(path.join(ctx.outDir, `${safeFileName(name, 'document')}.pdf`), bytes);
  },
};
