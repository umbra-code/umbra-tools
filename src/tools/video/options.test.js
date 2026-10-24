import { describe, expect, it } from 'vitest';
import {
  AUDIO_KBPS,
  buildReversePiece,
  buildVideoPasses,
  DEFAULTS,
  parseOptions,
  reversePieces,
  targetVideoKbps,
  videoCodec,
} from './options.js';

const lastValue = (args, flag) => args[args.lastIndexOf(flag) + 1];

describe('parseOptions', () => {
  it('uses the whole video and defaults when nothing is given', () => {
    expect(parseOptions({})).toEqual({ ...DEFAULTS, speed: 1, start: 0, end: null, targetMb: null });
  });

  it('reads the speed as a number and the direction', () => {
    expect(parseOptions({ speed: '0.25', direction: 'reverse' })).toMatchObject({ speed: 0.25, direction: 'reverse' });
    expect(parseOptions({ speed: '3', direction: 'sideways' })).toMatchObject({ speed: 1, direction: 'forward' });
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
    // On the input: it says how much to read, so a slowed down result is not cut.
    expect(args.indexOf('-t')).toBeLessThan(args.indexOf('-i'));
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

  it('changes the speed of the picture and of the sound', () => {
    const [args] = buildVideoPasses('in.mp4', 'out.mp4', { ...base, speed: 0.25, fps: '30' });
    expect(lastValue(args, '-vf')).toBe('setpts=PTS/0.25,fps=30');
    expect(lastValue(args, '-af')).toBe('atempo=0.5,atempo=0.5');
    expect(buildVideoPasses('in.mp4', 'out.mp4', { ...base, speed: 1 })[0]).not.toContain('-af');
  });

  it('makes odd sides even, as GIFs often have and encoders refuse', () => {
    const [args] = buildVideoPasses('in.gif', 'out.mp4', { ...base, hasAudio: false, oddSize: true, resolution: '720' });
    expect(lastValue(args, '-vf')).toBe("crop=trunc(iw/2)*2:trunc(ih/2)*2,scale=-2:'min(720,ih)'");
  });
});

describe('reversePieces', () => {
  it('covers the range in pieces, last piece first', () => {
    const pieces = reversePieces(1, 24, { width: 640, height: 360, resolution: 'original' });
    expect(pieces.map((p) => p.seek)).toEqual([21, 11, 1]);
    expect(pieces.map((p) => p.duration)).toEqual([3, 10, 10]);
  });

  it('uses shorter pieces for bigger pictures, so they fit in memory', () => {
    const big = reversePieces(0, 10, { width: 3840, height: 2160, resolution: 'original' });
    const shrunk = reversePieces(0, 10, { width: 3840, height: 2160, resolution: '480' });
    expect(big[0].duration).toBe(1);
    expect(shrunk[0].duration).toBeGreaterThan(big[0].duration);
  });
});

describe('buildReversePiece', () => {
  it('cuts the piece, brings it to its size and reverses picture and sound', () => {
    const args = buildReversePiece('in.mp4', 'piece.mkv', { seek: 10, duration: 2, keepAudio: true, resolution: '720' });
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(lastValue(args, '-vf')).toBe("scale=-2:'min(720,ih)',reverse");
    expect(lastValue(args, '-af')).toBe('areverse');
    expect(buildReversePiece('in.mp4', 'piece.mkv', { seek: 0, duration: 2, keepAudio: false, resolution: 'original' })).toContain('-an');
  });
});
