import { describe, expect, it } from 'vitest';
import { anchoredScroll, fitScale } from './viewer.js';

describe('fitScale', () => {
  it('shrinks big images to fit and never enlarges small ones', () => {
    expect(fitScale(2000, 1000, 1000, 800)).toBe(0.5);
    expect(fitScale(1000, 2000, 1000, 800)).toBe(0.4);
    expect(fitScale(300, 200, 1000, 800)).toBe(1);
  });
});

describe('anchoredScroll', () => {
  it('keeps the point under the pointer in place when zooming', () => {
    // At 1×, scrolled to 100, the pointer at 50 is over image pixel 150. At 2× that pixel is
    // at 300, so to keep it under the pointer the scroll must be 250.
    expect(anchoredScroll({ scrollLeft: 100, scrollTop: 0 }, 50, 0, 1, 2)).toEqual({ left: 250, top: 0 });
    // And back: zooming out returns to the same spot.
    expect(anchoredScroll({ scrollLeft: 250, scrollTop: 0 }, 50, 0, 2, 1)).toEqual({ left: 100, top: 0 });
  });
});
