import { describe, expect, it } from 'vitest';
import { buildDownloadArgs, cleanError, DEFAULTS, isForbidden, sanitizeOptions } from './ytdlp.js';

const URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

/** Value that follows the last occurrence of `flag`, as yt-dlp would read it. */
const lastValue = (args, flag) => args[args.lastIndexOf(flag) + 1];

const argsFor = (options, extra, pinned) =>
  buildDownloadArgs(URL, '/tmp/job', sanitizeOptions(options), extra, pinned);

describe('sanitizeOptions', () => {
  it('keeps allowed values', () => {
    const options = { mode: 'audio', videoFormat: 'mkv', quality: '720', audioFormat: 'flac', audioBitrate: '128' };
    expect(sanitizeOptions(options)).toEqual(options);
  });

  it('falls back to defaults for missing or unknown values', () => {
    expect(sanitizeOptions()).toEqual(DEFAULTS);
    expect(sanitizeOptions({ mode: 'rm -rf', quality: '9999', audioFormat: '--exec' })).toEqual(DEFAULTS);
  });

  it('ignores unknown keys', () => {
    expect(sanitizeOptions({ exec: 'calc.exe' })).not.toHaveProperty('exec');
  });
});

describe('buildDownloadArgs', () => {
  it('always ends with the URL after "--" so it cannot be read as an option', () => {
    const args = argsFor({});
    expect(args.slice(-2)).toEqual(['--', URL]);
  });

  it('puts extra arguments first', () => {
    const extra = ['--extractor-args', 'youtube:player_client=tv'];
    expect(argsFor({}, extra).slice(0, 2)).toEqual(extra);
  });

  it('caps the resolution and prefers H.264/AAC for mp4', () => {
    const args = argsFor({ mode: 'video', videoFormat: 'mp4', quality: '1080' });
    expect(lastValue(args, '-f')).toBe('bv*+ba/b');
    expect(lastValue(args, '-S')).toBe('res:1080,vcodec:h264,acodec:aac');
    expect(lastValue(args, '--merge-output-format')).toBe('mp4');
  });

  it('does not cap the resolution for "max"', () => {
    expect(lastValue(argsFor({ videoFormat: 'mkv', quality: 'max' }), '-S')).toBe('res');
  });

  it('downloads only the video stream in mute mode', () => {
    expect(lastValue(argsFor({ mode: 'mute' }), '-f')).toBe('bv*/b');
  });

  it('prefers webm streams and falls back to mkv when merging webm', () => {
    const args = argsFor({ videoFormat: 'webm' });
    expect(lastValue(args, '-f')).toBe('bv*[ext=webm]+ba[ext=webm]/bv*+ba/b');
    expect(lastValue(args, '--merge-output-format')).toBe('webm/mkv');
  });

  it('extracts lossy audio at the chosen bitrate with cover art', () => {
    const args = argsFor({ mode: 'audio', audioFormat: 'mp3', audioBitrate: '192' });
    expect(args).toContain('-x');
    expect(lastValue(args, '--audio-format')).toBe('mp3');
    expect(lastValue(args, '--audio-quality')).toBe('192K');
    expect(args).toContain('--embed-thumbnail');
  });

  it('skips the bitrate for lossless and original audio', () => {
    for (const audioFormat of ['wav', 'flac', 'original']) {
      expect(argsFor({ mode: 'audio', audioFormat })).not.toContain('--audio-quality');
    }
    expect(lastValue(argsFor({ mode: 'audio', audioFormat: 'original' }), '--audio-format')).toBe('best');
  });

  it('maps ogg to the vorbis codec', () => {
    expect(lastValue(argsFor({ mode: 'audio', audioFormat: 'ogg' }), '--audio-format')).toBe('vorbis');
  });

  it('pins the format picked by the first attempt, overriding the selection', () => {
    const args = argsFor({ quality: '1440' }, [], '308+140-3');
    expect(lastValue(args, '-f')).toBe('308+140-3/308+ba');
    expect(args.lastIndexOf('-f')).toBeGreaterThan(args.indexOf('-S'));
  });

  it('pins a single combined format as is', () => {
    expect(lastValue(argsFor({}, [], '18'), '-f')).toBe('18');
  });
});

describe('cleanError', () => {
  it('returns the last ERROR line without the extractor prefix', () => {
    const stderr = [
      'WARNING: something minor',
      'ERROR: [youtube] abc123: first error',
      'ERROR: [youtube] dQw4w9WgXcQ: Video unavailable',
    ].join('\n');
    expect(cleanError(stderr)).toBe('Video unavailable');
  });

  it('keeps messages that have no extractor prefix', () => {
    expect(cleanError('ERROR: unable to download video data: HTTP Error 403: Forbidden\r\n')).toBe(
      'unable to download video data: HTTP Error 403: Forbidden',
    );
  });

  it('has a fallback for empty output', () => {
    expect(cleanError('')).toBe('Unknown error');
  });
});

describe('isForbidden', () => {
  it('detects 403 responses', () => {
    expect(isForbidden('unable to download video data: HTTP Error 403: Forbidden')).toBe(true);
    expect(isForbidden('Video unavailable')).toBe(false);
    expect(isForbidden('format 4030 not found')).toBe(false);
  });
});
