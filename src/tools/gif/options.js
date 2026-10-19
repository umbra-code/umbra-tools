// Video → GIF options and ffmpeg arguments (pure, so they can be tested without ffmpeg).
import { httpError } from '../../core/errors.js';
import { pickAllowed } from '../../core/input.js';
import { parseRange } from '../../core/time.js';

export const MAX_SECONDS = Number(process.env.GIF_MAX_SECONDS) || 60;

export const OPTIONS = {
  fps: ['10', '15', '20', '25', '30'],
  width: ['320', '480', '640', '800', '1080'],
  format: ['gif', 'webp'],
};

export const DEFAULTS = {
  fps: '15',
  width: '480',
  format: 'gif',
};

/** Allowed options plus the clip range, in seconds; throws a 400 when the range is invalid. */
export function parseOptions(body = {}) {
  const options = pickAllowed(body, OPTIONS, DEFAULTS);
  const { start, end } = parseRange(body, { requireEnd: true });
  if (end - start > MAX_SECONDS) throw httpError(400, `Clips can be at most ${MAX_SECONDS} seconds long`);

  return { ...options, start, end };
}

/**
 * ffmpeg arguments to turn `input` into an animated `format` file at `output`.
 * `seek` skips into the input first (uploads); a clip that was already cut uses 0.
 * Progress goes to stdout as key=value lines (`-progress pipe:1`).
 */
export function buildFfmpegArgs(input, output, { seek = 0, duration, fps, width, format }) {
  // Never upscale: narrow sources keep their own width.
  const base = `fps=${fps},scale='min(${width},iw)':-1:flags=lanczos`;
  const encode =
    format === 'webp'
      ? ['-vf', base, '-c:v', 'libwebp_anim', '-quality', '75', '-compression_level', '4']
      : [
          // A palette built from the clip itself gives far better colors than the default one.
          '-vf',
          `${base},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
        ];

  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-progress', 'pipe:1',
    '-nostats',
    ...(seek > 0 ? ['-ss', String(seek)] : []),
    '-i', input,
    '-t', String(duration),
    '-an',
    ...encode,
    '-loop', '0',
    output,
  ];
}
