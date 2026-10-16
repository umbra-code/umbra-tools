// Populates bin/ with yt-dlp, ffmpeg and ffprobe.
// Usage: node scripts/setup.js [--force]   (--force re-downloads yt-dlp)
// Set UMBRA_SKIP_SETUP=1 to skip it entirely (CI does not need the binaries).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin');
const exe = process.platform === 'win32' ? '.exe' : '';
const force = process.argv.includes('--force');

const YTDLP_ASSETS = {
  win32: 'yt-dlp.exe',
  darwin: 'yt-dlp_macos',
  linux: process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux',
};

async function downloadYtdlp() {
  const target = path.join(bin, `yt-dlp${exe}`);
  if (fs.existsSync(target) && !force) {
    console.log('✓ yt-dlp already present (use --force to update)');
    return;
  }
  const asset = YTDLP_ASSETS[process.platform];
  if (!asset) throw new Error(`Unsupported platform: ${process.platform}`);

  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  console.log(`↓ Downloading yt-dlp from ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download yt-dlp (HTTP ${res.status})`);

  const tmp = `${target}.download`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o755);
  console.log('✓ yt-dlp ready');
}

function copyBinary(name, source) {
  if (!source || !fs.existsSync(source)) {
    console.warn(`⚠ ${name} not found; install it manually and set FFMPEG_DIR`);
    return;
  }
  const target = path.join(bin, `${name}${exe}`);
  if (fs.existsSync(target) && !force) return;
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o755);
  console.log(`✓ ${name} ready`);
}

if (process.env.UMBRA_SKIP_SETUP) {
  console.log('↷ UMBRA_SKIP_SETUP is set: skipping yt-dlp/ffmpeg setup');
  process.exit(0);
}

fs.mkdirSync(bin, { recursive: true });
await downloadYtdlp();
copyBinary('ffmpeg', require('ffmpeg-static'));
copyBinary('ffprobe', require('ffprobe-static').path);
