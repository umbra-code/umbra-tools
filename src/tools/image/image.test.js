import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertImage, describeImageError, renderImage } from './convert.js';
import {
  DEFAULT_QUALITY,
  DEFAULTS,
  encoderFor,
  hasEdits,
  parseOptions,
  resolveCrop,
  resolveFormat,
  resolveSize,
} from './options.js';
import imageTool from './index.js';

const NO_EDITS = { rotate: 0, flipH: false, flipV: false, crop: null, width: null, height: null };

describe('parseOptions', () => {
  it('uses the defaults: no edits', () => {
    expect(parseOptions({})).toEqual({ ...DEFAULTS, quality: DEFAULT_QUALITY, ...NO_EDITS });
    expect(hasEdits(parseOptions({}))).toBe(false);
  });

  it('keeps allowed values and the quality', () => {
    expect(parseOptions({ format: 'avif', maxSize: '1920', metadata: 'keep', quality: '55' })).toMatchObject({
      format: 'avif',
      maxSize: '1920',
      metadata: 'keep',
      quality: 55,
    });
  });

  it('reads the edits of a single image', () => {
    const options = parseOptions({ rotate: '270', flipH: '1', cropX: '10', cropY: '0', cropWidth: '50', cropHeight: '40', width: '25' });
    expect(options).toMatchObject({ rotate: 270, flipH: true, crop: { left: 10, top: 0, width: 50, height: 40 }, width: 25, height: null });
    expect(hasEdits(options)).toBe(true);
  });

  it('rejects a quality outside 1–100, half a crop and bad sizes', () => {
    for (const body of [{ quality: '0' }, { quality: '101' }, { quality: '50.5' }, { quality: 'high' }, { cropX: '1' }, { width: '-3' }, { height: '99999' }]) {
      expect(() => parseOptions(body)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
});

describe('resolveCrop and resolveSize', () => {
  it('uses the whole image without a crop, and refuses crops outside it', () => {
    expect(resolveCrop(null, 200, 100)).toEqual({ left: 0, top: 0, width: 200, height: 100 });
    expect(() => resolveCrop({ left: 150, top: 0, width: 60, height: 10 }, 200, 100)).toThrow(/outside/);
  });

  it('keeps the proportions when only one side is given, and fits the max size otherwise', () => {
    const crop = { width: 400, height: 300 };
    expect(resolveSize(crop, 200, null)).toEqual({ width: 200, height: 150 });
    expect(resolveSize(crop, null, 30)).toEqual({ width: 40, height: 30 });
    expect(resolveSize(crop, 10, 10)).toEqual({ width: 10, height: 10 });
    expect(resolveSize(crop, null, null)).toEqual({ width: 400, height: 300 });
    expect(resolveSize(crop, null, null, 200)).toEqual({ width: 200, height: 150 });
    expect(resolveSize(crop, null, null, 1000)).toEqual({ width: 400, height: 300 });
  });
});

describe('editing one image', () => {
  let dir;
  let quadrants;
  const RED = [255, 0, 0];
  const GREEN = [0, 255, 0];
  const BLUE = [0, 0, 255];
  const WHITE = [255, 255, 255];
  const base = { ...parseOptions({}), format: 'png' };

  /** The color of the pixel at (x, y) of an encoded image. */
  const pixel = async (input, x, y) => {
    const { data, info } = await sharp(input).raw().toBuffer({ resolveWithObject: true });
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const render = (options) => renderImage(quadrants, { ...base, ...options });

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-edit-'));
    // 200×100: red top-left, green top-right, blue bottom-left, white bottom-right.
    const [width, height] = [200, 100];
    const data = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        data.set(y < 50 ? (x < 100 ? RED : GREEN) : x < 100 ? BLUE : WHITE, (y * width + x) * 3);
      }
    }
    quadrants = path.join(dir, 'quadrants.png');
    await sharp(data, { raw: { width, height, channels: 3 } }).png().toFile(quadrants);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('rotates clockwise: the bottom-left corner ends up top-left', async () => {
    const result = await render({ rotate: 90 });
    expect([result.width, result.height]).toEqual([100, 200]);
    expect(await pixel(result.data, 0, 0)).toEqual(BLUE);
  });

  it('flips horizontally and vertically', async () => {
    expect(await pixel((await render({ flipH: true })).data, 0, 0)).toEqual(GREEN);
    expect(await pixel((await render({ flipV: true })).data, 0, 0)).toEqual(BLUE);
  });

  it('crops in the coordinates of the rotated image, as the preview shows it', async () => {
    const result = await render({ rotate: 90, crop: { left: 0, top: 0, width: 50, height: 100 } });
    expect([result.width, result.height]).toEqual([50, 100]);
    expect(await pixel(result.data, 0, 0)).toEqual(BLUE);
    expect(await pixel(result.data, 49, 99)).toEqual(BLUE);
  });

  it('resizes the crop to an exact size, or to fit the max size', async () => {
    const exact = await render({ crop: { left: 100, top: 50, width: 100, height: 50 }, width: 40 });
    expect([exact.width, exact.height]).toEqual([40, 20]);
    expect(await pixel(exact.data, 20, 10)).toEqual(WHITE);
    const fitted = await render({ rotate: 180, maxSize: '400', crop: { left: 0, top: 0, width: 200, height: 100 } });
    expect([fitted.width, fitted.height]).toEqual([200, 100]);
  });

  it('keeps the metadata after editing when asked', async () => {
    const photo = path.join(dir, 'camera.jpg');
    await sharp({ create: { width: 60, height: 40, channels: 3, background: '#888' } }).jpeg().withExif({ IFD0: { Make: 'PhoneCo' } }).toFile(photo);
    const options = { ...parseOptions({}), format: 'jpg', crop: { left: 0, top: 0, width: 30, height: 20 } };
    const kept = await renderImage(photo, { ...options, metadata: 'keep' });
    expect((await sharp(kept.data).metadata()).exif?.toString('latin1')).toContain('PhoneCo');
    const removed = await renderImage(photo, options);
    expect((await sharp(removed.data).metadata()).exif).toBeUndefined();
  });

  it('previews a kept upload with its format, size and weight', async () => {
    const { data, contentType, meta } = await imageTool.preview({ path: quadrants, name: 'quadrants.png' }, { ...base, format: 'webp', rotate: 90 });
    expect(contentType).toBe('image/webp');
    expect(meta).toEqual({ format: 'webp', width: 100, height: 200, size: data.length, name: 'quadrants.webp' });
  });

  it('refuses to crop a batch, where the box would land somewhere else on each image', async () => {
    const ctx = { files: [{}, {}], options: { ...base, crop: { left: 0, top: 0, width: 10, height: 10 } } };
    await expect(imageTool.run(ctx)).rejects.toThrow(/one image at a time/);
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
