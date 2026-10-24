// Video converter options and ffmpeg arguments (pure, so they can be tested without ffmpeg).
import { httpError } from '../../core/errors.js';
import { pickAllowed } from '../../core/input.js';
import { SPEEDS, speedAudioFilter, speedVideoFilter } from '../../core/media.js';
import { parseRange } from '../../core/time.js';

export const OPTIONS = {
  format: ['mp4', 'webm', 'mkv'],
  codec: ['h264', 'h265'],
  resolution: ['original', '2160', '1440', '1080', '720', '480', '360'],
  fps: ['original', '60', '30', '24'],
  audio: ['keep', 'remove'],
  mode: ['quality', 'size'],
  quality: ['high', 'balanced', 'small'],
  speed: SPEEDS,
  direction: ['forward', 'reverse'],
};

export const DEFAULTS = {
  format: 'mp4',
  codec: 'h264',
  resolution: 'original',
  fps: 'original',
  audio: 'keep',
  mode: 'quality',
  quality: 'balanced',
  speed: '1',
  direction: 'forward',
};

/** Decoded frames a reversed piece may hold in memory (ffmpeg keeps all of them to reverse). */
const REVERSE_BYTES = 512 * 1024 * 1024;
const MAX_PIECE_SECONDS = 10;

export const AUDIO_KBPS = 128;
export const MAX_TARGET_MB = 10_000;
/** Below this the result is too blocky to be useful. */
export const MIN_VIDEO_KBPS = 100;

// Constant-quality levels per encoder (lower is better and bigger).
const CRF = {
  h264: { high: 18, balanced: 23, small: 28 },
  h265: { high: 20, balanced: 26, small: 30 },
  vp9: { high: 24, balanced: 32, small: 38 },
};

/** Allowed options, the range in seconds (`end` null = until the end) and the target size. */
export function parseOptions(body = {}) {
  const options = pickAllowed(body, OPTIONS, DEFAULTS);
  const { start, end } = parseRange(body);

  let targetMb = null;
  if (options.mode === 'size') {
    targetMb = Number(body.targetMb);
    if (!Number.isFinite(targetMb) || targetMb <= 0 || targetMb > MAX_TARGET_MB) {
      throw httpError(400, `The target size must be a number of MB, up to ${MAX_TARGET_MB}`);
    }
  }

  return { ...options, speed: Number(options.speed), start, end, targetMb };
}

/** webm always uses VP9; mp4 and mkv use the chosen codec. */
export const videoCodec = ({ format, codec }) => (format === 'webm' ? 'vp9' : codec);

/**
 * Video bitrate (kbit/s) that makes `seconds` of video fit in `targetMb`, leaving room for
 * the audio and ~3% of container overhead. Throws a 400 when it would be unwatchably low.
 */
export function targetVideoKbps(targetMb, seconds, withAudio) {
  const totalKbps = (targetMb * 1024 * 1024 * 8 * 0.97) / 1000 / seconds;
  const kbps = Math.floor(totalKbps - (withAudio ? AUDIO_KBPS : 0));
  if (kbps < MIN_VIDEO_KBPS) {
    throw httpError(400, `${targetMb} MB is too small for ${Math.round(seconds)} s of video; pick a bigger size or a shorter range`);
  }
  return kbps;
}

