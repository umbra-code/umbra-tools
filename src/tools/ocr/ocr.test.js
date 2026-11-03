import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from '../../core/sharp.js';
import { createReader, prepareForOcr, readText } from './ocr.js';
import { DEFAULTS, parseOptions, tidyText, upscaleFactor } from './options.js';

describe('options', () => {
  it('reads Spanish and English by default and only offers known languages', () => {
    expect(parseOptions({})).toEqual(DEFAULTS);
    expect(parseOptions({ lang: 'eng' }).lang).toBe('eng');
    expect(parseOptions({ lang: 'klingon' }).lang).toBe(DEFAULTS.lang);
  });

  it('tidies the text for pasting', () => {
    expect(tidyText('  first line  \nsecond\t\n\n\n\nthird\n')).toBe('first line\nsecond\n\nthird');
  });

  it('enlarges small images, up to 3×, and leaves big ones alone', () => {
    expect(upscaleFactor(400)).toBe(3);
    expect(upscaleFactor(1000)).toBeCloseTo(1.6);
    expect(upscaleFactor(2400)).toBe(1);
  });
});

/** A screenshot-like picture of `lines`, light or dark. */
function screenshot(lines, { dark = false, size = 15 } = {}) {
  const [bg, fg] = dark ? ['#1e1f22', '#dbdee1'] : ['#ffffff', '#1f2328'];
  const text = lines
    .map((line, i) => `<text x="16" y="${Math.round(size * 1.5 + i * size * 1.6)}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" fill="${fg}">${line}</text>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 32}" height="${Math.round(size * 1.6 * lines.length + size)}"><rect width="100%" height="100%" fill="${bg}"/>${text}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe('preparing a picture', () => {
  it('turns dark mode into dark text on light, in greys, enlarged', async () => {
    const prepared = await prepareForOcr(await screenshot(['Hola'], { dark: true }));
    const meta = await sharp(prepared).metadata();
    const { channels } = await sharp(prepared).stats();
    expect(meta.width).toBe(32 * 15 * 3);
    expect(channels).toHaveLength(1);
    expect(channels[0].mean).toBeGreaterThan(128);
  });
});

// Reads real text with Tesseract (WebAssembly; no binaries needed).
describe('reading text', { timeout: 60_000 }, () => {
  let reader;
  beforeAll(async () => {
    reader = await createReader(['spa', 'eng']);
  });
  afterAll(() => reader?.terminate());

  const LINES = ['Reunión mañana a las 10:30 en la sala 4B.', 'Confirmar con José el presupuesto: $1.250.000'];

  it('reads a screenshot, accents included', async () => {
    const { text, confidence } = await readText(reader, await screenshot(LINES));
    expect(text).toContain('Reunión mañana');
    expect(text).toContain('José el presupuesto');
    expect(text.split('\n')).toHaveLength(2);
    expect(confidence).toBeGreaterThan(70);
  });

  it('reads dark mode screenshots too', async () => {
    const { text } = await readText(reader, await screenshot(LINES, { dark: true }));
    expect(text).toContain('presupuesto');
  });

  it('finds nothing in a picture without text', async () => {
    const blank = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#4a7' } }).png().toBuffer();
    expect((await readText(reader, blank)).text).toBe('');
  });
});
