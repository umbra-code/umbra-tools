// Audio converter options and ffmpeg arguments (pure, so they can be tested without ffmpeg).
import { pickAllowed } from '../../core/input.js';
import { parseRange } from '../../core/time.js';

export const OPTIONS = {
  format: ['mp3', 'm4a', 'opus', 'ogg', 'wav', 'flac'],
  bitrate: ['320', '256', '192', '128', '96'],
  channels: ['original', 'mono'],
  normalize: ['off', 'on'],
};

export const DEFAULTS = {
  format: 'mp3',
  bitrate: '192',
  channels: 'original',
  normalize: 'off',
};

export const LOSSLESS = ['wav', 'flac'];

// EBU R128 loudness normalization to -16 LUFS (a common level for music and podcasts),
// keeping peaks below -1.5 dBTP so lossy encoding does not clip.
export const LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11';

const ENCODERS = {
  mp3: ['-c:a', 'libmp3lame'],
  m4a: ['-c:a', 'aac', '-movflags', '+faststart'],
  opus: ['-c:a', 'libopus'],
  ogg: ['-c:a', 'libvorbis'],
  wav: ['-c:a', 'pcm_s16le'],
  flac: ['-c:a', 'flac'],
};

/** Allowed options plus the range in seconds (`end` null = until the end). */
export function parseOptions(body = {}) {
  return { ...pickAllowed(body, OPTIONS, DEFAULTS), ...parseRange(body) };
}

/**
 * ffmpeg arguments to convert the first audio track of `input` into `output`.
 * `seek`/`duration` select the range; `sampleRate` is the input's, restored after
 * normalizing (loudnorm resamples to 192 kHz internally).
 */
export function buildAudioArgs(input, output, { format, bitrate, channels, normalize, seek = 0, duration, sampleRate }) {
  const normalizing = normalize === 'on';
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-progress', 'pipe:1',
    '-nostats',
    ...(seek > 0 ? ['-ss', String(seek)] : []),
    '-i', input,
    ...(duration ? ['-t', String(duration)] : []),
    // Only the audio: no video, and no cover art that some players would show as a video track.
    '-map', '0:a:0',
    '-map_metadata', '0',
    ...(normalizing ? ['-af', LOUDNORM] : []),
    ...(normalizing && sampleRate ? ['-ar', String(sampleRate)] : []),
    ...(channels === 'mono' ? ['-ac', '1'] : []),
    ...ENCODERS[format],
    ...(LOSSLESS.includes(format) ? [] : ['-b:a', `${bitrate}k`]),
    output,
  ];
}
