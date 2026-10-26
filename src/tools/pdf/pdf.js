// PDF operations with pdf-lib: merge, extract pages and turn images into a PDF.
import fs from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { readableImage } from '../../core/heic.js';
import sharp from '../../core/sharp.js';
import { layoutImage, resolvePages } from './options.js';

/** Opens a PDF, with readable errors for files that are not PDFs or are password-protected. */
async function loadPdf(file, name) {
  const bytes = await fs.readFile(file);
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (/encrypted/i.test(err.message)) throw new Error(`${name} is password-protected`, { cause: err });
    throw new Error(`${name} does not look like a PDF`, { cause: err });
  }
}

/** Joins the PDFs in `files` (`{ path, name }`), in that order. `onFile(i)` reports progress. */
export async function mergePdfs(files, { onFile } = {}) {
  const merged = await PDFDocument.create();
  for (const [i, file] of files.entries()) {
    const doc = await loadPdf(file.path, file.name);
    const pages = await merged.copyPages(doc, doc.getPageIndices());
    for (const page of pages) merged.addPage(page);
    onFile?.(i);
  }
  return merged.save();
}

/** A new PDF with the pages of `file` selected by `ranges` (see parsePageSpec). */
export async function extractPages(file, ranges) {
  const doc = await loadPdf(file.path, file.name);
  const indices = resolvePages(ranges, doc.getPageCount());
  const extracted = await PDFDocument.create();
  for (const page of await extracted.copyPages(doc, indices)) extracted.addPage(page);
  return { bytes: await extracted.save(), pages: indices.length };
}

/**
 * The image as JPEG or PNG bytes, the only formats a PDF can embed directly: photos become
 * JPEG, images with transparency PNG. Also turns sideways phone photos upright.
 */
async function toEmbeddable(path, name) {
  try {
    const file = await readableImage(path);
    const image = sharp(file).rotate();
    const { hasAlpha } = await sharp(file).metadata();
    const { data, info } = await (hasAlpha ? image.png() : image.jpeg({ quality: 92, mozjpeg: true })).toBuffer({
      resolveWithObject: true,
    });
    return { data, png: info.format === 'png', width: info.width, height: info.height };
  } catch (err) {
    throw new Error(`${name} is not an image this tool can read`, { cause: err });
  }
}

/** One page per image in `files` (`{ path, name }`), sized by `pageSize` (see layoutImage). */
export async function imagesToPdf(files, pageSize, { onFile } = {}) {
  const doc = await PDFDocument.create();
  for (const [i, file] of files.entries()) {
    const { data, png, width, height } = await toEmbeddable(file.path, file.name);
    const image = png ? await doc.embedPng(data) : await doc.embedJpg(data);
    const { page, box } = layoutImage(width, height, pageSize);
    doc.addPage(page).drawImage(image, box);
    onFile?.(i);
  }
  return doc.save();
}
