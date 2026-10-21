import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildMediaArgs,
  buildXmp,
  DEFAULTS,
  fieldsFor,
  fromExifDate,
  fromExifGps,
  parseIso6709,
  parseOptions,
  readXmp,
  toExifDate,
} from './fields.js';
import { readMetadata } from './read.js';
import { writeImage, writePdf } from './write.js';

const lastValue = (args, flag) => args[args.lastIndexOf(flag) + 1];
const valuesOf = (args, flag) => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));

describe('parseOptions', () => {
  it('uses the defaults', () => {
    expect(parseOptions({})).toEqual({ ...DEFAULTS, fields: {} });
  });

  it('reads the fields as JSON, trimming them and dropping control characters', () => {
    const { fields } = parseOptions({ fields: JSON.stringify({ title: '  My song\u0007 ', comment: 'line 1\nline 2' }) });
    expect(fields).toEqual({ title: 'My song', comment: 'line 1\nline 2' });
  });

  it('rejects unknown fields, bad JSON and very long values', () => {
    for (const fields of ['{"password":"x"}', '{not json', '[1]', JSON.stringify({ title: 'x'.repeat(1001) })]) {
      expect(() => parseOptions({ fields })).toThrow(expect.objectContaining({ status: 400 }));
    }
  });

  it('keeps only the fields of each kind of file', () => {
    expect(fieldsFor('image', { title: 'a', album: 'b', copyright: 'c' })).toEqual({ title: 'a', copyright: 'c' });
  });
});

describe('XMP', () => {
  it('round-trips the image fields, escaping XML', () => {
    const xmp = buildXmp({ title: 'A & B', author: 'José', copyright: '© <me>', date: '2024-05-01 18:30' });
    expect(xmp).toContain('A &amp; B');
    expect(readXmp(xmp).fields).toEqual({ title: 'A & B', author: 'José', copyright: '© <me>', date: '2024-05-01 18:30' });
    expect(buildXmp({})).toBeNull();
  });

  it('tells its own fields apart from other app data', () => {
    expect(readXmp(buildXmp({ title: 'x' })).other).toBe(false);
    expect(readXmp('<x:xmpmeta><xmpMM:History/></x:xmpmeta>').other).toBe(true);
  });
});

describe('dates and locations', () => {
  it('converts dates to and from EXIF', () => {
    expect(toExifDate('2024-05-01')).toBe('2024:05:01 00:00:00');
    expect(toExifDate('2024-05-01 18:30')).toBe('2024:05:01 18:30:00');
    expect(fromExifDate('2024:05:01 18:30:07')).toBe('2024-05-01 18:30');
    expect(fromExifDate(new Date('2024-05-01T18:30:00Z'))).toBe('2024-05-01 18:30');
    for (const bad of ['01/05/2024', '2024-13-01', '2024-05-01 25:00', 'yesterday']) expect(() => toExifDate(bad)).toThrow();
  });

  it('reads EXIF GPS and phone video locations', () => {
    expect(fromExifGps([40, 25, 0.6], 'N')).toBeCloseTo(40.41683, 4);
    expect(fromExifGps([3, 42, 13.6], 'W')).toBeCloseTo(-3.70378, 4);
    expect(fromExifGps(undefined, 'N')).toBeNull();
    expect(parseIso6709('+40.4168-003.7038+650.000/')).toEqual([40.4168, -3.7038]);
    expect(parseIso6709('nowhere')).toBeNull();
  });
});

describe('buildMediaArgs', () => {
  const base = { kind: 'audio', ext: 'mp3', fields: {}, clean: true };

  it('copies the streams and drops every other tag when cleaning', () => {
    const args = buildMediaArgs('in.mp3', 'out.mp3', base);
    expect(lastValue(args, '-c')).toBe('copy');
    expect(lastValue(args, '-map_metadata')).toBe('-1');
    expect(args).toContain('+bitexact');
    expect(buildMediaArgs('in.mp3', 'out.mp3', { ...base, clean: false })).toContain('0');
  });

  it('writes the edited fields as tags, empty ones to remove them', () => {
    const args = buildMediaArgs('in.mp3', 'out.mp3', { ...base, fields: { title: 'Song', author: 'Band', album: '' } });
    expect(valuesOf(args, '-metadata')).toEqual(['title=Song', 'artist=Band', 'album=']);
    expect(lastValue(args, '-id3v2_version')).toBe('3');
  });

  it('keeps, removes or replaces the cover of an audio file', () => {
    const maps = (options) => valuesOf(buildMediaArgs('in.mp3', 'out.mp3', { ...base, ...options }), '-map');
    expect(maps({ cover: 'keep' })).toEqual(['0:a', '0:v?']);
    expect(maps({ cover: 'remove' })).toEqual(['0:a']);
    const replaced = buildMediaArgs('in.mp3', 'out.mp3', { ...base, cover: 'replace', coverPath: 'cover.jpg' });
    expect(valuesOf(replaced, '-i')).toEqual(['in.mp3', 'cover.jpg']);
    expect(valuesOf(replaced, '-map')).toEqual(['0:a', '1:v']);
    expect(lastValue(replaced, '-disposition:v:0')).toBe('attached_pic');
  });

  it('ignores covers for formats that cannot hold one', () => {
    const args = buildMediaArgs('in.opus', 'out.opus', { ...base, ext: 'opus', cover: 'replace', coverPath: 'cover.jpg' });
    expect(valuesOf(args, '-i')).toEqual(['in.opus']);
    expect(valuesOf(args, '-map')).toEqual(['0:a']);
  });

  it('keeps video and audio but leaves out data tracks for videos', () => {
    expect(valuesOf(buildMediaArgs('in.mov', 'out.mov', { ...base, kind: 'video', ext: 'mov' }), '-map')).toEqual(['0:v', '0:a?']);
    expect(valuesOf(buildMediaArgs('in.mkv', 'out.mkv', { ...base, kind: 'video', ext: 'mkv' }), '-map')).toContain('0:s?');
  });
});