const ENCODERS = {
  h264: ['-c:v', 'libx264', '-preset', 'medium'],
  h265: ['-c:v', 'libx265', '-preset', 'fast'],
  vp9: ['-c:v', 'libvpx-vp9', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1'],
};

/**
 * Filters for the size of the picture. Encoders need even sides, which GIFs often do not
 * have (`oddSize`): those lose their last row or column. Never upscale: smaller sources keep
 * their size, and -2 keeps the width even.
 */
const sizeFilters = ({ resolution, oddSize }) =>
  [oddSize && 'crop=trunc(iw/2)*2:trunc(ih/2)*2', resolution !== 'original' && `scale=-2:'min(${resolution},ih)'`].filter(
    Boolean,
  );

/**
 * Splits `start`–`end` into pieces short enough to reverse in memory, given the size of the
 * picture (`width` × `height`, before `resolution` shrinks it). Returned last piece first:
 * reversing each one and joining them in this order reverses the whole range.
 */
export function reversePieces(start, end, { width, height, resolution }) {
  const outHeight = resolution === 'original' ? height : Math.min(Number(resolution), height);
  const outWidth = (width * outHeight) / height;
  // yuv420 frames take 1.5 bytes per pixel; up to 60 of them per second.
  const seconds = Math.min(MAX_PIECE_SECONDS, Math.max(1, Math.floor(REVERSE_BYTES / (outWidth * outHeight * 1.5 * 60))));
  const pieces = [];
  for (let at = start; end - at > 0.001; at += seconds) pieces.push({ seek: at, duration: Math.min(seconds, end - at) });
  return pieces.reverse();
}

/**
 * ffmpeg arguments to write one piece of `input`, reversed, into `output` (mkv). The picture
 * is already brought to its final size, so reversing keeps fewer bytes in memory, and stored
 * almost losslessly; the real encode happens later, on the joined pieces.
 */
export function buildReversePiece(input, output, { seek, duration, keepAudio, resolution, oddSize }) {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-ss', String(seek),
    '-t', String(duration),
    '-i', input,
    '-map', '0:v:0',
    '-vf', [...sizeFilters({ resolution, oddSize }), 'reverse'].join(','),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '14', '-pix_fmt', 'yuv420p',
    ...(keepAudio ? ['-map', '0:a:0', '-af', 'areverse', '-c:a', 'pcm_s16le'] : ['-an']),
    output,
  ];
}

/** "-pass N" for the chosen encoder; x265 takes it through its own parameters. */
function passArgs(codec, pass) {
  if (codec === 'h265') return ['-x265-params', `pass=${pass}:stats=passlog`];
  return ['-pass', String(pass), '-passlogfile', 'passlog'];
}

/**
 * ffmpeg runs to convert `input` into `output`: one for constant quality, two (analysis +
 * encode) for a target size. Each run is an argument list. Two-pass runs write their stats
 * as "passlog*" in the working directory, so ffmpeg must run with `cwd` set to a temp dir.
 *
 * `seek`/`duration` select the range of the input; `videoKbps` is required for mode "size";
 * `hasAudio` says whether the input has an audio track to keep; `oddSize` whether the picture
 * has an odd side. `speed` plays it faster or slower (the audio keeps its pitch).
 */
export function buildVideoPasses(input, output, options) {
  const { format, fps, audio, mode, quality, speed = 1, seek = 0, duration, videoKbps, hasAudio } = options;
  const codec = videoCodec(options);

  const head = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-progress', 'pipe:1',
    '-nostats',
    ...(seek > 0 ? ['-ss', String(seek)] : []),
    // Before the input, so it limits what is read and not the (maybe slowed down) result.
    ...(duration ? ['-t', String(duration)] : []),
    '-i', input,
    '-map', '0:v:0',
  ];

  const filters = [...sizeFilters(options), speedVideoFilter(speed), fps !== 'original' && `fps=${fps}`].filter(Boolean);
  const video = [
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    ...ENCODERS[codec],
    '-pix_fmt', 'yuv420p',
    ...(codec === 'h265' && format === 'mp4' ? ['-tag:v', 'hvc1'] : []), // plays on Apple devices
  ];

  const keepAudio = audio === 'keep' && hasAudio;
  const tempo = speedAudioFilter(speed);
  const audioArgs = keepAudio
    ? [
        '-map', '0:a:0',
        ...(tempo ? ['-af', tempo] : []),
        '-c:a', format === 'webm' ? 'libopus' : 'aac',
        '-b:a', `${AUDIO_KBPS}k`,
      ]
    : ['-an'];
  const container = format === 'mp4' ? ['-movflags', '+faststart'] : [];

  if (mode === 'size') {
    const rate = ['-b:v', `${videoKbps}k`];
    return [
      [...head, ...video, ...rate, ...passArgs(codec, 1), '-an', '-f', 'null', '-'],
      [...head, ...video, ...rate, ...passArgs(codec, 2), ...audioArgs, ...container, output],
    ];
  }

  const crf = ['-crf', String(CRF[codec][quality]), ...(codec === 'vp9' ? ['-b:v', '0'] : [])];
  return [[...head, ...video, ...crf, ...audioArgs, ...container, output]];
}
