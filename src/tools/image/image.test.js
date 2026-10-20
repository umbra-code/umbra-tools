import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertImage, describeImageError } from './convert.js';
import { DEFAULT_QUALITY, DEFAULTS, encoderFor, parseOptions, resolveFormat } from './options.js';

describe('parseOptions', () => {
  it('uses the defaults', () => {
    expect(parseOptions({})).toEqual({ ...DEFAULTS, quality: DEFAULT_QUALITY });
  });

  it('keeps allowed values and the quality', () => {
    expect(parseOptions({ format: 'avif', maxSize: '1920', metadata: 'keep', quality: '55' })).toEqual({
      format: 'avif',
      maxSize: '1920',
      metadata: 'keep',
      quality: 55,
    });
  });

  it('rejects a quality outside 1–100', () => {
    for (const quality of ['0', '101', '50.5', 'high']) {
      expect(() => parseOptions({ quality })).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
});

describe('resolveFormat', () => {
  it('uses the chosen format', () => {
    expect(resolveFormat({ format: 'png' }, 'webp')).toBe('webp');
  });

  it('keeps the input format for "original", writing PNG when it cannot', () => {
    expect(resolveFormat({ format: 'jpeg' }, 'original')).toBe('jpg');
    expect(resolveFormat({ format: 'gif' }, 'original')).toBe('gif');
    expect(resolveFormat({ format: 'heif', compression: 'av1' }, 'original')).toBe('avif');
    expect(resolveFormat({ format: 'heif', compression: 'hevc' }, 'original')).toBe('png');
    expect(resolveFormat({ format: 'svg' }, 'original')).toBe('png');
  });
});

describe('encoderFor', () => {
  it('maps the quality onto each encoder', () => {
    expect(encoderFor('jpg', 80)).toEqual(['jpeg', { quality: 80, mozjpeg: true }]);
    expect(encoderFor('webp', 70)[1].quality).toBe(70);
    expect(encoderFor('avif', 80)[1].quality).toBe(50);
    expect(encoderFor('png', 10)[1]).not.toHaveProperty('quality');
  });
});

describe('convertImage', () => {
  let dir;
  let out;
  const options = { ...DEFAULTS, quality: 80 };

  /** Writes an image made by sharp and returns its path. */
  const make = async (name, pipeline) => {
    const file = path.join(dir, name);
    await pipeline.toFile(file);
    return file;
  };
  const solid = (width, height, background) => sharp({ create: { width, height, channels: 4, background } });

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-image-'));
    out = path.join(dir, 'out');
    fs.mkdirSync(out);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('converts to the chosen format', async () => {
    const input = await make('red.png', solid(40, 30, '#ff0000').png());
    const result = await convertImage(input, 'red.png', out, { ...options, format: 'webp' });
    expect(path.basename(result.output)).toBe('red.webp');
    expect((await sharp(result.output).metadata()).format).toBe('webp');
  });

  it('puts transparent areas on white when converting to JPEG', async () => {
    const input = await make('clear.png', solid(10, 10, { r: 0, g: 0, b: 0, alpha: 0 }).png());
    const { output } = await convertImage(input, 'clear.png', out, { ...options, format: 'jpg' });
    const [r, g, b] = (await sharp(output).raw().toBuffer()).subarray(0, 3);
    expect(Math.min(r, g, b)).toBeGreaterThan(245);
  });

  it('applies the EXIF orientation of phone photos', async () => {
    // Stored 200×100 but tagged "rotate 90°": it should come out 100×200.
    const input = await make('sideways.jpg', solid(200, 100, '#00ff00').jpeg().withMetadata({ orientation: 6 }));
    const result = await convertImage(input, 'sideways.jpg', out, { ...options, format: 'jpg' });
    expect([result.width, result.height]).toEqual([100, 200]);
  });

  it('shrinks to the max size keeping the aspect ratio, and never enlarges', async () => {
    const big = await make('big.png', solid(4000, 3000, '#0000ff').png());
    expect(await convertImage(big, 'big.png', out, { ...options, maxSize: '800' })).toMatchObject({ width: 800, height: 600 });

    const small = await make('small.png', solid(120, 90, '#0000ff').png());
    expect(await convertImage(small, 'small.png', out, { ...options, maxSize: '800' })).toMatchObject({ width: 120, height: 90 });
  });

  it('keeps animations in WebP and takes the first frame for JPEG', async () => {
    const frames = ['#f00', '#0f0', '#00f'].map((color) => solid(20, 20, color).png().toBuffer());
    const input = await make('blink.gif', sharp(await Promise.all(frames), { join: { animated: true } }).gif());
    expect((await sharp(input).metadata()).pages).toBe(3);

    const webp = await convertImage(input, 'blink.gif', out, { ...options, format: 'webp' });
    expect((await sharp(webp.output).metadata()).pages).toBe(3);
    const jpg = await convertImage(input, 'blink.gif', out, { ...options, format: 'jpg' });
    expect((await sharp(jpg.output).metadata()).pages ?? 1).toBe(1);
  });

  it('removes EXIF metadata unless asked to keep it', async () => {
    const input = await make('camera.jpg', solid(20, 20, '#888').jpeg().withExif({ IFD0: { Copyright: 'umbra test' } }));
    const removed = await convertImage(input, 'camera.jpg', out, { ...options, format: 'jpg' });
    expect((await sharp(removed.output).metadata()).exif).toBeUndefined();
    const kept = await convertImage(input, 'camera.jpg', out, { ...options, format: 'jpg', metadata: 'keep' });
    expect((await sharp(kept.output).metadata()).exif?.toString('latin1')).toContain('umbra test');
  });

  it('does not overwrite outputs with the same name', async () => {
    const input = await make('twin.png', solid(10, 10, '#123').png());
    const first = await convertImage(input, 'twin.png', out, { ...options, format: 'avif' });
    const second = await convertImage(input, 'twin.png', out, { ...options, format: 'avif' });
    expect(path.basename(first.output)).toBe('twin.avif');
    expect(path.basename(second.output)).toBe('twin (2).avif');
  });

  it('rejects files that are not images, with a readable message', async () => {
    const input = path.join(dir, 'notes.txt');
    fs.writeFileSync(input, 'not an image');
    const err = await convertImage(input, 'notes.txt', out, options).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(describeImageError(err, 'notes.txt')).toBe('Not an image this tool can read');
    expect(describeImageError(err, 'IMG_0001.HEIC')).toMatch(/HEIC/);
  });
});
