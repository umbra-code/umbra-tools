// Reads what a file says about itself: editable fields, plus read-only details
// (camera, software, location…) flagged when they are sensitive.
import fs from 'node:fs/promises';
import path from 'node:path';
import exifReader from 'exif-reader';
import { PDFDocument, PDFName } from 'pdf-lib';
import sharp from '../../core/sharp.js';
import { BINARIES } from '../../core/paths.js';
import { runProcess } from '../../core/process.js';
import {
  COVER_FORMATS,
  FIELDS,
  fieldLabel,
  formatCoordinates,
  fromExifDate,
  fromExifGps,
  parseIso6709,
  readXmp,
} from './fields.js';

const IMAGE_FORMATS = ['jpeg', 'png', 'webp', 'heif', 'tiff', 'gif'];
// Container bookkeeping that every file of a format has; not worth showing.
const CONTAINER_TAGS = new Set(['major_brand', 'minor_version', 'compatible_brands', 'handler_name', 'vendor_id', 'language']);

const text = (value) => String(value ?? '').replace(/\0+$/, '').trim();
const detail = (label, value, sensitive = false) => (text(value) ? [{ label, value: text(value), sensitive }] : []);

/** ffprobe's view of a media file, or null when ffmpeg cannot read it. */
export async function ffprobe(file) {
  const lines = [];
  try {
    const { code } = await runProcess(
      BINARIES.ffprobe,
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
      { onLine: (line) => lines.push(line) },
    );
    if (code !== 0) return null;
    return JSON.parse(lines.join('\n'));
  } catch {
    return null;
  }
}

/** 'image', 'audio', 'video' or 'pdf'; null when the file is none of them. */
export async function detectKind(file) {
  const handle = await fs.open(file);
  const head = Buffer.alloc(5);
  await handle.read(head, 0, 5, 0);
  await handle.close();
  if (head.toString('latin1') === '%PDF-') return 'pdf';

  try {
    if (IMAGE_FORMATS.includes((await sharp(file).metadata()).format)) return 'image';
  } catch {
    // not an image sharp knows; maybe audio or video
  }

  const probe = await ffprobe(file);
  // ffmpeg reads any text file as "tty" (ANSI art) video: that is not a video.
  if (!probe || probe.format?.format_name === 'tty') return null;
  // A cover image inside an audio file is a "video" stream marked as an attached picture.
  const streams = (probe.streams ?? []).filter((s) => !s.disposition?.attached_pic);
  if (streams.some((s) => s.codec_type === 'video')) return 'video';
  if (streams.some((s) => s.codec_type === 'audio')) return 'audio';
  return null;
}

const asFields = (kind, values) => FIELDS[kind].map((key) => ({ key, label: fieldLabel(kind, key), value: text(values[key]) }));

async function readImage(file) {
  const meta = await sharp(file).metadata();
  let exif = {};
  try {
    if (meta.exif) exif = exifReader(meta.exif);
  } catch {
    // unreadable EXIF: treated as none
  }
  const image = exif.Image ?? {};
  const photo = exif.Photo ?? {};
  const gps = exif.GPSInfo ?? {};

  const lat = fromExifGps(gps.GPSLatitude, gps.GPSLatitudeRef);
  const lon = fromExifGps(gps.GPSLongitude, gps.GPSLongitudeRef);
  const camera = [text(image.Make), text(image.Model)].filter(Boolean).join(' ');
  // XMP keeps accents that EXIF cannot, so its values win when both have one.
  const xmp = readXmp(meta.xmp?.toString('utf8'));
  const pick = (key, exifValue) => xmp.fields[key] || text(exifValue);

  const location =
    lat != null && lon != null ? formatCoordinates([lat, lon]) : xmp.location ? 'stored in the XMP data' : '';

  return {
    // GIF has no place for EXIF or XMP: it can only be cleaned.
    fields:
      meta.format === 'gif'
        ? []
        : asFields('image', {
            title: pick('title', image.ImageDescription),
            author: pick('author', image.Artist),
            copyright: pick('copyright', image.Copyright),
            date: pick('date', fromExifDate(photo.DateTimeOriginal ?? image.DateTime)),
          }),
    details: [
      ...detail('Location', location, true),
      ...detail('Camera', camera, true),
      ...detail('Lens', photo.LensModel),
      ...detail('Serial number', photo.BodySerialNumber ?? image.CameraSerialNumber, true),
      ...detail('Software', image.Software),
      ...(xmp.other ? detail('XMP data', 'editing history and other app data') : []),
      ...(meta.comments?.length ? detail('Text notes', `${meta.comments.length}`) : []),
    ],
    cover: null,
  };
}

