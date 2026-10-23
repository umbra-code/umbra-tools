// Uploads kept on the server for a while, so a tool can work on the same file many times
// (e.g. live previews while editing an image) without the browser sending it again each time.
// Each one is deleted after UPLOAD_TTL_MINUTES without use, or when the client lets it go.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TEMP_ROOT } from './paths.js';

const TTL_MS = (Number(process.env.UPLOAD_TTL_MINUTES) || 30) * 60_000;
const MAX_KEPT = Number(process.env.MAX_KEPT_UPLOADS) || 50;
const DIR = path.join(TEMP_ROOT, 'kept');

const kept = new Map();

function expireLater(upload) {
  clearTimeout(upload.timer);
  upload.timer = setTimeout(() => removeUpload(upload.id), TTL_MS);
  upload.timer.unref();
}

/** Keeps an uploaded file (as multer left it); returns its public `{ id, name, size }`. */
export function keepUpload(file, name) {
  // Over the limit, the least recently used upload makes room.
  if (kept.size >= MAX_KEPT) removeUpload(kept.keys().next().value);

  fs.mkdirSync(DIR, { recursive: true });
  const id = randomUUID();
  const target = path.join(DIR, id);
  fs.renameSync(file.path, target);
  const upload = { id, path: target, name, size: fs.statSync(target).size, timer: null };
  kept.set(id, upload);
  expireLater(upload);
  return { id, name, size: upload.size };
}

/** The kept upload `{ id, path, name, size }`, or null; using it keeps it alive longer. */
export function getUpload(id) {
  const upload = kept.get(String(id));
  if (!upload) return null;
  // Most recently used last, so the oldest is first in line to make room.
  kept.delete(upload.id);
  kept.set(upload.id, upload);
  expireLater(upload);
  return upload;
}

export function removeUpload(id) {
  const upload = kept.get(String(id));
  if (!upload) return;
  clearTimeout(upload.timer);
  kept.delete(upload.id);
  fs.rm(upload.path, { force: true }, () => {});
}
