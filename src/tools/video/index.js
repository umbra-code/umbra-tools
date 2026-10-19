// Video converter: trim, resize, change format/codec and compress (to a quality or a target size).
import path from 'node:path';
import { BINARIES } from '../../core/paths.js';
import { largestFile, safeFileName, stripExtension } from '../../core/files.js';
import { ffmpegError, ffmpegProgress, probeMedia } from '../../core/media.js';
import { formatTime } from '../../core/time.js';
import { download } from '../downloader/ytdlp.js';
import { buildVideoPasses, parseOptions, targetVideoKbps } from './options.js';

/** The video to convert: the uploaded file, or the link downloaded without re-encoding. */
async function getSource(ctx) {
  if (ctx.file) return { input: ctx.file.path, name: stripExtension(ctx.file.name) };

  // Whole video, merged into mkv (accepts any codec, no re-encoding); ffmpeg cuts it exactly
  // afterwards. No point downloading more resolution than the output will have.
  const { resolution } = ctx.options;
  await download(ctx, ctx.url, {
    dir: ctx.workDir,
    format: [
      '-f', 'bv*+ba/b',
      ...(resolution !== 'original' ? ['-S', `res:${resolution}`] : []),
      '--merge-output-format', 'mkv',
    ],
  });
  const input = largestFile(ctx.workDir);
  if (!input) throw new Error('The video could not be downloaded');
  return { input, name: stripExtension(path.basename(input)).replace(/\s*\[[^\]]+\]$/, '') };
}

export default {
  id: 'video',
  accepts: ['url', 'file'],
  parseOptions,

  async run(ctx) {
    const { options } = ctx;
    const { input, name } = await getSource(ctx);
    if (ctx.cancelled) return;

    const media = await probeMedia(ctx, input);
    if (!media.hasVideo) throw new Error('The file has no video; it cannot be converted as a video');
    if (options.start >= media.duration) {
      throw new Error(`The start is past the end of the video (${formatTime(media.duration)})`);
    }
    const end = Math.min(options.end ?? media.duration, media.duration);
    const duration = end - options.start;
    const keepAudio = options.audio === 'keep' && media.hasAudio;

    const output = path.join(ctx.outDir, `${safeFileName(name)}.${options.format}`);
    const passes = buildVideoPasses(input, output, {
      ...options,
      seek: options.start,
      // Only cut the end when it is not the end of the video anyway.
      duration: options.end != null && end < media.duration ? duration : null,
      hasAudio: media.hasAudio,
      videoKbps: options.mode === 'size' ? targetVideoKbps(options.targetMb, duration, keepAudio) : null,
    });

    for (const [i, args] of passes.entries()) {
      const last = i === passes.length - 1;
      ctx.set({ attempt: 0, pass: i + 1, passes: passes.length });
      ctx.stage(last ? 'converting' : 'analyzing', 0);
      const { code, stderr } = await ctx.run(BINARIES.ffmpeg, args, {
        cwd: ctx.workDir, // two-pass stats files go here
        onLine: (line) => {
          const progress = ffmpegProgress(line, duration);
          if (progress != null) ctx.progress(progress);
        },
      });
      if (ctx.cancelled) return;
      if (code !== 0) throw ffmpegError(stderr);
    }
  },
};