describe('reading and writing files', () => {
  let dir;
  const file = (name) => path.join(dir, name);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-metadata-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A JPEG as a phone would take it: camera, author and GPS in its EXIF. */
  const phonePhoto = async (name) => {
    await sharp({ create: { width: 40, height: 30, channels: 3, background: '#5a7' } })
      .jpeg()
      .withExif({
        IFD0: { Make: 'PhoneCo', Model: 'Phone 9', Artist: 'Old Name', Software: 'Camera 2.0' },
        IFD2: { DateTimeOriginal: '2023:07:14 10:20:30' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '40/1 25/1 6/10', GPSLongitudeRef: 'W', GPSLongitude: '3/1 42/1 136/10' },
      })
      .toFile(file(name));
    return file(name);
  };
  const value = (data, key) => data.fields.find((f) => f.key === key)?.value;
  const labels = (data) => data.details.map((d) => d.label);

  it('shows what a photo says about itself, flagging the location and the camera', async () => {
    const data = await readMetadata(await phonePhoto('read.jpg'), 'read.jpg');
    expect(data.kind).toBe('image');
    expect(value(data, 'author')).toBe('Old Name');
    expect(value(data, 'date')).toBe('2023-07-14 10:20');
    const location = data.details.find((d) => d.label === 'Location');
    expect(location).toMatchObject({ sensitive: true });
    expect(location.value).toMatch(/^40\.4168\d, -3\.7037\d$/);
    expect(data.details.find((d) => d.label === 'Camera')).toMatchObject({ value: 'PhoneCo Phone 9', sensitive: true });
  });

  it('cleans a photo: only the edited fields remain', async () => {
    const input = await phonePhoto('clean.jpg');
    await writeImage(input, file('clean-out.jpg'), { fields: { title: 'Holiday', author: 'Me', date: '2024-01-02 03:04' }, clean: true });
    const data = await readMetadata(file('clean-out.jpg'), 'clean-out.jpg');
    expect(value(data, 'title')).toBe('Holiday');
    expect(value(data, 'author')).toBe('Me');
    expect(value(data, 'date')).toBe('2024-01-02 03:04');
    expect(labels(data)).not.toContain('Location');
    expect(labels(data)).not.toContain('Camera');
  });

  it('edits a photo keeping the rest when not cleaning', async () => {
    const input = await phonePhoto('edit.jpg');
    await writeImage(input, file('edit-out.jpg'), { fields: { author: 'New Name' }, clean: false });
    const data = await readMetadata(file('edit-out.jpg'), 'edit-out.jpg');
    expect(value(data, 'author')).toBe('New Name');
    expect(labels(data)).toContain('Camera');
  });

  it('keeps accents and symbols, which EXIF alone would lose (also in PNG)', async () => {
    await sharp({ create: { width: 10, height: 10, channels: 4, background: '#000' } }).png().toFile(file('plain.png'));
    await writeImage(file('plain.png'), file('plain-out.png'), {
      fields: { author: 'José Núñez', copyright: '© 2026 <Me & Co>' },
      clean: true,
    });
    const data = await readMetadata(file('plain-out.png'), 'plain-out.png');
    expect(value(data, 'author')).toBe('José Núñez');
    expect(value(data, 'copyright')).toBe('© 2026 <Me & Co>');
    // Its own XMP is not reported as leftover app data.
    expect(labels(data)).not.toContain('XMP data');
  });

  it('spots a location stored only in XMP', async () => {
    const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="40,25.01N" exif:GPSLongitude="3,42.23W"/></rdf:RDF></x:xmpmeta>';
    await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).jpeg().withXmp(xmp).toFile(file('xmp-gps.jpg'));
    const before = await readMetadata(file('xmp-gps.jpg'), 'xmp-gps.jpg');
    expect(before.details.find((d) => d.label === 'Location')).toMatchObject({ sensitive: true });

    await writeImage(file('xmp-gps.jpg'), file('xmp-gps-out.jpg'), { fields: {}, clean: true });
    expect(labels(await readMetadata(file('xmp-gps-out.jpg'), 'xmp-gps-out.jpg'))).not.toContain('Location');
  });

  it('cleans a PDF so the old details cannot be dug out of the file', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    doc.setAuthor('Secret Person');
    doc.setCreator('Some Editor');
    fs.writeFileSync(file('doc.pdf'), await doc.save());

    const before = await readMetadata(file('doc.pdf'), 'doc.pdf');
    expect(before.kind).toBe('pdf');
    expect(value(before, 'author')).toBe('Secret Person');
    expect(labels(before)).toContain('Made with');

    await writePdf(file('doc.pdf'), file('doc-out.pdf'), { fields: { title: 'Report', keywords: 'a, b' }, clean: true });
    const after = await readMetadata(file('doc-out.pdf'), 'doc-out.pdf');
    expect(value(after, 'title')).toBe('Report');
    expect(value(after, 'keywords')).toBe('a b');
    expect(value(after, 'author')).toBe('');
    expect(labels(after)).not.toContain('Made with');
    expect(fs.readFileSync(file('doc-out.pdf')).toString('latin1')).not.toContain('Secret Person');
  });

  it('rejects files it cannot read', async () => {
    fs.writeFileSync(file('notes.txt'), 'hello');
    await expect(readMetadata(file('notes.txt'), 'notes.txt')).rejects.toThrow(/not an image, audio, video or PDF/);
  });
});
