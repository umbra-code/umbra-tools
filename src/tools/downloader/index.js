// Media downloader: saves video or audio from a link with yt-dlp, a single video or a playlist.
import { listFiles } from '../../core/files.js';
import { cleanError, download, downloadPlaylist, formatArgs, sanitizeOptions } from './ytdlp.js';

export default {
  id: 'downloader',
  accepts: ['url'],
  parseOptions: sanitizeOptions,

  async run(ctx) {
    const format = formatArgs(ctx.options);
    if (ctx.options.playlist !== 'all') {
      await download(ctx, ctx.url, { dir: ctx.outDir, format });
      return;
    }

    // Every video is a result of its own, and all of them come as a zip named after the playlist.
    ctx.multipleOutputs = true;
    const { title, items, stderr } = await downloadPlaylist(ctx, ctx.url, { dir: ctx.outDir, format });
    if (ctx.cancelled) return;

    const downloaded = listFiles(ctx.outDir).length;
    if (!downloaded) throw new Error(cleanError(stderr));
    ctx.archiveName = title || 'playlist';
    ctx.set({ failed: items ? Math.max(items - downloaded, 0) : 0 });
  },
};
