// yt-dlp integration: metadata lookup, argument building and downloads (single videos with
// retries, and playlists). Used by the downloader and by any tool that accepts a link.
import { BINARIES } from '../../core/paths.js';
import { pickAllowed } from '../../core/input.js';
import { killTree, runProcess } from '../../core/process.js';

export const MAX_PLAYLIST_ITEMS = Number(process.env.MAX_PLAYLIST_ITEMS) || 50;

const BASE_ARGS = [
  '--ignore-config',
  '--no-warnings',
  '--ffmpeg-location', BINARIES.ffmpegDir,
  // YouTube needs a JS runtime to solve its challenges; reuse the running Node.
  '--js-runtimes', `node:${process.execPath}`,
];

const ENV = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };

export const OPTIONS = {
  mode: ['video', 'audio', 'mute'],
  videoFormat: ['mp4', 'webm', 'mkv'],
  quality: ['max', '2160', '1440', '1080', '720', '480', '360', '240', '144'],
  audioFormat: ['mp3', 'm4a', 'opus', 'ogg', 'wav', 'flac', 'original'],
  audioBitrate: ['320', '256', '192', '128', '96'],
  // For a link to a video inside a playlist: just that video, or the whole playlist.
  playlist: ['video', 'all'],
};

export const DEFAULTS = {
  mode: 'video',
  videoFormat: 'mp4',
  quality: '1080',
  audioFormat: 'mp3',
  audioBitrate: '320',
  playlist: 'video',
};

/** Validates client options against the allowlist, falling back to defaults. */
export const sanitizeOptions = (input = {}) => pickAllowed(input, OPTIONS, DEFAULTS);

/** Extracts a readable message from yt-dlp's stderr. */
export function cleanError(stderr) {
  const lines = stderr.split(/\r?\n/).filter(Boolean);
  const line = lines.reverse().find((l) => l.startsWith('ERROR:')) || lines[0] || 'Unknown error';
  return line
    .replace(/^ERROR:\s*/, '')
    .replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '')
    .slice(0, 300);
}

/** The best thumbnail URL in yt-dlp's info (or its first entry's, for playlists). */
const thumbnailOf = (info) =>
  info.thumbnail || info.thumbnails?.at(-1)?.url || info.entries?.[0]?.thumbnails?.at(-1)?.url || null;

/**
 * What a link points to, without downloading it. A video gives `{ type: 'video', title, duration,
 * heights… }`; a playlist gives `{ type: 'playlist', title, count… }`. With `playlist`, a link to a
 * video inside a playlist describes the playlist instead of the video.
 */
