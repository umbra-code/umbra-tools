// Renders one image with sharp: orient, edit (rotate, flip, crop, resize), encode — at a
// chosen quality, or at the best quality that fits a maximum weight.
import fs from 'node:fs';
import path from 'node:path';
import sharp from '../../core/sharp.js';
import { safeFileName, stripExtension, uniquePath } from '../../core/files.js';
import {
  ANIMATED_FORMATS,
  encoderFor,
  EXTENSIONS,
  hasEdits,
  MAX_SIDE,
  resolveCrop,
  resolveFormat,
  resolveSize,
} from './options.js';

// Formats whose weight a quality setting controls (PNG through palette reduction).
const TUNABLE = ['jpg', 'webp', 'avif', 'png'];
// Below this the picture is too small to be worth shrinking further to fit a weight.
const MIN_SIDE = 16;

/**
 * Prepares the picture once; `make(scale)` then returns a fresh sharp pipeline for it at
 * `scale` (1 = the size the options ask for), ready to encode.
 *
 * Without edits, it is one pass (and animations survive as webp or gif). With edits it is
 * two, so the crop means exactly what the preview showed: first the picture is turned upright
 * (EXIF), rotated and flipped; then the crop and the resize apply to that result.
 */
async function prepare(input, options) {
  const { format, maxSize, metadata, rotate, flipH, flipV, crop, width, height } = options;
  const info = await sharp(input).metadata();
  const outFormat = resolveFormat(info, format);
  const keep = metadata === 'keep';
  const maxSide = maxSize === 'original' ? null : Number(maxSize);

  const finish = (image) => {
    // JPEG has no transparency: put transparent areas on white instead of black.
    if (outFormat === 'jpg' && info.hasAlpha) image = image.flatten({ background: '#ffffff' });
    // By default sharp drops EXIF (camera, GPS location…) and XMP; "keep" carries them over.
    return keep ? image.keepMetadata() : image;
  };

  if (!hasEdits(options)) {
    const animated = (info.pages ?? 1) > 1 && ANIMATED_FORMATS.includes(outFormat);
    // EXIF orientations 5–8 turn the picture sideways: width and height swap once upright.
    const sideways = (info.orientation ?? 1) >= 5;
    const upright = { width: sideways ? info.height : info.width, height: sideways ? info.width : (info.pageHeight ?? info.height) };
    const base = resolveSize({ width: upright.width, height: upright.height }, null, null, maxSide);
    return {
      format: outFormat,
      size: base,
      animated,
      make: (scale) => {
        // Phone photos are often stored sideways with an EXIF orientation tag: apply it for real.
        const image = sharp(input, { animated }).rotate();
        const targetWidth = Math.max(1, Math.round(base.width * scale));
        return finish(targetWidth === upright.width ? image : image.resize({ width: targetWidth }));
      },
    };
  }

  let oriented = sharp(input).rotate();
  if (rotate) oriented = oriented.rotate(rotate);
  if (flipH) oriented = oriented.flop();
  if (flipV) oriented = oriented.flip();
  // Lossless and fast in between; PNG also carries the metadata over when it is kept.
  if (keep) oriented = oriented.keepMetadata();
  const { data, info: upright } = await oriented.png({ compressionLevel: 0 }).toBuffer({ resolveWithObject: true });

  const area = resolveCrop(crop, upright.width, upright.height);
  const size = resolveSize(area, width, height, maxSide);
  if (size.width > MAX_SIDE || size.height > MAX_SIDE) throw new Error(`The result can be at most ${MAX_SIDE} px on each side`);
  return {
    format: outFormat,
    size,
    make: (scale) =>
      finish(
        sharp(data)
          .extract(area)
          .resize(Math.max(1, Math.round(size.width * scale)), Math.max(1, Math.round(size.height * scale)), {
            fit: 'fill',
            kernel: 'lanczos3',
          }),
      ),
  };
}

