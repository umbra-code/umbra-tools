// Metadata tool: which fields each kind of file has, request validation, and the pure
// conversions (dates, locations, ffmpeg arguments) so they can be tested without files.
import { httpError } from '../../core/errors.js';
import { pickAllowed } from '../../core/input.js';

/** Editable fields per kind of file, in display order. */
export const FIELDS = {
  image: ['title', 'author', 'copyright', 'date'],
  audio: ['title', 'author', 'album', 'date', 'genre', 'comment', 'copyright'],
  video: ['title', 'author', 'date', 'comment', 'copyright'],
  pdf: ['title', 'author', 'subject', 'keywords'],
};

const LABELS = {
  title: 'Title',
  author: 'Author',
  album: 'Album',
  date: 'Date',
  genre: 'Genre',
  comment: 'Comment',
  copyright: 'Copyright',
  subject: 'Subject',
  keywords: 'Keywords',
};

export const fieldLabel = (kind, key) => (key === 'author' && kind !== 'pdf' && kind !== 'image' ? 'Artist' : LABELS[key]);

/** ffmpeg tag for each field (audio and video). */
export const FFMPEG_TAGS = {
  title: 'title',
  author: 'artist',
  album: 'album',
  date: 'date',
  genre: 'genre',
  comment: 'comment',
  copyright: 'copyright',
};

/** Audio containers that can hold a cover image. */
export const COVER_FORMATS = ['mp3', 'm4a', 'flac'];

export const OPTIONS = {
  clean: ['on', 'off'],
  cover: ['keep', 'remove', 'replace'],
};

export const DEFAULTS = {
  clean: 'on',
  cover: 'keep',
};

const MAX_VALUE_LENGTH = 1000;

/** Trims a typed value and drops control characters (line breaks are kept for comments). */
// eslint-disable-next-line no-control-regex
const cleanValue = (value) => String(value ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim();

/**
 * `fields` (a JSON object of field → value; empty values remove the field), `clean`
 * (remove everything else) and `cover` (keep, remove or replace the cover of an audio file).
 */
export function parseOptions(body = {}) {
  const options = pickAllowed(body, OPTIONS, DEFAULTS);

  let raw = {};
  if (body.fields != null && body.fields !== '') {
    try {
      raw = typeof body.fields === 'string' ? JSON.parse(body.fields) : body.fields;
    } catch {
      throw httpError(400, 'The fields could not be read');
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw httpError(400, 'The fields could not be read');

  const known = new Set(Object.values(FIELDS).flat());
  const fields = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) throw httpError(400, `Unknown field: ${key}`);
    const text = cleanValue(value);
    if (text.length > MAX_VALUE_LENGTH) throw httpError(400, `${LABELS[key]} is too long`);
    fields[key] = text;
  }
  return { ...options, fields };
}

/** Only the fields a kind of file has (others sent by the client are ignored). */
export const fieldsFor = (kind, fields) =>
  Object.fromEntries(Object.entries(fields).filter(([key]) => FIELDS[kind].includes(key)));

/**
 * "2024-05-01" or "2024-05-01 18:30" → "2024:05:01 18:30:00", EXIF's date format.
 * Throws a readable error for anything else.
 */
export function toExifDate(text) {
  const match = String(text).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) throw new Error('Write the date like 2024-05-01 or 2024-05-01 18:30');
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = match;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31 || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) {
    throw new Error('That date does not exist');
  }
  return `${y}:${mo}:${d} ${h}:${mi}:${s}`;
}

/** An EXIF date ("2024:05:01 18:30:00" or a Date) → "2024-05-01 18:30", for display and editing. */
export function fromExifDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 16).replace('T', ' ');
  const match = String(value ?? '').match(/^(\d{4}):(\d{2}):(\d{2})(?: (\d{2}):(\d{2}))?/);
  if (!match) return '';
  const [, y, mo, d, h, mi] = match;
  return h ? `${y}-${mo}-${d} ${h}:${mi}` : `${y}-${mo}-${d}`;
}

/** EXIF GPS coordinates ([degrees, minutes, seconds] + "N"/"S"/"E"/"W") → decimal degrees. */
export function fromExifGps(dms, ref) {
  if (!Array.isArray(dms) || dms.length < 3) return null;
  const [deg, min, sec] = dms.map(Number);
  if (![deg, min, sec].every(Number.isFinite)) return null;
  const value = deg + min / 60 + sec / 3600;
  return ref === 'S' || ref === 'W' ? -value : value;
}

