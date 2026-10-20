import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS, layoutImage, PAGE_SIZES, parseOptions, parsePageSpec, resolvePages } from './options.js';
import { extractPages, imagesToPdf, mergePdfs } from './pdf.js';

describe('parsePageSpec', () => {
  it('reads single pages, ranges and open ranges', () => {
    expect(parsePageSpec('1-3, 5, 8-')).toEqual([
      { from: 1, to: 3 },
      { from: 5, to: 5 },
      { from: 8, to: null },
    ]);
    expect(parsePageSpec('-4')).toEqual([{ from: 1, to: 4 }]);
    expect(parsePageSpec(' 2 - 6 ')).toEqual([{ from: 2, to: 6 }]);
  });

  it('rejects anything else', () => {
    for (const text of ['', ' , ', 'all', '0', '3-1', '1-2-3', '-', 'a-b', undefined]) {
      expect(parsePageSpec(text)).toBeNull();
    }
  });
});

describe('resolvePages', () => {
  it('turns ranges into 0-based indices, in the order given', () => {
    expect(resolvePages(parsePageSpec('3, 1-2, 9-'), 10)).toEqual([2, 0, 1, 8, 9]);
  });

  it('explains pages that do not exist', () => {
    expect(() => resolvePages(parsePageSpec('2-7'), 5)).toThrow('The PDF has 5 pages; page 7 does not exist');
    expect(() => resolvePages(parsePageSpec('9-'), 5)).toThrow(/page 9/);
  });
});

describe('parseOptions', () => {
  it('uses the defaults', () => {
    expect(parseOptions({})).toEqual(DEFAULTS);
  });

  it('requires valid pages to extract', () => {
    expect(parseOptions({ mode: 'extract', pages: '2-' })).toMatchObject({ mode: 'extract', ranges: [{ from: 2, to: null }] });
    expect(() => parseOptions({ mode: 'extract', pages: 'some' })).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('layoutImage', () => {
  it('makes the page the size of the image for "fit"', () => {
    expect(layoutImage(800, 600, 'fit')).toEqual({ page: [600, 450], box: { x: 0, y: 0, width: 600, height: 450 } });
  });

  it('turns A4 landscape for wide images and fits them inside the margins, centered', () => {
    const { page, box } = layoutImage(4000, 3000, 'a4');
    expect(page).toEqual([PAGE_SIZES.a4[1], PAGE_SIZES.a4[0]]);
    // 4:3 on a landscape A4: the height is the limit, so it touches the top and bottom margins.
    expect(box.height).toBeCloseTo(page[1] - 48, 5);
    expect(box.width).toBeLessThanOrEqual(page[0] - 48);
    expect(box.width / box.height).toBeCloseTo(4 / 3, 5);
    expect(box.x + box.width / 2).toBeCloseTo(page[0] / 2, 5);
    expect(box.y + box.height / 2).toBeCloseTo(page[1] / 2, 5);
  });

  it('never enlarges small images on A4 or letter', () => {
    const { box } = layoutImage(100, 200, 'letter');
    expect([box.width, box.height]).toEqual([75, 150]);
  });
});

describe('PDF operations', () => {
  let dir;

  /** A PDF whose pages have the given widths (so tests can tell them apart). */
  const makePdf = async (name, widths) => {
    const doc = await PDFDocument.create();
    for (const width of widths) doc.addPage([width, 500]);
    const file = path.join(dir, name);
    fs.writeFileSync(file, await doc.save());
    return { path: file, name };
  };
  const widthsOf = async (bytes) => (await PDFDocument.load(bytes)).getPages().map((page) => Math.round(page.getWidth()));

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-pdf-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('merges PDFs in the given order', async () => {
    const a = await makePdf('a.pdf', [100, 101]);
    const b = await makePdf('b.pdf', [200]);
    const c = await makePdf('c.pdf', [300, 301, 302]);
    const reported = [];
    const bytes = await mergePdfs([c, a, b], { onFile: (i) => reported.push(i) });
    expect(await widthsOf(bytes)).toEqual([300, 301, 302, 100, 101, 200]);
    expect(reported).toEqual([0, 1, 2]);
  });

  it('extracts the selected pages', async () => {
    const doc = await makePdf('ten.pdf', [101, 102, 103, 104, 105, 106, 107, 108, 109, 110]);
    const { bytes, pages } = await extractPages(doc, parsePageSpec('9-, 1-2, 5'));
    expect(pages).toBe(5);
    expect(await widthsOf(bytes)).toEqual([109, 110, 101, 102, 105]);
  });

  it('rejects files that are not PDFs', async () => {
    const file = path.join(dir, 'fake.pdf');
    fs.writeFileSync(file, 'definitely not a pdf');
    await expect(mergePdfs([{ path: file, name: 'fake.pdf' }, { path: file, name: 'fake.pdf' }])).rejects.toThrow(
      'fake.pdf does not look like a PDF',
    );
  });

  it('turns images of any format into one page each, upright', async () => {
    const make = async (name, pipeline) => {
      const file = path.join(dir, name);
      await pipeline.toFile(file);
      return { path: file, name };
    };
    const solid = (w, h, background) => sharp({ create: { width: w, height: h, channels: 4, background } });
    const images = [
      await make('photo.jpg', solid(400, 200, '#0a0').jpeg().withMetadata({ orientation: 6 })), // stored sideways
      await make('logo.png', solid(300, 300, { r: 255, g: 0, b: 0, alpha: 0.5 }).png()),
      await make('modern.webp', solid(800, 600, '#00f').webp()),
    ];

    const bytes = await imagesToPdf(images, 'fit');
    const pages = (await PDFDocument.load(bytes)).getPages().map((p) => [p.getWidth(), p.getHeight()]);
    expect(pages).toEqual([
      [150, 300], // 200×400 once upright, at 96 dpi
      [225, 225],
      [600, 450],
    ]);
  });

  it('explains which file is not an image', async () => {
    const file = path.join(dir, 'notes.txt');
    fs.writeFileSync(file, 'hello');
    await expect(imagesToPdf([{ path: file, name: 'notes.txt' }], 'a4')).rejects.toThrow(
      'notes.txt is not an image this tool can read',
    );
  });
});
