// Filesystem locations shared by the server and every tool.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const BIN = path.join(ROOT, 'bin');
const EXE = process.platform === 'win32' ? '.exe' : '';
const FFMPEG_DIR = process.env.FFMPEG_DIR || BIN;

export const BINARIES = {
  ytdlp: process.env.YTDLP_PATH || path.join(BIN, `yt-dlp${EXE}`),
  ffmpegDir: FFMPEG_DIR,
  ffmpeg: path.join(FFMPEG_DIR, `ffmpeg${EXE}`),
  ffprobe: path.join(FFMPEG_DIR, `ffprobe${EXE}`),
};

// Every job and upload lives under here; it is wiped on startup and shutdown.
export const TEMP_ROOT = path.join(os.tmpdir(), 'umbra-tools');
export const UPLOAD_DIR = path.join(TEMP_ROOT, 'uploads');
