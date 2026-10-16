// Thin wrapper around the yt-dlp binary: metadata lookup and argument building.
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(root, 'bin');
const EXE = process.platform === 'win32' ? '.exe' : '';

export const YTDLP = process.env.YTDLP_PATH || path.join(BIN, `yt-dlp${EXE}`);
const FFMPEG_DIR = process.env.FFMPEG_DIR || BIN;

const BASE_ARGS = [
  '--ignore-config',
  '--no-playlist',
  '--no-warnings',
  '--ffmpeg-location', FFMPEG_DIR,
  // YouTube needs a JS runtime to solve its challenges; reuse the running Node.
  '--js-runtimes', `node:${process.execPath}`,
];

export const OPTIONS = {
  mode: ['video', 'audio', 'mute'],
  videoFormat: ['mp4', 'webm', 'mkv'],
  quality: ['max', '2160', '1440', '1080', '720', '480', '360', '240', '144'],
  audioFormat: ['mp3', 'm4a', 'opus', 'ogg', 'wav', 'flac', 'original'],
  audioBitrate: ['320', '256', '192', '128', '96'],
};

export const DEFAULTS = {
  mode: 'video',
  videoFormat: 'mp4',
  quality: '1080',
  audioFormat: 'mp3',
  audioBitrate: '320',
};

/** Validates client options against the allowlist, falling back to defaults. */
export function sanitizeOptions(input = {}) {
  const out = {};
  for (const [key, allowed] of Object.entries(OPTIONS)) {
    const value = String(input[key] ?? '');
    out[key] = allowed.includes(value) ? value : DEFAULTS[key];
  }
  return out;
}

export function spawnYtdlp(args) {
  return spawn(YTDLP, [...BASE_ARGS, ...args], {
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
}

/** Kills the process and its children (ffmpeg), on Windows too. */
export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  } else {
    child.kill('SIGKILL');
  }
}

/** Extracts a readable message from yt-dlp's stderr. */
export function cleanError(stderr) {
  const lines = stderr.split(/\r?\n/).filter(Boolean);
  const line = lines.reverse().find((l) => l.startsWith('ERROR:')) || lines[0] || 'Unknown error';
  return line
    .replace(/^ERROR:\s*/, '')
    .replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '')
    .slice(0, 300);
}

function run(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawnYtdlp(args);
    let out = '';
    let err = '';
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      killTree(child);
      done(reject, new Error('Request timed out'));
    }, timeoutMs);

    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    child.on('error', (e) =>
      done(reject, e.code === 'ENOENT' ? new Error('yt-dlp is not installed: run "npm run setup"') : e),
    );
    child.on('close', (code) =>
      code === 0 ? done(resolve, out) : done(reject, new Error(cleanError(err))),
    );
  });
}

export async function getInfo(url) {
  const info = JSON.parse(await run(['-J', '--flat-playlist', '--', url]));
  if (info._type === 'playlist') {
    throw new Error('Playlists are not supported yet; use a single video link');
  }
  const heights = [
    ...new Set(
      (info.formats || [])
        .filter((f) => f.vcodec && f.vcodec !== 'none' && f.height)
        .map((f) => f.height),
    ),
  ].sort((a, b) => b - a);

  return {
    id: info.id,
    title: info.title,
    uploader: info.uploader || info.channel || info.uploader_id || null,
    duration: info.duration ?? null,
    thumbnail: info.thumbnail || null,
    site: info.extractor_key || info.extractor,
    url: info.webpage_url || url,
    heights,
  };
}

const PROGRESS_TEMPLATE =
  'download:PROGRESS|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|' +
  '%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s';

// YouTube sometimes answers 403 to a given client's URLs. When that happens we retry:
// first unchanged (it is often transient), then requesting formats as other clients.
// yt-dlp skips clients that no longer exist with a warning.
// Note: some clients (tv, mweb) only offer 360p, so retries pin the format picked by the
// first attempt (see `pinnedFormat`) instead of silently downgrading quality.
export const RETRY_STRATEGIES = [
  [],
  [],
  ['--extractor-args', 'youtube:player_client=web_safari,android_vr,web_embedded'],
  ['--extractor-args', 'youtube:player_client=tv,mweb'],
];

export const isForbidden = (message) => /\b403\b|Forbidden/i.test(message);

/** "308+140-3" → "308+140-3/308+ba": if that exact audio track is missing, any audio will do. */
function pinFormat(formatIds) {
  const [video, audio] = formatIds.split('+');
  return audio ? `${video}+${audio}/${video}+ba` : video;
}

/**
 * yt-dlp arguments to download `url` into `dir` with already-sanitized options.
 * `extra` goes first (e.g. the YouTube client); `pinnedFormat` overrides format selection.
 */
export function buildDownloadArgs(url, dir, opts, extra = [], pinnedFormat = null) {
  const args = [
    ...extra,
    '--newline',
    '--progress',
    '--progress-template', PROGRESS_TEMPLATE,
    '-P', dir,
    '-o', '%(title).120B [%(id)s].%(ext)s',
    '--embed-metadata',
    ...formatArgs(opts),
    // the last -f wins, so it goes after formatArgs
    ...(pinnedFormat ? ['-f', pinFormat(pinnedFormat)] : []),
    '--',
    url,
  ];
  return args;
}

function formatArgs({ mode, videoFormat, quality, audioFormat, audioBitrate }) {
  if (mode === 'audio') {
    const codec = { ogg: 'vorbis', original: 'best' }[audioFormat] || audioFormat;
    const args = ['-f', 'ba/b', '-x', '--audio-format', codec];
    if (!['wav', 'flac', 'original'].includes(audioFormat)) {
      args.push('--audio-quality', `${audioBitrate}K`);
    }
    if (['mp3', 'm4a', 'opus', 'flac'].includes(audioFormat)) {
      args.push('--embed-thumbnail');
    }
    return args;
  }

  const mute = mode === 'mute';
  const res = quality === 'max' ? 'res' : `res:${quality}`;

  switch (videoFormat) {
    case 'webm':
      return [
        '-f', mute ? 'bv*[ext=webm]/bv*/b' : 'bv*[ext=webm]+ba[ext=webm]/bv*+ba/b',
        '-S', res,
        '--merge-output-format', 'webm/mkv',
      ];
    case 'mkv':
      return [
        '-f', mute ? 'bv*/b' : 'bv*+ba/b',
        '-S', res,
        '--merge-output-format', 'mkv',
        '--remux-video', 'mkv',
      ];
    default: // mp4: prefer H.264 + AAC for maximum compatibility
      return [
        '-f', mute ? 'bv*/b' : 'bv*+ba/b',
        '-S', `${res},vcodec:h264,acodec:aac`,
        '--merge-output-format', 'mp4',
        '--remux-video', 'mp4',
      ];
  }
}
