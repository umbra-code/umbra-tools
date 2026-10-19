import { describe, expect, it } from 'vitest';
import { AUDIO_KBPS, buildVideoPasses, DEFAULTS, parseOptions, targetVideoKbps, videoCodec } from './options.js';

const lastValue = (args, flag) => args[args.lastIndexOf(flag) + 1];

describe('parseOptions', () => {
  it('uses the whole video and defaults when nothing is given', () => {
    expect(parseOptions({})).toEqual({ ...DEFAULTS, start: 0, end: null, targetMb: null });
  });

  it('parses the range and the target size', () => {
    expect(parseOptions({ start: '0:10', end: '1:00', mode: 'size', targetMb: '9.5' })).toMatchObject({
      start: 10,
      end: 60,
      mode: 'size',
      targetMb: 9.5,
    });
  });

  it('ignores the target size in quality mode', () => {
    expect(parseOptions({ targetMb: 'garbage' }).targetMb).toBeNull();
  });

  it('rejects invalid ranges and sizes with a 400', () => {
    const invalid = [
      { start: 'x' },
      { end: 'later' },
      { start: '10', end: '5' },
      { mode: 'size' },
      { mode: 'size', targetMb: '0' },
      { mode: 'size', targetMb: '-3' },
      { mode: 'size', targetMb: '99999' },
    ];
    for (const body of invalid) {
      expect(() => parseOptions(body)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
});

describe('videoCodec', () => {
  it('uses VP9 for webm and the chosen codec otherwise', () => {
    expect(videoCodec({ format: 'webm', codec: 'h265' })).toBe('vp9');
    expect(videoCodec({ format: 'mkv', codec: 'h265' })).toBe('h265');
  });
});

describe('targetVideoKbps', () => {
  it('fits the video and the audio in the target size', () => {
    const kbps = targetVideoKbps(10, 60, true);
    const totalMb = ((kbps + AUDIO_KBPS) * 1000 * 60) / 8 / 1024 / 1024;
    expect(totalMb).toBeLessThan(10);
    expect(totalMb).toBeGreaterThan(9.5);
  });

  it('gives the whole budget to the video when there is no audio', () => {
    expect(targetVideoKbps(10, 60, false) - targetVideoKbps(10, 60, true)).toBe(AUDIO_KBPS);
  });

  it('refuses sizes that would leave almost nothing for the video', () => {
    expect(() => targetVideoKbps(1, 600, true)).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('buildVideoPasses', () => {
  const base = { ...DEFAULTS, hasAudio: true, duration: null };

  it('encodes H.264 + AAC at constant quality in one pass', () => {
    const passes = buildVideoPasses('in.mkv', 'out.mp4', base);
    expect(passes).toHaveLength(1);
    const [args] = passes;
    expect(lastValue(args, '-c:v')).toBe('libx264');
    expect(lastValue(args, '-crf')).toBe('23');
    expect(lastValue(args, '-c:a')).toBe('aac');
    expect(lastValue(args, '-movflags')).toBe('+faststart');
    expect(args.at(-1)).toBe('out.mp4');
  });

  it('uses VP9 + Opus for webm, with -b:v 0 for constant quality', () => {
    const [args] = buildVideoPasses('in.mp4', 'out.webm', { ...base, format: 'webm', quality: 'high' });
    expect(lastValue(args, '-c:v')).toBe('libvpx-vp9');
    expect(lastValue(args, '-crf')).toBe('24');
    expect(lastValue(args, '-b:v')).toBe('0');
    expect(lastValue(args, '-c:a')).toBe('libopus');
    expect(args).not.toContain('-movflags');
  });

  it('tags H.265 in mp4 so Apple devices play it', () => {
    const [args] = buildVideoPasses('in.mp4', 'out.mp4', { ...base, codec: 'h265' });
    expect(lastValue(args, '-c:v')).toBe('libx265');
    expect(lastValue(args, '-tag:v')).toBe('hvc1');
  });

  it('scales down (never up) and changes the frame rate only when asked', () => {
    const [args] = buildVideoPasses('in.mp4', 'out.mp4', { ...base, resolution: '720', fps: '30' });
    expect(lastValue(args, '-vf')).toBe("scale=-2:'min(720,ih)',fps=30");
    expect(buildVideoPasses('in.mp4', 'out.mp4', base)[0]).not.toContain('-vf');
  });

  it('drops the audio when asked or when there is none', () => {
    expect(buildVideoPasses('in.mp4', 'out.mp4', { ...base, audio: 'remove' })[0]).toContain('-an');
    const silent = buildVideoPasses('in.mp4', 'out.mp4', { ...base, hasAudio: false })[0];
    expect(silent).toContain('-an');
    expect(silent).not.toContain('0:a:0');
  });

  it('cuts the range only when one is given', () => {
    const [args] = buildVideoPasses('in.mp4', 'out.mp4', { ...base, seek: 12, duration: 30 });
    expect(lastValue(args, '-ss')).toBe('12');
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(lastValue(args, '-t')).toBe('30');
    const whole = buildVideoPasses('in.mp4', 'out.mp4', base)[0];
    expect(whole).not.toContain('-ss');
    expect(whole).not.toContain('-t');
  });

  it('uses two passes at the computed bitrate for a target size', () => {
    const passes = buildVideoPasses('in.mp4', 'out.mp4', { ...base, mode: 'size', videoKbps: 1500 });
    expect(passes).toHaveLength(2);
    const [analysis, encode] = passes;
    expect(lastValue(analysis, '-pass')).toBe('1');
    expect(lastValue(analysis, '-f')).toBe('null');
    expect(analysis).toContain('-an');
    expect(lastValue(encode, '-pass')).toBe('2');
    expect(lastValue(encode, '-b:v')).toBe('1500k');
    expect(encode).not.toContain('-crf');
    expect(encode.at(-1)).toBe('out.mp4');
  });

  it('passes two-pass settings to x265 through its own parameters', () => {
    const [analysis] = buildVideoPasses('in.mp4', 'out.mp4', { ...base, codec: 'h265', mode: 'size', videoKbps: 900 });
    expect(lastValue(analysis, '-x265-params')).toBe('pass=1:stats=passlog');
    expect(analysis).not.toContain('-pass');
  });
});
