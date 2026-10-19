import { describe, expect, it } from 'vitest';
import { buildAudioArgs, DEFAULTS, LOUDNORM, parseOptions } from './options.js';

const lastValue = (args, flag) => args[args.lastIndexOf(flag) + 1];
const argsFor = (options) => buildAudioArgs('in.mp4', 'out.x', { ...DEFAULTS, ...options });

describe('parseOptions', () => {
  it('uses the whole file and defaults when nothing is given', () => {
    expect(parseOptions({})).toEqual({ ...DEFAULTS, start: 0, end: null });
  });

  it('keeps allowed values and the range', () => {
    expect(parseOptions({ format: 'flac', channels: 'mono', normalize: 'on', start: '0:30', end: '1:00' })).toMatchObject({
      format: 'flac',
      channels: 'mono',
      normalize: 'on',
      start: 30,
      end: 60,
    });
  });

  it('falls back to defaults for unknown values', () => {
    expect(parseOptions({ format: 'exe', bitrate: '9000' })).toMatchObject({ format: 'mp3', bitrate: '192' });
  });
});

describe('buildAudioArgs', () => {
  it('takes only the first audio track, with its metadata', () => {
    const args = argsFor({});
    expect(lastValue(args, '-map')).toBe('0:a:0');
    expect(lastValue(args, '-map_metadata')).toBe('0');
    expect(args.at(-1)).toBe('out.x');
  });

  it('encodes each format with its codec', () => {
    const codecs = { mp3: 'libmp3lame', m4a: 'aac', opus: 'libopus', ogg: 'libvorbis', wav: 'pcm_s16le', flac: 'flac' };
    for (const [format, codec] of Object.entries(codecs)) {
      expect(lastValue(argsFor({ format }), '-c:a')).toBe(codec);
    }
  });

  it('applies the bitrate to lossy formats only', () => {
    expect(lastValue(argsFor({ format: 'mp3', bitrate: '320' }), '-b:a')).toBe('320k');
    expect(argsFor({ format: 'flac' })).not.toContain('-b:a');
    expect(argsFor({ format: 'wav' })).not.toContain('-b:a');
  });

  it('downmixes to mono when asked', () => {
    expect(lastValue(argsFor({ channels: 'mono' }), '-ac')).toBe('1');
    expect(argsFor({})).not.toContain('-ac');
  });

  it('normalizes loudness and keeps the original sample rate', () => {
    const args = argsFor({ normalize: 'on', sampleRate: 44100 });
    expect(lastValue(args, '-af')).toBe(LOUDNORM);
    expect(lastValue(args, '-ar')).toBe('44100');
    expect(argsFor({ sampleRate: 44100 })).not.toContain('-ar');
  });

  it('cuts the range only when one is given', () => {
    const args = argsFor({ seek: 30, duration: 15 });
    expect(lastValue(args, '-ss')).toBe('30');
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(lastValue(args, '-t')).toBe('15');
    expect(argsFor({})).not.toContain('-ss');
  });
});