/** ISO 6709 location as phones store it in videos ("+40.4168-003.7038+650.000/") → [lat, lon]. */
export function parseIso6709(text) {
  const match = String(text ?? '').match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

export const formatCoordinates = ([lat, lon]) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

// --- XMP ------------------------------------------------------------------------------
// EXIF text is ASCII only ("José" becomes "Jose"), so image fields are also written as XMP,
// which is UTF-8 and is what this tool reads first.

const escapeXml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

const unescapeXml = (value) =>
  value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, code) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[code.toLowerCase()];
    if (named) return named;
    return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
  });

/** An XMP packet with the edited image fields (title, author, copyright, date), or null when empty. */
export function buildXmp(fields) {
  const alt = (tag, value) => `<${tag}><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(value)}</rdf:li></rdf:Alt></${tag}>`;
  const parts = [
    fields.title && alt('dc:title', fields.title),
    fields.author && `<dc:creator><rdf:Seq><rdf:li>${escapeXml(fields.author)}</rdf:li></rdf:Seq></dc:creator>`,
    fields.copyright && alt('dc:rights', fields.copyright),
    fields.date && `<photoshop:DateCreated>${toExifDate(fields.date).replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1-$2-$3T')}</photoshop:DateCreated>`,
  ].filter(Boolean);
  if (!parts.length) return null;
  return [
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/">',
    ...parts,
    '</rdf:Description></rdf:RDF></x:xmpmeta>',
  ].join('');
}

/**
 * The image fields found in an XMP packet, plus what else it holds: `other` (editing history,
 * camera settings…) and `location` (GPS coordinates, which XMP can carry too).
 */
export function readXmp(xmp) {
  const xml = String(xmp ?? '');
  const item = (tag) => {
    const match = xml.match(new RegExp(`<${tag}>[\\s\\S]*?<rdf:li[^>]*>([\\s\\S]*?)</rdf:li>`));
    return match ? unescapeXml(match[1]).trim() : '';
  };
  const date = xml.match(/photoshop:DateCreated(?:="([^"]+)"|>([^<]+)<)/) ?? xml.match(/xmp:CreateDate(?:="([^"]+)"|>([^<]+)<)/);
  const iso = date ? (date[1] ?? date[2]).trim() : '';

  return {
    fields: {
      title: item('dc:title'),
      author: item('dc:creator'),
      copyright: item('dc:rights'),
      date: /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 16).replace('T', ' ').replace(/ $/, '') : '',
    },
    other: /xmpMM:|stEvt:|photoshop:History|tiff:|aux:|crs:|exif:(?!GPS)/.test(xml),
    location: /exif:GPSLatitude/.test(xml),
  };
}

/**
 * ffmpeg arguments to rewrite the metadata of `input` into `output` without re-encoding.
 * `fields` are the edited values (empty = remove); `clean` drops every other tag (title,
 * location, device, per-stream tags…); for audio, `cover` keeps, removes or replaces
 * (`coverPath`) the cover image. Data tracks (like phones' metadata tracks) are left out.
 */
export function buildMediaArgs(input, output, { kind, ext, fields, clean, cover = 'keep', coverPath = null }) {
  const canCover = kind === 'audio' && COVER_FORMATS.includes(ext);
  const newCover = canCover && cover === 'replace' && coverPath;

  const maps =
    kind === 'video'
      ? ['-map', '0:v', '-map', '0:a?', ...(['mkv', 'webm'].includes(ext) ? ['-map', '0:s?'] : [])]
      : ['-map', '0:a', ...(newCover ? ['-map', '1:v'] : canCover && cover === 'keep' ? ['-map', '0:v?'] : [])];

  const tags = Object.entries(fields).flatMap(([key, value]) => ['-metadata', `${FFMPEG_TAGS[key]}=${value}`]);

  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i', input,
    ...(newCover ? ['-i', coverPath] : []),
    ...maps,
    '-c', 'copy',
    '-map_metadata', clean ? '-1' : '0',
    ...tags,
    ...(newCover ? ['-disposition:v:0', 'attached_pic'] : []),
    ...(ext === 'mp3' ? ['-id3v2_version', '3'] : []),
    // No "encoder: Lavf…" tags: the output should say nothing about how it was made.
    '-fflags', '+bitexact',
    '-flags:v', '+bitexact',
    '-flags:a', '+bitexact',
    output,
  ];
}
