import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { editImage } from './edit.js';
import { DEFAULTS, parseOptions, resolveCrop, resolveSize } from './options.js';

describe('parseOptions', () => {
  it('uses the defaults: no change at all', () => {
    expect(parseOptions({})).toEqual({
      rotate: 0,
      flipH: false,
      flipV: false,
      format: DEFAULTS.format,
      crop: null,
      width: null,
      height: null,
    });
  });

  it('reads the transforms, the crop and the size', () => {
    expect(parseOptions({ rotate: '270', flipH: '1', cropX: '10', cropY: '0', cropWidth: '50', cropHeight: '40', width: '25' })).toMatchObject({
      rotate: 270,
      flipH: true,
      crop: { left: 10, top: 0, width: 50, height: 40 },
      width: 25,
      height: null,
    });
  });

  it('rejects half a crop and bad numbers', () => {
    for (const body of [{ cropX: '1' }, { cropX: '0', cropY: '0', cropWidth: '0', cropHeight: '5' }, { width: '-3' }, { width: '2.5' }, { height: '99999' }]) {
      expect(() => parseOptions(body)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
});

describe('resolveCrop and resolveSize', () => {
  it('uses the whole image without a crop, and refuses crops outside it', () => {
    expect(resolveCrop(null, 200, 100)).toEqual({ left: 0, top: 0, width: 200, height: 100 });
    expect(() => resolveCrop({ left: 150, top: 0, width: 60, height: 10 }, 200, 100)).toThrow(/outside/);
  });

  it('keeps the proportions when only one side is given', () => {
    const crop = { width: 400, height: 300 };
    expect(resolveSize(crop, 200, null)).toEqual({ width: 200, height: 150 });
    expect(resolveSize(crop, null, 30)).toEqual({ width: 40, height: 30 });
    expect(resolveSize(crop, 10, 10)).toEqual({ width: 10, height: 10 });
    expect(resolveSize(crop, null, null)).toEqual({ width: 400, height: 300 });
  });
});

describe('editImage', () => {
  let dir;
  let quadrants;
  const RED = [255, 0, 0];
  const GREEN = [0, 255, 0];
  const BLUE = [0, 0, 255];
  const WHITE = [255, 255, 255];

  /** The color of the pixel at (x, y) of an image file. */
  const pixel = async (file, x, y) => {
    const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const edit = (options, name = 'out') => editImage(quadrants, path.join(dir, name), { ...parseOptions({}), ...options });

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-edit-'));
    // 200×100: red top-left, green top-right, blue bottom-left, white bottom-right.
    const width = 200;
    const height = 100;
    const data = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const color = y < 50 ? (x < 100 ? RED : GREEN) : x < 100 ? BLUE : WHITE;
        data.set(color, (y * width + x) * 3);
      }
    }
    quadrants = path.join(dir, 'quadrants.png');
    await sharp(data, { raw: { width, height, channels: 3 } }).png().toFile(quadrants);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('changes nothing without options, keeping the format', async () => {
    const result = await edit({});
    expect(result).toMatchObject({ format: 'png', width: 200, height: 100 });
    expect(path.basename(result.file)).toBe('out.png');
    expect(await pixel(result.file, 0, 0)).toEqual(RED);
  });

  it('rotates clockwise: the bottom-left corner ends up top-left', async () => {
    const result = await edit({ rotate: 90 }, 'rotated');
    expect([result.width, result.height]).toEqual([100, 200]);
    expect(await pixel(result.file, 0, 0)).toEqual(BLUE);
  });

  it('flips horizontally and vertically', async () => {
    expect(await pixel((await edit({ flipH: true }, 'flop')).file, 0, 0)).toEqual(GREEN);
    expect(await pixel((await edit({ flipV: true }, 'flip')).file, 0, 0)).toEqual(BLUE);
  });

  it('crops in the coordinates of the rotated image, as the preview shows it', async () => {
    // Rotated 90°, the left half of the top half is what was the bottom-left (blue) quadrant.
    const result = await edit({ rotate: 90, crop: { left: 0, top: 0, width: 50, height: 100 } }, 'crop');
    expect([result.width, result.height]).toEqual([50, 100]);
    expect(await pixel(result.file, 0, 0)).toEqual(BLUE);
    expect(await pixel(result.file, 49, 99)).toEqual(BLUE);
  });

  it('resizes the crop, keeping its proportions when given one side', async () => {
    const result = await edit({ crop: { left: 100, top: 50, width: 100, height: 50 }, width: 40 }, 'small');
    expect([result.width, result.height]).toEqual([40, 20]);
    expect(await pixel(result.file, 20, 10)).toEqual(WHITE);
  });

  it('turns phone photos upright before anything else', async () => {
    const photo = path.join(dir, 'sideways.jpg');
    await sharp({ create: { width: 300, height: 100, channels: 3, background: '#888' } }).jpeg().withMetadata({ orientation: 6 }).toFile(photo);
    const result = await editImage(photo, path.join(dir, 'upright'), parseOptions({}));
    expect([result.width, result.height]).toEqual([100, 300]);
  });

  it('puts transparent areas on white for JPEG', async () => {
    const clear = path.join(dir, 'clear.png');
    await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(clear);
    const result = await editImage(clear, path.join(dir, 'clear-out'), { ...parseOptions({}), format: 'jpg' });
    expect(path.extname(result.file)).toBe('.jpg');
    expect(Math.min(...(await pixel(result.file, 5, 5)))).toBeGreaterThan(245);
  });

  it('explains files that are not images and crops outside the image', async () => {
    const text = path.join(dir, 'notes.txt');
    fs.writeFileSync(text, 'hello');
    await expect(editImage(text, path.join(dir, 'x'), parseOptions({}))).rejects.toThrow('Not an image this tool can read');
    await expect(edit({ crop: { left: 190, top: 0, width: 20, height: 10 } }, 'outside')).rejects.toThrow(/outside the image \(200×100\)/);
  });
});
