// Media downloader: saves video or audio from a link with yt-dlp.
import { download, formatArgs, sanitizeOptions } from './ytdlp.js';

export default {
  id: 'downloader',
  accepts: ['url'],
  parseOptions: sanitizeOptions,

  async run(ctx) {
    await download(ctx, ctx.url, { dir: ctx.outDir, format: formatArgs(ctx.options) });
  },
};