export async function getInfo(url, { playlist = false, timeoutMs = 60_000 } = {}) {
  let child;
  let timedOut = false;
  const lines = [];
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, timeoutMs);

  const scope = playlist ? '--yes-playlist' : '--no-playlist';
  let result;
  try {
    result = await runProcess(BINARIES.ytdlp, [...BASE_ARGS, scope, '-J', '--flat-playlist', '--', url], {
      env: ENV,
      track: (c) => (child = c),
      onLine: (line) => lines.push(line),
    });
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('yt-dlp is not installed: run "npm run setup"', { cause: err });
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) throw new Error('Request timed out');
  if (result.code !== 0) throw new Error(cleanError(result.stderr));

  const info = JSON.parse(lines.join('\n'));
  if (info._type === 'playlist') {
    return {
      type: 'playlist',
      id: info.id,
      title: info.title,
      uploader: info.uploader || info.channel || info.uploader_id || null,
      count: info.playlist_count ?? info.entries?.length ?? null,
      maxItems: MAX_PLAYLIST_ITEMS,
      thumbnail: thumbnailOf(info),
      site: info.extractor_key || info.extractor,
      url: info.webpage_url || url,
    };
  }
  const heights = [
    ...new Set(
      (info.formats || [])
        .filter((f) => f.vcodec && f.vcodec !== 'none' && f.height)
        .map((f) => f.height),
    ),
  ].sort((a, b) => b - a);

  return {
    type: 'video',
    id: info.id,
    title: info.title,
    uploader: info.uploader || info.channel || info.uploader_id || null,
    duration: info.duration ?? null,
    thumbnail: thumbnailOf(info),
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
// first attempt (see `pinned`) instead of silently downgrading quality.
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
 * yt-dlp arguments to download `url` into `dir`.
 * `client` goes first (the retry strategy), `format` selects streams, `extra` adds anything
 * else (e.g. a time range) and `pinned` overrides the format selection.
 */
export function buildDownloadArgs(url, dir, { client = [], format = [], extra = [], pinned = null } = {}) {
  return [
    ...client,
    // A link to a video inside a playlist means just that video here; see buildPlaylistArgs.
    // A link to a playlist alone would still download all of it, so cap it at its first video.
    '--no-playlist',
    '--playlist-items', '1',
    '--newline',
    '--progress',
    '--progress-template', PROGRESS_TEMPLATE,
    '-P', dir,
    '-o', '%(title).120B [%(id)s].%(ext)s',
    '--embed-metadata',
    ...format,
    ...extra,
    // the last -f wins, so it goes after the format selection
    ...(pinned ? ['-f', pinFormat(pinned)] : []),
    '--',
    url,
  ];
}

/** Format selection for the downloader's options. */
export function formatArgs({ mode, videoFormat, quality, audioFormat, audioBitrate }) {
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

const POSTPROCESSORS = /^\[(Merger|ExtractAudio|VideoRemuxer|VideoConvertor|EmbedThumbnail|Metadata|Fixup\w*)\]/;

/**
 * Downloads `url` into `dir` as part of a job, reporting progress through `ctx`
 * and retrying on 403 (see RETRY_STRATEGIES).
 */
export async function download(ctx, url, { dir, format = [], extra = [] }) {
  let pinned = null;

  for (let attempt = 0; ; attempt++) {
    const parts = { part: 0, parts: 1 };
    ctx.set({ attempt, ...parts });
    ctx.stage('downloading');

    const args = buildDownloadArgs(url, dir, { client: RETRY_STRATEGIES[attempt], format, extra, pinned });
    const { code, stderr } = await ctx.run(BINARIES.ytdlp, [...BASE_ARGS, ...args], {
      env: ENV,
      onLine: (line) => {
        if (line.startsWith('PROGRESS|')) {
          const [, downloaded, total, estimate] = line.split('|').map(Number);
          const size = total || estimate;
          ctx.stage('downloading', size && downloaded ? Math.min(downloaded / size, 1) : null);
          return;
        }
        const formats = line.match(/Downloading \d+ format\(s\): (\S+)/);
        if (formats) {
          // The first attempt decides the quality; retries stick to it.
          pinned ??= formats[1];
          parts.parts = formats[1].split('+').length;
          ctx.set(parts);
          return;
        }
        if (line.startsWith('[download] Destination:')) {
          parts.part = Math.min(parts.part + 1, parts.parts);
          ctx.set(parts);
          return;
        }
        if (POSTPROCESSORS.test(line)) ctx.stage('processing');
      },
    });
    if (code === 0) return;

    const message = cleanError(stderr);
    ctx.log(`attempt ${attempt + 1} failed: ${message}`);
    if (ctx.cancelled) return;
    if (isForbidden(message) && attempt + 1 < RETRY_STRATEGIES.length) continue;
    throw new Error(
      isForbidden(message) && pinned
        ? `The site blocked the download (403) at the selected quality (${pinned}); try again in a few minutes`
        : message,
    );
  }
}

/**
 * yt-dlp arguments to download up to `maxItems` videos of the playlist at `url` into `dir`,
 * named "001 - Title [id].ext" so they keep the playlist's order. A video that fails
 * (private, removed…) is skipped instead of stopping the rest.
 */
export function buildPlaylistArgs(url, dir, { format = [], maxItems = MAX_PLAYLIST_ITEMS } = {}) {
  return [
    '--yes-playlist',
    '--ignore-errors',
    '--playlist-items', `1:${maxItems}`,
    '--newline',
    '--progress',
    '--progress-template', PROGRESS_TEMPLATE,
    '-P', dir,
    '-o', '%(playlist_index)03d - %(title).100B [%(id)s].%(ext)s',
    '--embed-metadata',
    ...format,
    '--',
    url,
  ];
}

/**
 * Downloads a playlist into `dir` as part of a job. Progress covers the whole playlist
 * (`item`/`items` say which video it is on). Resolves with `{ title, items, code, stderr }`;
 * it does not throw when some videos fail, so the caller decides from what was downloaded.
 */
export async function downloadPlaylist(ctx, url, { dir, format = [] }) {
  const state = { title: null, item: 0, items: null, part: 0, parts: 1 };
  ctx.set({ attempt: 0, item: 0, items: null, part: 0, parts: 1 });
  ctx.stage('downloading', 0);

  const overall = (fraction) =>
    state.items ? Math.min((state.item - 1 + ((state.part || 1) - 1 + fraction) / state.parts) / state.items, 1) : null;

  const { code, stderr } = await ctx.run(BINARIES.ytdlp, [...BASE_ARGS, ...buildPlaylistArgs(url, dir, { format })], {
    env: ENV,
    onLine: (line) => {
      if (line.startsWith('PROGRESS|')) {
        const [, downloaded, total, estimate] = line.split('|').map(Number);
        const size = total || estimate;
        if (size && downloaded) ctx.progress(overall(Math.min(downloaded / size, 1)));
        return;
      }
      const playlist = line.match(/^\[download\] Downloading playlist: (.+)$/);
      if (playlist) {
        state.title = playlist[1].trim();
        return;
      }
      const item = line.match(/Downloading item (\d+) of (\d+)/);
      if (item) {
        Object.assign(state, { item: Number(item[1]), items: Number(item[2]), part: 0, parts: 1 });
        ctx.set({ item: state.item, items: state.items, part: 0, parts: 1 });
        ctx.progress(overall(0));
        return;
      }
      const formats = line.match(/Downloading \d+ format\(s\): (\S+)/);
      if (formats) {
        state.parts = formats[1].split('+').length;
        return;
      }
      if (line.startsWith('[download] Destination:')) state.part = Math.min(state.part + 1, state.parts);
    },
  });
  return { title: state.title, items: state.items, code, stderr };
}
