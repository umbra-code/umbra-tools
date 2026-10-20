import { describe, expect, it } from 'vitest';
import {
  buildDownloadArgs,
  buildPlaylistArgs,
  cleanError,
  DEFAULTS,
  formatArgs,
  isForbidden,
  MAX_PLAYLIST_ITEMS,
  sanitizeOptions,
} from './ytdlp.js';

const URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

/** Value that follows the last occurrence of `flag`, as yt-dlp would read it. */
const lastValue = (args, flag) => args[args.lastIndexOf(flag) + 1];

const argsFor = (options, { client, pinned, extra } = {}) =>
  buildDownloadArgs(URL, '/tmp/job', { client, extra, pinned, format: formatArgs(sanitizeOptions(options)) });

describe('sanitizeOptions', () => {
  it('keeps allowed values', () => {
    const options = { mode: 'audio', videoFormat: 'mkv', quality: '720', audioFormat: 'flac', audioBitrate: '128', playlist: 'all' };
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
    expect(argsFor({}).slice(-2)).toEqual(['--', URL]);
  });

  it('puts the retry client first', () => {
    const client = ['--extractor-args', 'youtube:player_client=tv'];
    expect(argsFor({}, { client }).slice(0, 2)).toEqual(client);
  });

  it('adds extra arguments before the URL', () => {
    const args = argsFor({}, { extra: ['--download-sections', '*5-10'] });
    expect(lastValue(args, '--download-sections')).toBe('*5-10');
    expect(args.indexOf('--download-sections')).toBeLessThan(args.indexOf('--'));
  });

  it('pins the format picked by the first attempt, overriding the selection', () => {
    const args = argsFor({ quality: '1440' }, { pinned: '308+140-3' });
    expect(lastValue(args, '-f')).toBe('308+140-3/308+ba');
    expect(args.lastIndexOf('-f')).toBeGreaterThan(args.indexOf('-S'));
  });

  it('pins a single combined format as is', () => {
    expect(lastValue(argsFor({}, { pinned: '18' }), '-f')).toBe('18');
  });

  it('downloads a single video even from a playlist link', () => {
    const args = argsFor({});
    expect(args).toContain('--no-playlist');
    expect(lastValue(args, '--playlist-items')).toBe('1');
  });
});

describe('buildPlaylistArgs', () => {
  const args = buildPlaylistArgs(URL, '/tmp/job', { format: formatArgs(sanitizeOptions({ mode: 'audio' })) });

  it('downloads the playlist up to the limit, skipping videos that fail', () => {
    expect(args).toContain('--yes-playlist');
    expect(args).toContain('--ignore-errors');
    expect(lastValue(args, '--playlist-items')).toBe(`1:${MAX_PLAYLIST_ITEMS}`);
    expect(args).not.toContain('--no-playlist');
  });

  it('numbers the files in playlist order', () => {
    expect(lastValue(args, '-o')).toMatch(/^%\(playlist_index\)03d - /);
  });

  it('applies the format selection and ends with the URL after "--"', () => {
    expect(lastValue(args, '--audio-format')).toBe('mp3');
    expect(args.slice(-2)).toEqual(['--', URL]);
  });
});

describe('formatArgs', () => {
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

  it('explains videos that need a signed-in account', () => {
    const cases = {
      'ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.': /age-restricted/,
      'ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access to this video': /private/,
      'ERROR: [youtube] abc: Join this channel to get access to members-only content like this video': /members/,
    };
    for (const [stderr, reason] of Object.entries(cases)) {
      const message = cleanError(stderr);
      expect(message).toMatch(reason);
      expect(message).toMatch(/does not sign in to accounts/);
    }
  });

  it('leaves other sign-in messages alone', () => {
    // The bot check is temporary and has nothing to do with the video itself.
    expect(cleanError("ERROR: [youtube] abc: Sign in to confirm you're not a bot")).toBe("Sign in to confirm you're not a bot");
  });
});

describe('isForbidden', () => {
  it('detects 403 responses', () => {
    expect(isForbidden('unable to download video data: HTTP Error 403: Forbidden')).toBe(true);
    expect(isForbidden('Video unavailable')).toBe(false);
    expect(isForbidden('format 4030 not found')).toBe(false);
  });
});
