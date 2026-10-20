// Validation of what clients send: option allowlists and the job's source (a link or an uploaded file).
import { httpError } from './errors.js';

/** Keeps allowed values for each key in `allowed`, falling back to `defaults`. */
export function pickAllowed(input, allowed, defaults) {
  const out = {};
  for (const [key, values] of Object.entries(allowed)) {
    const value = String(input?.[key] ?? '');
    out[key] = values.includes(value) ? value : defaults[key];
  }
  return out;
}

export function parseUrl(value) {
  const err = httpError(400, 'Enter a valid link (http or https)');
  if (typeof value !== 'string' || value.length > 2048) throw err;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw err;
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw err;
  return url.href;
}

/**
 * The job's source: the uploaded files when there are any, a link otherwise.
 * `accepts` lists what the tool supports: 'url', 'file' (exactly one) and/or 'files' (one or more).
 * Returns `{ url }`, `{ file }` or `{ files }`, files as `{ path, name }`.
 */
export function parseSource(body, files = [], accepts) {
  const uploaded = files.map((file) => ({ path: file.path, name: file.originalname }));
  if (uploaded.length) {
    if (accepts.includes('files')) return { files: uploaded };
    if (!accepts.includes('file')) throw httpError(400, 'This tool works with links, not files');
    if (uploaded.length > 1) throw httpError(400, 'This tool works with one file at a time');
    return { file: uploaded[0] };
  }
  if (!accepts.includes('url')) throw httpError(400, 'Choose a file to upload');
  return { url: parseUrl(body?.url) };
}
