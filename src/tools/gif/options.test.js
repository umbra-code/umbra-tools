import { describe, expect, it } from 'vitest';
import { buildFfmpegArgs, DEFAULTS, MAX_SECONDS, parseOptions } from './options.js';

const lastValue = (args, flag) => args[args.lastIndexOf(flag) + 1];

describe('parseOptions', () => {
  it('parses the range and keeps allowed options', () => {
    expect(parseOptions({ start: '1:05', end: '1:10.5', fps: '20', width: '640', format: 'webp' })).toEqual({
      start: 65,
      end: 70.5,
      fps: '20',
      width: '640',
      format: 'webp',
    });
  });

  it('starts at 0 and uses defaults when only the end is given', () => {
    expect(parseOptions({ end: '5' })).toEqual({ ...DEFAULTS, start: 0, end: 5 });
  });

  it('falls back to defaults for unknown options', () => {
    expect(parseOptions({ end: '5', fps: '999', width: 'huge', format: 'exe' })).toMatchObject(DEFAULTS);
  });

  it('rejects invalid ranges with a 400', () => {
    for (const body of [{}, { end: 'soon' }, { start: '-1', end: '5' }, { start: '5', end: '5' }, { start: '8', end: '3' }]) {
      expect(() => parseOptions(body)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });

  it(`limits clips to ${MAX_SECONDS} seconds`, () => {
    expect(() => parseOptions({ start: '0', end: String(MAX_SECONDS) })).not.toThrow();
    expect(() => parseOptions({ start: '0', end: String(MAX_SECONDS + 1) })).toThrow(/at most/);
  });
});

describe('buildFfmpegArgs', () => {
  const options = { duration: 4, fps: '15', width: '480' };

  it('builds a GIF with its own palette, never upscaling', () => {
    const args = buildFfmpegArgs('in.mp4', 'out.gif', { ...options, format: 'gif' });
    const filters = lastValue(args, '-vf');
    expect(filters).toContain("fps=15,scale='min(480,iw)':-1");
    expect(filters).toContain('palettegen');
    expect(filters).toContain('paletteuse');
    expect(lastValue(args, '-t')).toBe('4');
    expect(lastValue(args, '-loop')).toBe('0');
    expect(args.at(-1)).toBe('out.gif');
  });

  it('builds an animated WebP', () => {
    const args = buildFfmpegArgs('in.mp4', 'out.webp', { ...options, format: 'webp' });
    expect(lastValue(args, '-c:v')).toBe('libwebp_anim');
    expect(lastValue(args, '-vf')).not.toContain('palettegen');
  });

  it('seeks before the input only when needed', () => {
    const seeking = buildFfmpegArgs('in.mp4', 'out.gif', { ...options, format: 'gif', seek: 12.5 });
    expect(lastValue(seeking, '-ss')).toBe('12.5');
    expect(seeking.indexOf('-ss')).toBeLessThan(seeking.indexOf('-i'));
    expect(buildFfmpegArgs('in.mp4', 'out.gif', { ...options, format: 'gif' })).not.toContain('-ss');
  });

  it('drops audio and reports progress on stdout', () => {
    const args = buildFfmpegArgs('in.mp4', 'out.gif', { ...options, format: 'gif' });
    expect(args).toContain('-an');
    expect(lastValue(args, '-progress')).toBe('pipe:1');
  });
});
