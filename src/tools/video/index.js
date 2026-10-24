// Video converter: trim, resize, change format/codec and compress (to a quality or a target size),
// change the speed or reverse. GIFs are videos too, so this also turns them into mp4/webm.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BINARIES } from '../../core/paths.js';
import { largestFile, safeFileName, stripExtension } from '../../core/files.js';
import { ffmpegError, ffmpegProgress, probeMedia } from '../../core/media.js';
import { formatTime } from '../../core/time.js';
import { download } from '../downloader/ytdlp.js';
import { buildReversePiece, buildVideoPasses, parseOptions, reversePieces, targetVideoKbps } from './options.js';

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

/**
 * Reverses `start`–`end` of `input` into one file, piece by piece (reversing needs every frame
 * in memory, which a whole video would not fit in). Returns that file, or null when cancelled.
 */
async function reverse(ctx, input, { start, end, media, keepAudio }) {
  const dir = path.join(ctx.workDir, 'reversed');
  const { resolution } = ctx.options;
  const pieces = reversePieces(start, end, { ...media, resolution });
  mkdirSync(dir, { recursive: true });
  ctx.set({ attempt: 0 });
  ctx.stage('reversing', 0);

  const files = [];
  for (const [i, piece] of pieces.entries()) {
    const file = path.join(dir, `piece-${i}.mkv`);
    const args = buildReversePiece(input, file, { ...piece, keepAudio, resolution, oddSize: media.oddSize });
    const { code, stderr } = await ctx.run(BINARIES.ffmpeg, args);
    if (ctx.cancelled) return null;
    if (code !== 0) throw ffmpegError(stderr);
    files.push(file);
    ctx.progress((i + 1) / pieces.length);
  }

  // Joined without re-encoding: the pieces share the same settings.
  const list = path.join(dir, 'pieces.txt');
  writeFileSync(list, files.map((file) => `file '${path.basename(file)}'`).join('\n'));
  const joined = path.join(ctx.workDir, 'reversed.mkv');
  const { code, stderr } = await ctx.run(BINARIES.ffmpeg, [
    '-hide_banner', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined,
  ]);
  if (ctx.cancelled) return null;
  if (code !== 0) throw ffmpegError(stderr);
  rmSync(dir, { recursive: true, force: true });
  return joined;
}

export default {
  id: 'video',
  accepts: ['url', 'file'],
  parseOptions,

  async run(ctx) {
    const { options } = ctx;
    const source = await getSource(ctx);
    if (ctx.cancelled) return;

    const media = await probeMedia(ctx, source.input);
    if (!media.hasVideo) throw new Error('The file has no video; it cannot be converted as a video');
    if (options.start >= media.duration) {
      throw new Error(`The start is past the end of the video (${formatTime(media.duration)})`);
    }
    media.oddSize = media.width % 2 === 1 || media.height % 2 === 1;
    const end = Math.min(options.end ?? media.duration, media.duration);
    const duration = end - options.start;
    const keepAudio = options.audio === 'keep' && media.hasAudio;
    // How long the result lasts, for the progress and the bitrate of a target size.
    const length = duration / options.speed;
    const videoKbps = options.mode === 'size' ? targetVideoKbps(options.targetMb, length, keepAudio) : null;
    // Only cut the end when it is not the end of the video anyway.
    let range = { seek: options.start, duration: options.end != null && end < media.duration ? duration : null };

    let input = source.input;
    if (options.direction === 'reverse') {
      input = await reverse(ctx, input, { start: options.start, end, media, keepAudio });
      if (!input) return;
      range = { seek: 0, duration: null }; // already cut
    }

    const output = path.join(ctx.outDir, `${safeFileName(source.name)}.${options.format}`);
    const passes = buildVideoPasses(input, output, {
      ...options,
      ...range,
      hasAudio: media.hasAudio,
      oddSize: media.oddSize,
      videoKbps,
    });

    for (const [i, args] of passes.entries()) {
      const last = i === passes.length - 1;
      ctx.set({ attempt: 0, pass: i + 1, passes: passes.length });
      ctx.stage(last ? 'converting' : 'analyzing', 0);
      const { code, stderr } = await ctx.run(BINARIES.ffmpeg, args, {
        cwd: ctx.workDir, // two-pass stats files go here
        onLine: (line) => {
          const progress = ffmpegProgress(line, length);
          if (progress != null) ctx.progress(progress);
        },
      });
      if (ctx.cancelled) return;
      if (code !== 0) throw ffmpegError(stderr);
    }
  },
};
