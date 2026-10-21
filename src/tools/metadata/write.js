// Writes metadata back: images with sharp, audio and video with ffmpeg (no re-encoding), PDFs with pdf-lib.
import fs from 'node:fs/promises';
import { PDFDocument, PDFName } from 'pdf-lib';
import sharp from '../../core/sharp.js';
import { encoderFor, resolveFormat } from '../image/options.js';
import { buildXmp, toExifDate } from './fields.js';

/** EXIF blocks for the edited image fields; `keepEmpty` writes empty values (to blank them out). */
export function exifFor(fields, { keepEmpty = false } = {}) {
  const ifd0 = {};
  const set = (tag, value) => {
    if (value || (keepEmpty && value === '')) ifd0[tag] = value;
  };
  set('ImageDescription', fields.title);
  set('Artist', fields.author);
  set('Copyright', fields.copyright);
  const exif = Object.keys(ifd0).length ? { IFD0: ifd0 } : {};
  // IFD2 is the Exif block, where the date the photo was taken lives.
  if (fields.date) exif.IFD2 = { DateTimeOriginal: toExifDate(fields.date) };
  return exif;
}

/**
 * Rewrites an image in its own format with the edited fields, as EXIF (for apps that only read
 * that) and as XMP (which keeps accents). With `clean`, nothing else is kept (camera, GPS…);
 * otherwise the rest of the EXIF stays and the fields are merged in, while the XMP is replaced.
 * The picture is re-encoded: losslessly for PNG, at high quality for JPEG, WebP and AVIF.
 */
export async function writeImage(input, output, { fields, clean }) {
  const info = await sharp(input).metadata();
  const format = resolveFormat(info, 'original');
  const animated = (info.pages ?? 1) > 1 && ['webp', 'gif'].includes(format);

  let image = sharp(input, { animated }).rotate();
  if (clean) {
    const exif = exifFor(fields);
    if (Object.keys(exif).length) image = image.withExif(exif);
  } else {
    image = image.keepMetadata();
    const exif = exifFor(fields, { keepEmpty: true });
    if (Object.keys(exif).length) image = image.withExifMerge(exif);
  }
  const xmp = format === 'gif' ? null : buildXmp(fields);
  if (xmp) image = image.withXmp(xmp);
  const [encoder, settings] = encoderFor(format, 95);
  await image[encoder](settings).toFile(output);
}

const PDF_FIELDS = { title: 'Title', author: 'Author', subject: 'Subject', keywords: 'Keywords' };

/**
 * Rewrites a PDF's document information. With `clean`, the old information and the XMP copy
 * are deleted from the file (not just unlinked, so they cannot be dug out), and only the
 * edited fields are written.
 */
export async function writePdf(input, output, { fields, clean }) {
  const doc = await PDFDocument.load(await fs.readFile(input), { updateMetadata: false });
  const { context } = doc;

  if (clean) {
    const oldInfo = context.trailerInfo.Info;
    context.trailerInfo.Info = context.register(context.obj({}));
    if (oldInfo) context.delete(oldInfo);

    const xmp = doc.catalog.get(PDFName.of('Metadata'));
    doc.catalog.delete(PDFName.of('Metadata'));
    if (xmp) context.delete(xmp);
  }

  const setters = {
    title: (value) => doc.setTitle(value),
    author: (value) => doc.setAuthor(value),
    subject: (value) => doc.setSubject(value),
    keywords: (value) => doc.setKeywords(value.split(',').map((word) => word.trim()).filter(Boolean)),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value) setters[key](value);
    else if (!clean) doc.getInfoDict().delete(PDFName.of(PDF_FIELDS[key]));
  }

  await fs.writeFile(output, await doc.save());
}
