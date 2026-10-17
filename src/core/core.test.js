import { describe, expect, it } from 'vitest';
import { safeFileName, stripExtension } from './files.js';
import { parseSource, parseUrl, pickAllowed } from './input.js';
import { formatTime, parseTime } from './time.js';

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

  it('prefers the uploaded file', () => {
    expect(parseSource({ url: 'https://example.com' }, file, ['url', 'file'])).toEqual({
      file: { path: '/tmp/upload', name: 'clip.mp4' },
    });
  });

  it('falls back to the link', () => {
    expect(parseSource({ url: 'https://example.com' }, undefined, ['url'])).toEqual({ url: 'https://example.com/' });
  });

  it('rejects sources the tool does not accept', () => {
    expect(() => parseSource({}, file, ['url'])).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => parseSource({ url: 'https://example.com' }, undefined, ['file'])).toThrow(/file/);
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

describe('stripExtension', () => {
  it('removes only the last extension', () => {
    expect(stripExtension('clip.final.mp4')).toBe('clip.final');
    expect(stripExtension('noext')).toBe('noext');
  });
});
