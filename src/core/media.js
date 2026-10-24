// Media helpers shared by tools that work with video and audio files.
import { BINARIES } from './paths.js';

/**
 * What a media file contains, read with ffprobe:
 * `{ duration, hasVideo, hasAudio, width, height, sampleRate }`.
 * Throws when the file is not something ffmpeg can read.
 */
export async function probeMedia(ctx, file) {
  const lines = [];
  const { code } = await ctx.run(
    BINARIES.ffprobe,
    ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,sample_rate:format=duration,format_name', '-of', 'json', file],
    { onLine: (line) => lines.push(line) },
  );
  let probe = {};
  try {
    probe = JSON.parse(lines.join('\n'));
  } catch {
    // handled below
  }
  const streams = probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  let duration = Number(probe.format?.duration);
  // GIFs do not say how long they are: it is where their last frame ends.
  if (code === 0 && !Number.isFinite(duration) && probe.format?.format_name === 'gif') {
    duration = await lastFrameEnd(ctx, file);
  }
  if (code !== 0 || !Number.isFinite(duration)) throw new Error('The file does not look like a video or audio file');

  return {
    duration,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width ?? null,
    height: video?.height ?? null,
    sampleRate: Number(audio?.sample_rate) || null,
  };
}

/** Playback speeds offered by the tools that change it. */
export const SPEEDS = ['0.25', '0.5', '1', '1.5', '2', '4'];

/** Video filter that plays the frames `speed` times faster (empty at 1×). */
export const speedVideoFilter = (speed) => (Number(speed) === 1 ? '' : `setpts=PTS/${speed}`);

/**
 * Audio filters that play `speed` times faster keeping the pitch (empty at 1×).
 * atempo goes down to 0.5×, so slower speeds chain several.
 */
export function speedAudioFilter(speed) {
  const steps = [];
  let rest = Number(speed);
  while (rest < 0.5) {
    steps.push('atempo=0.5');
    rest /= 0.5;
  }
  if (rest !== 1) steps.push(`atempo=${rest}`);
  return steps.join(',');
}

/** When the last video frame of `file` ends, in seconds (NaN when unknown). */
async function lastFrameEnd(ctx, file) {
  let last = '';
  await ctx.run(
    BINARIES.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', file],
    { onLine: (line) => line.trim() && (last = line) },
  );
  const [pts, length] = last.split(',').map(Number);
  return pts + (length || 0);
}

/** Reads `out_time_us` from ffmpeg's `-progress pipe:1` output as a 0–1 fraction of `duration`. */
export function ffmpegProgress(line, duration) {
  const match = line.match(/^out_time_us=(\d+)/);
  return match && duration > 0 ? Math.min(Number(match[1]) / 1e6 / duration, 1) : null;
}

/** The last line ffmpeg wrote to stderr, which is usually the reason it failed. */
export function ffmpegError(stderr) {
  const lastLine = stderr.trim().split(/\r?\n/).pop();
  return new Error(lastLine ? `ffmpeg: ${lastLine}` : 'The conversion failed');
}
