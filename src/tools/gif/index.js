// Video → GIF: turns a time range of an uploaded video, or of a link, into a GIF or animated WebP.
import path from 'node:path';
import { BINARIES } from '../../core/paths.js';
import { largestFile, safeFileName, stripExtension } from '../../core/files.js';
import { ffmpegError, ffmpegProgress, probeMedia } from '../../core/media.js';
import { formatTime } from '../../core/time.js';
import { download } from '../downloader/ytdlp.js';
import { animationLength, buildFfmpegArgs, parseOptions } from './options.js';

/** Length of the video in seconds; throws when the file has no video stream. */
async function probeDuration(ctx, file) {
  const media = await probeMedia(ctx, file);
  if (!media.hasVideo) throw new Error('The file does not look like a video');
  return media.duration;
}

/** The clip to convert: the uploaded file, or just the selected range of the link. */
async function getSource(ctx) {
  const { start, end } = ctx.options;

  if (ctx.file) {
    const length = await probeDuration(ctx, ctx.file.path);
    if (start >= length) throw new Error(`The start is past the end of the video (${formatTime(length)})`);
    return { input: ctx.file.path, name: stripExtension(ctx.file.name), seek: start };
  }

  // Only the selected range is downloaded, cut on exact frames: much faster than the whole video.
  await download(ctx, ctx.url, {
    dir: ctx.workDir,
    format: ['-f', 'bv*[height<=1080]/b[height<=1080]/bv*/b'],
    extra: ['--download-sections', `*${start}-${end}`, '--force-keyframes-at-cuts'],
  });
  const input = largestFile(ctx.workDir);
  if (!input) throw new Error('The clip could not be downloaded');
  // "Title [id].mp4" → "Title"
  const name = stripExtension(path.basename(input)).replace(/\s*\[[^\]]+\]$/, '');
  return { input, name, seek: 0 };
}

export default {
  id: 'gif',
  accepts: ['url', 'file'],
  parseOptions,

  async run(ctx) {
    const { start, end, format } = ctx.options;
    const duration = end - start;
    const length = animationLength(duration, ctx.options);
    const { input, name, seek } = await getSource(ctx);
    if (ctx.cancelled) return;

    // ffmpeg reports progress while it writes frames, but a GIF is only written once its
    // palette is ready (at the very end), so its progress is shown as indeterminate. So is
    // a reversed one, whose frames all come out at the end.
    const tracksProgress = format === 'webp' && ctx.options.direction === 'forward';
    ctx.set({ attempt: 0 });
    ctx.stage('converting', tracksProgress ? 0 : null);

    const output = path.join(ctx.outDir, `${safeFileName(name)}.${format}`);
    const args = buildFfmpegArgs(input, output, { ...ctx.options, seek, duration });
    const { code, stderr } = await ctx.run(BINARIES.ffmpeg, args, {
      onLine: (line) => {
        if (!tracksProgress) return;
        const progress = ffmpegProgress(line, length);
        if (progress != null) ctx.progress(progress);
      },
    });
    if (code !== 0 && !ctx.cancelled) throw ffmpegError(stderr);
  },
};