async function readMedia(file, kind, ext) {
  const probe = await ffprobe(file);
  if (!probe) throw new Error('The file could not be read');

  // Ogg and Opus keep their tags on the audio stream; most formats, at file level. A cover's
  // stream has tags of its own (e.g. "comment: Other", its picture type) that are not the song's.
  const tags = {};
  const streams = (probe.streams ?? []).filter((s) => !s.disposition?.attached_pic);
  for (const source of [...streams.map((s) => s.tags), probe.format?.tags]) {
    for (const [key, value] of Object.entries(source ?? {})) tags[key.toLowerCase()] = value;
  }

  const location = parseIso6709(tags['com.apple.quicktime.location.iso6709'] ?? tags.location ?? tags['location-eng']);
  const device = [
    tags['com.apple.quicktime.make'] ?? tags['com.android.manufacturer'] ?? tags.make,
    tags['com.apple.quicktime.model'] ?? tags['com.android.model'] ?? tags.model,
  ]
    .map(text)
    .filter(Boolean)
    .join(' ');

  const shown = new Set(['title', 'artist', 'album_artist', 'author', 'album', 'date', 'year', 'genre', 'comment', 'copyright',
    'location', 'location-eng', 'com.apple.quicktime.location.iso6709', 'com.apple.quicktime.make', 'com.apple.quicktime.model',
    'com.android.manufacturer', 'com.android.model', 'make', 'model', 'com.apple.quicktime.software', 'encoder', 'encoded_by',
    'creation_time']);
  const others = Object.keys(tags).filter((key) => !shown.has(key) && !CONTAINER_TAGS.has(key));
  const hasCover = (probe.streams ?? []).some((s) => s.disposition?.attached_pic);

  return {
    fields: asFields(kind, {
      title: tags.title,
      author: tags.artist ?? tags.album_artist ?? tags.author,
      album: tags.album,
      date: tags.date ?? tags.year,
      genre: tags.genre,
      comment: tags.comment,
      copyright: tags.copyright,
    }),
    details: [
      ...(location ? detail('Location', formatCoordinates(location), true) : []),
      ...detail('Device', device, true),
      ...detail('Software', tags['com.apple.quicktime.software'] ?? tags.encoder ?? tags.encoded_by),
      ...detail('Recorded', tags.creation_time),
      ...(others.length ? detail('Other tags', others.join(', ')) : []),
    ],
    cover: kind === 'audio' ? { supported: COVER_FORMATS.includes(ext), present: hasCover } : null,
  };
}

async function readPdf(file) {
  let doc;
  try {
    doc = await PDFDocument.load(await fs.readFile(file), { updateMetadata: false });
  } catch (err) {
    throw new Error(/encrypted/i.test(err.message) ? 'The PDF is password-protected' : 'The PDF could not be read', { cause: err });
  }
  const date = (value) => (value ? value.toISOString().slice(0, 16).replace('T', ' ') : '');
  return {
    fields: asFields('pdf', {
      title: doc.getTitle(),
      author: doc.getAuthor(),
      subject: doc.getSubject(),
      keywords: doc.getKeywords(),
    }),
    details: [
      ...detail('Made with', doc.getCreator()),
      ...detail('Producer', doc.getProducer()),
      ...detail('Created', date(doc.getCreationDate())),
      ...detail('Modified', date(doc.getModificationDate())),
      ...(doc.catalog.has(PDFName.of('Metadata')) ? detail('XMP data', 'a copy of the details in another format') : []),
    ],
    cover: null,
  };
}

/** What the file at `file` (named `name`) says about itself. */
export async function readMetadata(file, name) {
  const kind = await detectKind(file);
  if (!kind) throw new Error('This is not an image, audio, video or PDF file this tool can read');
  const ext = path.extname(name).slice(1).toLowerCase();
  const data = kind === 'image' ? await readImage(file) : kind === 'pdf' ? await readPdf(file) : await readMedia(file, kind, ext);
  return { kind, ...data };
}
