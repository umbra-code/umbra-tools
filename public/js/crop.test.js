import { describe, expect, it } from 'vitest';
import { fitAspect, moveRect, resizeRect, roundRect } from './crop.js';

const bounds = { W: 1000, H: 500 };

describe('fitAspect', () => {
  it('uses the whole image without a ratio', () => {
    expect(fitAspect(1000, 500, null)).toEqual({ x: 0, y: 0, w: 1000, h: 500 });
  });

  it('centers the largest rectangle of the ratio', () => {
    expect(fitAspect(1000, 500, 1)).toEqual({ x: 250, y: 0, w: 500, h: 500 });
    expect(fitAspect(1000, 500, 4)).toEqual({ x: 0, y: 125, w: 1000, h: 250 });
  });
});

describe('moveRect', () => {
  it('moves and stops at the edges', () => {
    const rect = { x: 100, y: 100, w: 200, h: 100 };
    expect(moveRect(rect, 50, -20, 1000, 500)).toEqual({ x: 150, y: 80, w: 200, h: 100 });
    expect(moveRect(rect, 5000, 5000, 1000, 500)).toEqual({ x: 800, y: 400, w: 200, h: 100 });
    expect(moveRect(rect, -5000, -5000, 1000, 500)).toEqual({ x: 0, y: 0, w: 200, h: 100 });
  });
});

describe('resizeRect', () => {
  const rect = { x: 100, y: 100, w: 200, h: 100 };

  it('keeps the opposite corner in place', () => {
    expect(resizeRect(rect, 'se', 400, 300, bounds)).toEqual({ x: 100, y: 100, w: 300, h: 200 });
    expect(resizeRect(rect, 'nw', 50, 50, bounds)).toEqual({ x: 50, y: 50, w: 250, h: 150 });
  });

  it('stays inside the image', () => {
    expect(resizeRect(rect, 'se', 5000, 5000, bounds)).toEqual({ x: 100, y: 100, w: 900, h: 400 });
    expect(resizeRect(rect, 'nw', -50, -50, bounds)).toEqual({ x: 0, y: 0, w: 300, h: 200 });
  });

  it('keeps the ratio, also when the image edge stops it', () => {
    const square = resizeRect(rect, 'se', 400, 150, { ...bounds, ratio: 1 });
    expect(square.w).toBeCloseTo(square.h);
    expect(square.w).toBe(300);
    // Pulled far to the right, a square is limited by the image's height (500 - 100 = 400).
    const limited = resizeRect(rect, 'se', 5000, 120, { ...bounds, ratio: 1 });
    expect(limited).toEqual({ x: 100, y: 100, w: 400, h: 400 });
  });

  it('never gets smaller than the minimum', () => {
    expect(resizeRect(rect, 'se', 101, 101, { ...bounds, min: 16 })).toEqual({ x: 100, y: 100, w: 16, h: 16 });
    const tiny = resizeRect(rect, 'se', 101, 101, { ...bounds, ratio: 2, min: 16 });
    expect(tiny.h).toBeCloseTo(16);
    expect(tiny.w).toBeCloseTo(32);
  });
});

describe('roundRect', () => {
  it('rounds to whole pixels inside the image', () => {
    expect(roundRect({ x: 10.4, y: 0.6, w: 99.5, h: 50.2 }, 1000, 500)).toEqual({ x: 10, y: 1, w: 100, h: 50 });
    expect(roundRect({ x: 999.6, y: 0, w: 10, h: 10 }, 1000, 500)).toEqual({ x: 999, y: 0, w: 1, h: 10 });
  });
});
