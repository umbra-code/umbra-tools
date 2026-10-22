// Keeps yt-dlp current: sites (YouTube above all) change often and yt-dlp follows within days,
// so an old copy is the most common reason downloads stop working. On startup, if the last
// check was more than a week ago, `yt-dlp -U` runs in the background (yt-dlp updates itself).
// YTDLP_AUTO_UPDATE=0 turns this off; a custom YTDLP_PATH is never touched.
import fs from 'node:fs/promises';
import path from 'node:path';
import { BINARIES } from '../../core/paths.js';
import { runProcess } from '../../core/process.js';

export const CHECK_EVERY_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const STAMP = path.join(path.dirname(BINARIES.ytdlp), '.ytdlp-checked');

let pending = null;

/** Resolves once a running update is over, so no download uses yt-dlp while it replaces itself. */
export const ytdlpUpdated = () => pending ?? Promise.resolve();

/** True when the last check (`lastCheckMs`, null if never) is older than `days`. */
export const isDue = (lastCheckMs, nowMs, days = CHECK_EVERY_DAYS) => lastCheckMs == null || nowMs - lastCheckMs >= days * DAY_MS;

/**
 * What `yt-dlp -U` said, as `{ updated, version }`: "Updated yt-dlp to stable@2026.10.20"
 * or "yt-dlp is up to date (stable@2026.10.20)". Null when neither was found.
 */
export function readUpdateOutput(lines) {
  for (const line of lines) {
    const updated = line.match(/Updated yt-dlp to\s+(\S+)/i);
    if (updated) return { updated: true, version: updated[1] };
    const current = line.match(/yt-dlp is up to date\s*\(([^)]+)\)/i);
    if (current) return { updated: false, version: current[1] };
  }
  return null;
}

async function lastCheck() {
  try {
    return (await fs.stat(STAMP)).mtimeMs;
  } catch {
    return null;
  }
}

async function update() {
  const lines = [];
  let result;
  try {
    result = await runProcess(BINARIES.ytdlp, ['-U'], { onLine: (line) => lines.push(line) });
  } catch {
    return; // no yt-dlp yet: "npm run setup" will fetch the latest
  }
  const outcome = readUpdateOutput([...lines, ...result.stderr.split(/\r?\n/)]);
  if (result.code !== 0 || !outcome) {
    console.warn('⚠ Could not check for a yt-dlp update (offline?); using the current version.');
    return;
  }
  await fs.writeFile(STAMP, new Date().toISOString());
  console.log(outcome.updated ? `✓ yt-dlp updated to ${outcome.version}` : `✓ yt-dlp is up to date (${outcome.version})`);
}

/** Starts a background update when one is due. Never throws: the app works with what it has. */
export async function autoUpdateYtdlp() {
  if (process.env.YTDLP_AUTO_UPDATE === '0' || process.env.YTDLP_PATH) return;
  if (!isDue(await lastCheck(), Date.now())) return;
  pending = update().finally(() => {
    pending = null;
  });
}