async function encodeImage(pipeline, format, quality, settings) {
  const [encoder, options] = encoderFor(format, quality, settings);
  const { data, info } = await pipeline[encoder](options).toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.pageHeight ?? info.height };
}

// Size of the small copy the quality is first estimated on, in pixels (about 1 MP).
const PROXY_PIXELS = 1_000_000;

/**
 * The best quality (1–100) for `fits` (a weight check on an encoded result). Each probe is
 * `encodeAt(q)`; results already known can be passed in `tried` (a Map of quality → result).
 *
 * Without a `hint` it is a plain bisection (at most 7 probes). With a good hint it starts
 * there and moves in small, growing steps until it brackets the answer, then bisects: usually
 * two or three probes. Resolves with `{ best, lowest }`: the best fitting result (or null) and
 * the result at quality 1 when that was tried and still did not fit.
 */
export async function searchQuality(encodeAt, fits, hint = null, tried = new Map()) {
  const probe = async (q) => {
    if (!tried.has(q)) tried.set(q, await encodeAt(q));
    return tried.get(q);
  };

  let lo = 0; // highest quality known to fit (0: none yet)
  let hi = 101; // lowest quality known not to fit (101: none yet)
  if (hint != null) {
    let q = hint;
    for (let step = 2; lo + 1 < hi; step *= 2) {
      if (fits(await probe(q))) {
        lo = q;
        if (hi <= 100) break;
        q = Math.min(100, q + step);
      } else {
        hi = q;
        if (lo >= 1) break;
        q = Math.max(1, q - step);
      }
      if (q === lo || q === hi) break; // reached an end (1 or 100) already tried
    }
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(await probe(mid))) lo = mid;
    else hi = mid;
  }
  return {
    best: lo >= 1 ? { ...tried.get(lo), quality: lo } : null,
    lowest: lo === 0 && tried.has(1) ? tried.get(1) : null,
  };
}

/** The pipeline's pixels, decoded once, and a way to start a fresh pipeline from them. */
async function rasterize(pipeline) {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const raw = { width: info.width, height: info.height, channels: info.channels };
  return { width: info.width, height: info.height, make: () => sharp(data, { raw }) };
}

/**
 * The best quality of `format` whose result is at most `maxBytes`; when not even the lowest
 * quality fits, the picture is made smaller and tried again. Resolves with
 * `{ data, width, height, quality, scale }` (`scale` < 1 when it had to shrink).
 *
 * To stay fast on big photos, the picture is decoded, oriented, cropped and resized once per
 * size, so each quality tried only costs an encode; the quality is first estimated on a
 * small copy (with the target scaled by the area) and then settled on the real size starting
 * from that estimate. The final encode goes through the real pipeline, so metadata (when kept)
 * and animations come out as usual.
 */
