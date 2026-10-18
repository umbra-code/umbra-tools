import { describe, expect, it } from 'vitest';
import { clampRange } from './trimmer.js';

const limits = { duration: 100, maxLength: 60 };
const round = ({ start, end }) => ({ start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10 });

describe('clampRange', () => {
  it('keeps a valid range as is', () => {
    expect(clampRange(10, 20, limits)).toEqual({ start: 10, end: 20 });
  });

  it('keeps the range inside the video', () => {
    expect(clampRange(-5, 20, limits)).toEqual({ start: 0, end: 20 });
    expect(clampRange(90, 130, limits)).toEqual({ start: 90, end: 100 });
  });

  it('stops the start handle before the end and within the max length', () => {
    expect(round(clampRange(25, 20, { ...limits, moving: 'start' }))).toEqual({ start: 19.9, end: 20 });
    expect(clampRange(5, 80, { ...limits, moving: 'start' })).toEqual({ start: 20, end: 80 });
  });

  it('stops the end handle after the start and within the max length', () => {
    expect(round(clampRange(20, 15, { ...limits, moving: 'end' }))).toEqual({ start: 20, end: 20.1 });
    expect(clampRange(10, 90, { ...limits, moving: 'end' })).toEqual({ start: 10, end: 70 });
  });

  it('fixes typed ranges by moving the end', () => {
    expect(clampRange(10, 90, limits)).toEqual({ start: 10, end: 70 });
    expect(round(clampRange(30, 10, limits))).toEqual({ start: 30, end: 30.1 });
  });

  it('handles a start at the very end of the video', () => {
    const range = clampRange(100, 100, limits);
    expect(range.end).toBe(100);
    expect(range.start).toBeLessThan(range.end);
  });

  it('works with videos shorter than the max length', () => {
    expect(clampRange(0, 30, { duration: 8, maxLength: 60, moving: 'end' })).toEqual({ start: 0, end: 8 });
  });
});
