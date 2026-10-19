// Audio converter: convert, trim, downmix and normalize audio, or extract it from a video.
import path from 'node:path';
import { BINARIES } from '../../core/paths.js';
import { largestFile, safeFileName, stripExtension } from '../../core/files.js';
import { ffmpegError, ffmpegProgress, probeMedia } from '../../core/media.js';
import { formatTime } from '../../core/time.js';
import { download } from '../downloader/ytdlp.js';
import { buildAudioArgs, parseOptions } from './options.js';

/** The media to convert: the uploaded file, or the best audio of the link (no re-encoding). */
async function getSource(ctx) {
  if (ctx.file) return { input: ctx.file.path, name: stripExtension(ctx.file.name) };

  await download(ctx, ctx.url, { dir: ctx.workDir, format: ['-f', 'ba/b'] });
  const input = largestFile(ctx.workDir);
  if (!input) throw new Error('The audio could not be downloaded');
  return { input, name: stripExtension(path.basename(input)).replace(/\s*\[[^\]]+\]$/, '') };
}

export default {
  id: 'audio',
  accepts: ['url', 'file'],
  parseOptions,

  async run(ctx) {
    const { options } = ctx;
    const { input, name } = await getSource(ctx);
    if (ctx.cancelled) return;

    const media = await probeMedia(ctx, input);
    if (!media.hasAudio) throw new Error('The file has no audio track');
    if (options.start >= media.duration) {
      throw new Error(`The start is past the end of the file (${formatTime(media.duration)})`);
    }
    const end = Math.min(options.end ?? media.duration, media.duration);
    const duration = end - options.start;

    const output = path.join(ctx.outDir, `${safeFileName(name)}.${options.format}`);
    const args = buildAudioArgs(input, output, {
      ...options,
      seek: options.start,
      // Only cut the end when it is not the end of the file anyway.
      duration: options.end != null && end < media.duration ? duration : null,
      sampleRate: media.sampleRate,
    });

    ctx.set({ attempt: 0 });
    ctx.stage('converting', 0);
    const { code, stderr } = await ctx.run(BINARIES.ffmpeg, args, {
      onLine: (line) => {
        const progress = ffmpegProgress(line, duration);
        if (progress != null) ctx.progress(progress);
      },
    });
    if (code !== 0 && !ctx.cancelled) throw ffmpegError(stderr);
  },
};