async function fitWeight({ make, format, size, animated }, maxBytes, signal) {
  // The search can take seconds on big photos: stop as soon as nobody waits for it anymore.
  const encode = (...args) => {
    signal?.throwIfAborted();
    return encodeImage(...args);
  };
  // PNG is lossless; to make it lighter its colors are reduced to a palette, and the quality
  // decides how faithfully (as tools like pngquant and TinyPNG do). Reducing the colors of a
  // big photo is slow, so it uses the quickest setting.
  const settings = format === 'png' ? { palette: true, effort: 1 } : {};
  const fits = (out) => out.data.length <= maxBytes;

  let scale = 1;
  for (let round = 0; round < 6; round++) {
    // Animations keep every frame, which raw pixels cannot carry: those use the full pipeline.
    const source = animated ? null : await rasterize(make(scale));
    const pipeline = () => (source ? source.make() : make(scale));

    let lowest;
    if (!TUNABLE.includes(format)) {
      const out = await encode(make(scale), format, 100);
      if (fits(out)) return { ...out, quality: null, scale };
      lowest = out;
    } else {
      const encodeFull = (q) => encode(pipeline(), format, q, settings);
      const tried = new Map(); // results on the real picture, by quality
      let hint = null;
      const proxy = Math.min(1, Math.sqrt(PROXY_PIXELS / (size.width * scale * size.height * scale)));
      if (source && proxy < 1) {
        // Estimate on a small copy, assuming weight follows the area...
        const small = await rasterize(
          source.make().resize(Math.max(1, Math.round(source.width * proxy)), Math.max(1, Math.round(source.height * proxy))),
        );
        const smallTried = new Map();
        const estimate = async (target) =>
          (
            await searchQuality(
              (q) => encode(small.make(), format, q, settings),
              (out) => out.data.length <= target,
              null,
              smallTried,
            )
          ).best?.quality ?? 1;
        const area = proxy * proxy;
        hint = await estimate(maxBytes * area);
        // ...then check that guess once on the real picture, and correct the copy's target by
        // how far off it was (small copies compress differently): a near-exact second guess.
        const real = await encodeFull(hint);
        tried.set(hint, real);
        const predicted = smallTried.get(hint).data.length / area;
        const error = real.data.length / predicted;
        if (Math.abs(error - 1) > 0.03) hint = await estimate((maxBytes * area) / error);
      }

      const { best, lowest: atOne } = await searchQuality(encodeFull, fits, hint, tried);
      if (best) {
        if (!source) return { ...best, scale };
        // The real encode can be a little bigger (kept metadata): step down until it fits.
        for (let q = best.quality; q >= 1; q--) {
          const final = await encode(make(scale), format, q, settings);
          if (fits(final)) return { ...final, quality: q, scale };
        }
      }
      lowest = atOne ?? (await encode(pipeline(), format, 1, settings));
    }
    scale *= shrinkFactor(maxBytes, lowest.data.length);
    if (size.width * scale < MIN_SIDE || size.height * scale < MIN_SIDE) break;
  }
  throw new Error(`It cannot get under ${formatKb(maxBytes)}, even at the lowest quality and a tiny size`);
}

/** How much smaller to make the picture when `bytes` must become `maxBytes` (weight ≈ area). */
export const shrinkFactor = (maxBytes, bytes) => Math.min(0.95, Math.max(0.2, Math.sqrt(maxBytes / bytes) * 0.9));

const formatKb = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);

/**
 * Renders the image at `input` with the parsed `options`, in memory.
 * Resolves with `{ data, format, width, height, quality, scale }`: `quality` is the one used
 * (found automatically when `options.quality` is 'auto') and `scale` < 1 when the picture had
 * to be made smaller to fit `options.maxKb`. Rejects when it is not a readable image, or when
 * `signal` aborts during the search for the quality.
 */
export async function renderImage(input, options, { signal } = {}) {
  const prepared = await prepare(input, options);
  if (options.quality === 'auto') {
    return { format: prepared.format, ...(await fitWeight(prepared, options.maxKb * 1024, signal)) };
  }
  const out = await encodeImage(prepared.make(1), prepared.format, options.quality);
  return { format: prepared.format, ...out, quality: TUNABLE.includes(prepared.format) && prepared.format !== 'png' ? options.quality : null, scale: 1 };
}

/**
 * Converts the image at `input` (named `name`) into `outDir` with the parsed `options`.
 * Resolves with `{ output, format, width, height, quality, scale }`; rejects when it is not a readable image.
 */
export async function convertImage(input, name, outDir, options) {
  const { data, ...result } = await renderImage(input, options);
  const output = uniquePath(outDir, safeFileName(stripExtension(name), 'image'), EXTENSIONS[result.format]);
  fs.writeFileSync(output, data);
  return { output, ...result };
}

/** A message for the user when sharp cannot read or write an image. */
export function describeImageError(err, name) {
  const unsupported = /unsupported image format|bad seek|Input file contains unsupported/i.test(err.message);
  const ext = path.extname(name).toLowerCase();
  if (['.heic', '.heif'].includes(ext)) return 'HEIC photos are not supported yet; export them as JPEG first';
  return unsupported ? 'Not an image this tool can read' : err.message;
}
