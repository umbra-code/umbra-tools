import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addPngExif, isHeic, readableImage, uprightExif } from './heic.js';
import sharp from './sharp.js';

// Made for these tests with ffmpeg's libx265 and a hand-written HEIF container: 64 × 48,
// quadrants red, green / blue, white, and EXIF with a camera ("TestCam") and a GPS latitude.
// The "turned" one also tells the viewer to turn it 90° counterclockwise (an irot property).
const fixture = (name) => path.join(import.meta.dirname, 'fixtures', name);

/** The RGB color at (x, y) of an image buffer. */
async function colorAt(image, x, y) {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return [...data.subarray(at, at + 3)];
}

const near = (color, expected) => color.every((value, i) => Math.abs(value - expected[i]) < 12);

describe('readableImage', () => {
  it('decodes HEIC photos into a PNG sharp can work with', async () => {
    const png = await readableImage(fixture('quadrants.heic'));
    const meta = await sharp(png).metadata();
    expect(meta.format).toBe('png');
    expect([meta.width, meta.height, meta.channels]).toEqual([64, 48, 3]);
    expect(near(await colorAt(png, 4, 4), [255, 0, 0])).toBe(true);
    expect(near(await colorAt(png, 60, 4), [0, 255, 0])).toBe(true);
    expect(near(await colorAt(png, 4, 44), [0, 0, 255])).toBe(true);
  });

  it('turns them as the file says, once', async () => {
    const png = await readableImage(fixture('quadrants-turned.heic'));
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height]).toEqual([48, 64]);
    expect(meta.orientation ?? 1).toBe(1);
    // Turned counterclockwise, the green top-right corner is now top-left.
    expect(near(await colorAt(png, 4, 4), [0, 255, 0])).toBe(true);
  });

  it('keeps their EXIF (camera, location…), for the metadata option to decide on', async () => {
    const { exif } = await sharp(await readableImage(fixture('quadrants.heic'))).metadata();
    expect(exif?.toString('latin1')).toContain('TestCam');
  });

  it('leaves other images alone', async () => {
    const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).jpeg().toBuffer();
    expect(await readableImage(jpeg)).toBe(jpeg);
    expect(await isHeic(jpeg)).toBe(false);
    expect(await isHeic(fixture('quadrants.heic'))).toBe(true);
  });
});

describe('EXIF helpers', () => {
  const photoExif = async (orientation) => {
    const jpeg = await sharp({ create: { width: 4, height: 2, channels: 3, background: '#000' } })
      .jpeg()
      .withExif({ IFD0: { Make: 'PhoneCo' } })
      .withMetadata({ orientation })
      .toBuffer();
    return (await sharp(jpeg).metadata()).exif.subarray(6); // without "Exif\0\0"
  };

  it('puts EXIF in a PNG, and can set its orientation to upright leaving the rest', async () => {
    const tiff = await photoExif(6);
    const png = await sharp({ create: { width: 4, height: 2, channels: 3, background: '#000' } }).png().toBuffer();
    expect((await sharp(addPngExif(png, tiff)).metadata()).orientation).toBe(6);

    const meta = await sharp(addPngExif(png, uprightExif(tiff))).metadata();
    expect(meta.orientation).toBe(1);
    expect(meta.exif.toString('latin1')).toContain('PhoneCo');
  });
});
