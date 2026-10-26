// Metadata: see what a file says about itself (including sensitive details such as the
// location), edit the usual fields, remove the rest, and set an audio file's cover.
import path from 'node:path';
import { BINARIES } from '../../core/paths.js';
import { safeFileName, stripExtension } from '../../core/files.js';
import { isHeic, readableImage } from '../../core/heic.js';
import { ffmpegError } from '../../core/media.js';
import sharp from '../../core/sharp.js';
import { buildMediaArgs, fieldsFor, parseOptions } from './fields.js';
import { detectKind, readMetadata } from './read.js';
import { writeImage, writePdf } from './write.js';

/** A cover ready to embed: JPEG, upright, at most 1200 px. */
async function prepareCover(cover, dir) {
  const target = path.join(dir, 'cover.jpg');
  try {
    await sharp(await readableImage(cover.path))
      .rotate().resize(1200, 1200, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toFile(target);
  } catch (err) {
    throw new Error(`${cover.name} is not an image this tool can read`, { cause: err });
  }
  return target;
}

export default {
  id: 'metadata',
  accepts: ['file'],
  attachments: ['cover'],
  parseOptions,
  inspect: (file) => readMetadata(file.path, file.name),

  async run(ctx) {
    const { file, options } = ctx;
    const kind = await detectKind(file.path);
    if (!kind) throw new Error('This is not an image, audio, video or PDF file this tool can read');

    // HEIC cannot be written back: those photos come out as high-quality JPEG.
    const heic = kind === 'image' && (await isHeic(file.path));
    const ext = heic ? 'jpg' : path.extname(file.name).slice(1).toLowerCase();
    if (!ext) throw new Error('The file needs an extension (like .mp3 or .jpg) to be rewritten');
    const output = path.join(ctx.outDir, `${safeFileName(stripExtension(file.name), 'file')}.${ext}`);
    const fields = fieldsFor(kind, options.fields);
    const clean = options.clean === 'on';
    ctx.set({ attempt: 0 });
    ctx.stage('converting');

    if (kind === 'image') return writeImage(file.path, output, { fields, clean, format: heic ? 'jpg' : null });
    if (kind === 'pdf') return writePdf(file.path, output, { fields, clean });

    let coverPath = null;
    if (options.cover === 'replace') {
      const cover = ctx.attachments?.cover;
      if (!cover) throw new Error('Choose the image to use as cover');
      coverPath = await prepareCover(cover, ctx.workDir);
    }
    const args = buildMediaArgs(file.path, output, { kind, ext, fields, clean, cover: options.cover, coverPath });
    const { code, stderr } = await ctx.run(BINARIES.ffmpeg, args);
    if (code !== 0 && !ctx.cancelled) throw ffmpegError(stderr);
  },
};
