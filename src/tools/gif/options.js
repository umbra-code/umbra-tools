// Video → GIF options and ffmpeg arguments (pure, so they can be tested without ffmpeg).
import { httpError } from '../../core/errors.js';
import { pickAllowed } from '../../core/input.js';
import { SPEEDS, speedVideoFilter } from '../../core/media.js';
import { parseRange } from '../../core/time.js';

export const MAX_SECONDS = Number(process.env.GIF_MAX_SECONDS) || 60;

export const OPTIONS = {
  fps: ['10', '15', '20', '25', '30'],
  width: ['320', '480', '640', '800', '1080'],
  format: ['gif', 'webp'],
  speed: SPEEDS,
  direction: ['forward', 'reverse', 'boomerang'],
};

export const DEFAULTS = {
  fps: '15',
  width: '480',
  format: 'gif',
  speed: '1',
  direction: 'forward',
};

/** How long the animation lasts, in seconds, for a clip of `seconds`. */
export const animationLength = (seconds, { speed, direction }) =>
  (seconds / speed) * (direction === 'boomerang' ? 2 : 1);

/**
 * Allowed options plus the clip range, in seconds; throws a 400 when the range is invalid.
 * Both the clip and the animation (slowed down, it lasts longer) are limited to MAX_SECONDS.
 */
export function parseOptions(body = {}) {
  const options = pickAllowed(body, OPTIONS, DEFAULTS);
  const speed = Number(options.speed);
  const { start, end } = parseRange(body, { requireEnd: true });
  if (end - start > MAX_SECONDS) throw httpError(400, `Clips can be at most ${MAX_SECONDS} seconds long`);
  if ((end - start) / speed > MAX_SECONDS) {
    throw httpError(400, `At ${speed}× the clip can be at most ${MAX_SECONDS * speed} seconds long`);
  }

  return { ...options, speed, start, end };
}

/**
 * The frames of the animation: speed first (so `fps` is the rate of the result), then the
 * size (never upscaled: narrow sources keep their own width), then the direction. A boomerang plays forward and back without repeating the frame
 * where it turns.
 */
export function animationFilters({ fps, width, speed = 1, direction = 'forward' }) {
  const frames = [speedVideoFilter(speed), `fps=${fps}`, `scale='min(${width},iw)':-1:flags=lanczos`]
    .filter(Boolean)
    .join(',');
  if (direction === 'reverse') return `${frames},reverse`;
  if (direction === 'boomerang') {
    return `${frames},split[fw][bw];[bw]reverse,trim=start_frame=1,setpts=PTS-STARTPTS[rv];[fw][rv]concat=n=2:v=1:a=0`;
  }
  return frames;
}

/**
 * ffmpeg arguments to turn `input` into an animated `format` file at `output`.
 * `seek` skips into the input first (uploads); a clip that was already cut uses 0.
 * `duration` is how much of the input to read. Progress goes to stdout as key=value
 * lines (`-progress pipe:1`).
 */
export function buildFfmpegArgs(input, output, { seek = 0, duration, format, ...options }) {
  const base = animationFilters(options);
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
    // Before the input, so it limits what is read and not the (maybe slowed down) result.
    '-t', String(duration),
    '-i', input,
    '-an',
    ...encode,
    '-loop', '0',
    output,
  ];
}
