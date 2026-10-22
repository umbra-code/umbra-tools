import { describe, expect, it } from 'vitest';
import { CHECK_EVERY_DAYS, isDue, readUpdateOutput } from './update.js';

describe('isDue', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 9, 22);

  it('checks when it never did', () => {
    expect(isDue(null, now)).toBe(true);
  });

  it(`checks again after ${CHECK_EVERY_DAYS} days, not before`, () => {
    expect(isDue(now - (CHECK_EVERY_DAYS - 1) * day, now)).toBe(false);
    expect(isDue(now - CHECK_EVERY_DAYS * day, now)).toBe(true);
  });
});

describe('readUpdateOutput', () => {
  it('reads an update', () => {
    const lines = ['Current version: stable@2026.08.19', 'Latest version: stable@2026.10.20', 'Updated yt-dlp to stable@2026.10.20'];
    expect(readUpdateOutput(lines)).toEqual({ updated: true, version: 'stable@2026.10.20' });
  });

  it('reads an up-to-date copy', () => {
    expect(readUpdateOutput(['yt-dlp is up to date (stable@2026.10.20 from yt-dlp/yt-dlp)'])).toEqual({
      updated: false,
      version: 'stable@2026.10.20 from yt-dlp/yt-dlp',
    });
  });

  it('returns null for anything else', () => {
    expect(readUpdateOutput(['ERROR: Unable to obtain version info'])).toBeNull();
    expect(readUpdateOutput([])).toBeNull();
  });
});
