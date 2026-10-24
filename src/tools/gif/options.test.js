import { describe, expect, it } from 'vitest';
import { animationFilters, animationLength, buildFfmpegArgs, DEFAULTS, MAX_SECONDS, parseOptions } from './options.js';

const lastValue = (args, flag) => args[args.lastIndexOf(flag) + 1];

describe('parseOptions', () => {
  it('parses the range and keeps allowed options', () => {
    const body = { start: '1:05', end: '1:10.5', fps: '20', width: '640', format: 'webp', speed: '2', direction: 'boomerang' };
    expect(parseOptions(body)).toEqual({
      start: 65,
      end: 70.5,
      fps: '20',
      width: '640',
      format: 'webp',
      speed: 2,
      direction: 'boomerang',
    });
  });

  it('starts at 0 and uses defaults when only the end is given', () => {
    expect(parseOptions({ end: '5' })).toEqual({ ...DEFAULTS, speed: 1, start: 0, end: 5 });
  });

  it('falls back to defaults for unknown options', () => {
    const options = parseOptions({ end: '5', fps: '999', width: 'huge', format: 'exe', speed: '100', direction: 'up' });
    expect(options).toMatchObject({ ...DEFAULTS, speed: 1 });
  });

  it('limits the animation too, which lasts longer slowed down', () => {
    expect(() => parseOptions({ end: String(MAX_SECONDS / 2), speed: '0.5' })).not.toThrow();
    expect(() => parseOptions({ end: String(MAX_SECONDS / 2 + 1), speed: '0.5' })).toThrow(/At 0.5×/);
    expect(() => parseOptions({ end: String(MAX_SECONDS), speed: '2' })).not.toThrow();
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

  it('limits what is read, not the result, so a slowed down clip is not cut', () => {
    const args = buildFfmpegArgs('in.mp4', 'out.gif', { ...options, format: 'gif', speed: 0.5 });
    expect(args.indexOf('-t')).toBeLessThan(args.indexOf('-i'));
  });
});

describe('animationFilters', () => {
  const options = { fps: '15', width: '480' };

  it('changes the speed before taking the frames, so fps is the rate of the result', () => {
    expect(animationFilters({ ...options, speed: 2 })).toMatch(/^setpts=PTS\/2,fps=15,scale=/);
    expect(animationFilters({ ...options, speed: 1 })).toMatch(/^fps=15,/);
  });

  it('reverses, or plays forward and back without repeating the frame where it turns', () => {
    expect(animationFilters({ ...options, direction: 'reverse' })).toMatch(/,reverse$/);
    const boomerang = animationFilters({ ...options, direction: 'boomerang' });
    expect(boomerang).toContain('reverse,trim=start_frame=1');
    expect(boomerang).toContain('concat=n=2:v=1:a=0');
  });

  it('keeps its own labels apart from the palette ones', () => {
    const args = buildFfmpegArgs('in.mp4', 'out.gif', { ...options, duration: 4, format: 'gif', direction: 'boomerang' });
    const labels = lastValue(args, '-vf').match(/\[\w+\]/g);
    expect(new Set(labels)).toEqual(new Set(['[fw]', '[bw]', '[rv]', '[a]', '[b]', '[p]']));
  });
});

describe('animationLength', () => {
  it('follows the speed and doubles for a boomerang', () => {
    expect(animationLength(4, { speed: 2, direction: 'forward' })).toBe(2);
    expect(animationLength(4, { speed: 0.5, direction: 'boomerang' })).toBe(16);
  });
});
