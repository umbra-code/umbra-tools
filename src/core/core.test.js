import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFiles, safeFileName, stripExtension, uniquePath } from './files.js';
import { parseSource, parseUrl, pickAllowed } from './input.js';
import { SPEEDS, speedAudioFilter, speedVideoFilter } from './media.js';
import { formatTime, parseRange, parseTime } from './time.js';

describe('speed filters', () => {
  it('chains atempo below 0.5×, its lowest step, and does nothing at 1×', () => {
    expect(speedAudioFilter(0.25)).toBe('atempo=0.5,atempo=0.5');
    expect(speedAudioFilter(0.5)).toBe('atempo=0.5');
    expect(speedAudioFilter(4)).toBe('atempo=4');
    expect(speedAudioFilter(1)).toBe('');
    expect(speedVideoFilter(1)).toBe('');
    expect(speedVideoFilter(1.5)).toBe('setpts=PTS/1.5');
  });

  it('gives the right tempo for every offered speed', () => {
    for (const speed of SPEEDS.map(Number)) {
      const tempo = speedAudioFilter(speed)
        .split(',')
        .filter(Boolean)
        .reduce((total, step) => total * Number(step.split('=')[1]), 1);
      expect(tempo).toBeCloseTo(speed);
    }
  });
});

describe('parseTime', () => {
  it('reads seconds, m:ss and h:mm:ss, with decimals', () => {
    expect(parseTime('83')).toBe(83);
    expect(parseTime('1:23')).toBe(83);
    expect(parseTime(' 1:23.5 ')).toBe(83.5);
    expect(parseTime('1:02:03')).toBe(3723);
    expect(parseTime(7)).toBe(7);
  });

  it('rejects anything else', () => {
    for (const value of ['', null, undefined, '-1', '1:60', '1:2:3:4', 'abc', '1e3', '1:23:']) {
      expect(parseTime(value)).toBeNull();
    }
  });
});

describe('parseRange', () => {
  it('defaults to the whole media', () => {
    expect(parseRange({})).toEqual({ start: 0, end: null });
    expect(parseRange({ start: ' ', end: '' })).toEqual({ start: 0, end: null });
  });

  it('parses both ends', () => {
    expect(parseRange({ start: '1:00', end: '1:30.5' })).toEqual({ start: 60, end: 90.5 });
  });

  it('can require an end', () => {
    expect(() => parseRange({ start: '5' }, { requireEnd: true })).toThrow(/end time/);
  });

  it('rejects invalid ranges with a 400', () => {
    for (const body of [{ start: 'soon' }, { end: 'later' }, { start: '10', end: '10' }, { start: '10', end: '4' }]) {
      expect(() => parseRange(body)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
});

describe('formatTime', () => {
  it('formats seconds for people', () => {
    expect(formatTime(5)).toBe('0:05');
    expect(formatTime(83.5)).toBe('1:23.5');
    expect(formatTime(3723)).toBe('1:02:03');
  });
});

describe('pickAllowed', () => {
  it('keeps allowed values only', () => {
    const allowed = { size: ['s', 'm'] };
    expect(pickAllowed({ size: 'm', other: 1 }, allowed, { size: 's' })).toEqual({ size: 'm' });
    expect(pickAllowed({ size: 'xl' }, allowed, { size: 's' })).toEqual({ size: 's' });
    expect(pickAllowed(undefined, allowed, { size: 's' })).toEqual({ size: 's' });
  });
});

describe('parseUrl', () => {
  it('accepts http(s) links', () => {
    expect(parseUrl(' https://example.com/a?b=1 ')).toBe('https://example.com/a?b=1');
  });

  it('rejects other values with a 400', () => {
    for (const value of [undefined, 42, 'not a url', 'file:///etc/passwd', 'javascript:alert(1)', `https://x.com/${'a'.repeat(2100)}`]) {
      expect(() => parseUrl(value)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
});

describe('parseSource', () => {
  const file = { path: '/tmp/upload', originalname: 'clip.mp4' };
  const other = { path: '/tmp/upload2', originalname: 'other.mp4' };

  it('prefers the uploaded file', () => {
    expect(parseSource({ url: 'https://example.com' }, [file], ['url', 'file'])).toEqual({
      file: { path: '/tmp/upload', name: 'clip.mp4' },
    });
  });

  it('gives tools that take several files all of them', () => {
    expect(parseSource({}, [file, other], ['files'])).toEqual({
      files: [
        { path: '/tmp/upload', name: 'clip.mp4' },
        { path: '/tmp/upload2', name: 'other.mp4' },
      ],
    });
  });

  it('falls back to the link', () => {
    expect(parseSource({ url: 'https://example.com' }, [], ['url'])).toEqual({ url: 'https://example.com/' });
    expect(parseSource({ url: 'https://example.com' }, undefined, ['url'])).toEqual({ url: 'https://example.com/' });
  });

  it('rejects sources the tool does not accept', () => {
    expect(() => parseSource({}, [file], ['url'])).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => parseSource({}, [file, other], ['url', 'file'])).toThrow(/one file/);
    expect(() => parseSource({ url: 'https://example.com' }, [], ['file'])).toThrow(/file/);
  });
});

describe('safeFileName', () => {
  it('replaces characters that are not allowed in file names', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(safeFileName('  ..hidden.  ')).toBe('hidden');
    expect(safeFileName('Nuevo PC nuevas manos - ABI')).toBe('Nuevo PC nuevas manos - ABI');
  });

  it('falls back when nothing is left', () => {
    expect(safeFileName('...')).toBe('output');
    expect(safeFileName(undefined, 'clip')).toBe('clip');
  });

  it('caps the length', () => {
    expect(safeFileName('x'.repeat(300))).toHaveLength(120);
  });
});

describe('uniquePath and listFiles', () => {
  it('numbers names that are already taken and lists files by name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-test-'));
    try {
      const first = uniquePath(dir, 'photo', 'webp');
      fs.writeFileSync(first, '');
      const second = uniquePath(dir, 'photo', 'webp');
      fs.writeFileSync(second, '');
      fs.writeFileSync(path.join(dir, 'video.mp4.part'), '');

      expect(path.basename(first)).toBe('photo.webp');
      expect(path.basename(second)).toBe('photo (2).webp');
      expect(listFiles(dir).map((f) => path.basename(f))).toEqual(['photo (2).webp', 'photo.webp']);
      expect(listFiles(path.join(dir, 'missing'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('stripExtension', () => {
  it('removes only the last extension', () => {
    expect(stripExtension('clip.final.mp4')).toBe('clip.final');
    expect(stripExtension('noext')).toBe('noext');
  });
});
