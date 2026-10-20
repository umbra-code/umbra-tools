import fs from 'node:fs';
import path from 'node:path';

/** The largest file in `dir`, skipping partial downloads; null when there is none. */
export function largestFile(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => !/\.(part|ytdl|temp)$/i.test(f))
    .map((f) => path.join(dir, f))
    .filter((f) => fs.statSync(f).isFile());
  files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return files[0] || null;
}

/** A name that is safe to use as a file name on every OS (without extension). */
export function safeFileName(name, fallback = 'output') {
  const clean = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 120)
    .trim();
  return clean || fallback;
}

/** "clip.final.mp4" → "clip.final" */
export const stripExtension = (name) => path.parse(String(name ?? '')).name;

/** Files in `dir` (not partial downloads), sorted by name; empty when `dir` does not exist. */
export function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => !/\.(part|ytdl|temp)$/i.test(f))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => path.join(dir, f))
    .filter((f) => fs.statSync(f).isFile());
}

/**
 * A path in `dir` for `name` + `ext` that is not taken yet: "photo.webp", then
 * "photo (2).webp"… so outputs of files with the same name do not overwrite each other.
 */
export function uniquePath(dir, name, ext) {
  let candidate = path.join(dir, `${name}.${ext}`);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${name} (${i}).${ext}`);
  return candidate;
}
