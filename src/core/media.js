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
    ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,sample_rate:format=duration', '-of', 'json', file],
    { onLine: (line) => lines.push(line) },
  );
  let probe = {};
  try {
    probe = JSON.parse(lines.join('\n'));
  } catch {
    // handled below
  }
  const duration = Number(probe.format?.duration);
  if (code !== 0 || !Number.isFinite(duration)) throw new Error('The file does not look like a video or audio file');

  const streams = probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  return {
    duration,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width ?? null,
    height: video?.height ?? null,
    sampleRate: Number(audio?.sample_rate) || null,
  };
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
