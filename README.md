# umbra tools

A self-hosted toolbox for everyday media and file tasks: downloading, converting and
transforming video, audio, images and documents, all from one local web app.
Everything runs on your machine, so files never leave it and there are no upload limits.

## Tools

| Tool | Status | Description |
|------|--------|-------------|
| [Media downloader](#media-downloader) | ✅ available | Save video or audio from a link, on any [site supported by yt-dlp](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) |
| [Video → GIF](#video--gif) | ✅ available | Turn a time range of a video file or link into a GIF or animated WebP |
| [Video converter](#video-converter) | ✅ available | Trim, resize, change format/codec and compress, also to a target file size |
| [Audio converter](#audio-converter) | ✅ available | Convert, trim, downmix and normalize audio, or extract it from a video |
| [Image converter](#image-converter) | ✅ available | Convert, resize and compress many images at once |
| [PDF](#pdf) | ✅ available | Merge PDFs, turn images into a PDF, extract pages |

Ideas and order are not set in stone; see [Roadmap](#roadmap).

## Getting started

Requires Node.js 20 or newer.

```sh
npm install   # installs dependencies and downloads yt-dlp, ffmpeg and ffprobe into bin/
npm start     # open http://localhost:3000
```

### Configuration (environment variables)

| Variable                   | Default     | Description                                         |
|----------------------------|-------------|-----------------------------------------------------|
| `PORT`                     | `3000`      | Port                                                |
| `HOST`                     | `127.0.0.1` | Use `0.0.0.0` to reach it from other devices on your network |
| `MAX_CONCURRENT`           | `2`         | Jobs that run at the same time                      |
| `FILE_TTL_MINUTES`         | `15`        | How long finished files are kept                    |
| `MAX_UPLOAD_MB`            | `2048`      | Largest file that can be uploaded                   |
| `MAX_FILES`                | `100`       | Most files that can be uploaded at once             |
| `GIF_MAX_SECONDS`          | `60`        | Longest clip Video → GIF accepts                    |
| `MAX_PLAYLIST_ITEMS`       | `50`        | Most videos downloaded from one playlist            |
| `YTDLP_PATH`, `FFMPEG_DIR` | `bin/`      | Use your own binaries                               |

---

## Media downloader

Paste a link, pick a mode and a format, and download. Built on [yt-dlp](https://github.com/yt-dlp/yt-dlp)
for downloading and ffmpeg for merging and converting.

| Mode   | Formats                                   | Options                       |
|--------|-------------------------------------------|-------------------------------|
| video  | mp4 (H.264/AAC when available), webm, mkv | quality: max, 4k … 360p       |
| mute   | same as video, without the audio track    | quality                       |
| audio  | mp3, m4a, opus, ogg, wav, flac, original  | bitrate 96–320k (lossy only)  |

- mp3, m4a, opus and flac files include metadata and cover art.
- Video and audio streams are merged without re-encoding, so you get exactly what the site serves.
- Some sites only serve high resolutions (1440p, 4K) as VP9 or AV1. An mp4 at those resolutions may then
  contain VP9 video, which plays fine in browsers and VLC but may not open in older editors.
- If a site answers `403 Forbidden`, the job retries, first unchanged and then with alternative clients.
  Retries are pinned to the format chosen by the first attempt, so a retry never silently downgrades quality.
- Pasting a link shows what it is (title, length, thumbnail) before downloading.
- **Playlists**: a playlist link downloads every video (up to `MAX_PLAYLIST_ITEMS`), numbered in playlist
  order. For a video that belongs to a playlist, pick "this video" or "whole playlist". Each video can be
  downloaded on its own, or all of them as a zip named after the playlist. Videos that cannot be downloaded
  (private, removed…) are skipped and counted.
- **No signed-in downloads**: age-restricted, private and members-only videos cannot be downloaded, and the
  error says so. On purpose: it would need your account's cookies, and YouTube can flag accounts used for
  automated downloads (accounts are tied to your Google identity, so a secondary one does not fully protect you).

**Maintenance:** sites change often and yt-dlp is updated to keep up. If downloads start failing:

```sh
npm run update-ytdlp
```

---

## Video → GIF

Pick a video file (drag and drop works) or paste a link, choose the time range and get a looping
GIF or animated WebP. Built on ffmpeg.

| Option | Values                       | Notes                                              |
|--------|------------------------------|----------------------------------------------------|
| range  | start and end                | `83`, `1:23`, `1:23.5` or `1:02:03`; up to 60 s     |
| fps    | 10, 15, 20, 25, 30           |                                                    |
| width  | 320, 480, 640, 800, 1080     | Smaller videos are never upscaled                  |
| format | gif, webp                    | WebP is smaller with full color; not every app opens it |

- Pick the range on a phone-style trimmer: drag the handles to move the start or the end, drag the
  selection to move both, or fine-tune with the arrow keys (Shift for 1 s steps) or by typing the times.
- For files, the trimmer shows a filmstrip of the video, and the player loops inside the selected range
  so you can preview the result. Thumbnails are made in the browser; nothing is uploaded until you convert.
- For links, the trimmer uses the video's real length and thumbnail; only the selected range is
  downloaded, cut on exact frames.
- GIFs use a palette built from the clip itself, which gives far better colors than the default one.

---

## Video converter

Pick a video file or a link, optionally trim it on the same trimmer as Video → GIF, and convert it.

| Option      | Values                                  | Notes                                                    |
|-------------|-----------------------------------------|----------------------------------------------------------|
| format      | mp4, webm, mkv                          | webm always uses VP9 + Opus                              |
| codec       | h.264, h.265                            | mp4 and mkv; h.265 is about half the size, slower to encode |
| resolution  | original, 4k … 360p                     | Smaller videos are never upscaled                        |
| fps         | original, 60, 30, 24                    |                                                          |
| audio       | keep, remove                            | Kept audio is re-encoded at 128 kbit/s (AAC, or Opus in webm) |
| compression | by quality (high, balanced, small file) | Constant quality: the size follows the content           |
|             | to a size (MB)                          | Two-pass encoding at the bitrate that fits the target, e.g. 10 MB to share in a chat |

- The whole video is converted unless you trim it.
- In "to a size" mode, the form shows the bitrate the target leaves and warns when it is too low for the length.
- For links, the video is downloaded without re-encoding (at most at the chosen resolution) and then converted.

---

## Audio converter

Pick an audio or video file, or a link, optionally trim it, and convert its audio.

| Option   | Values                              | Notes                                                      |
|----------|-------------------------------------|------------------------------------------------------------|
| format   | mp3, m4a, opus, ogg, wav, flac      | wav is uncompressed, flac is lossless                      |
| bitrate  | 320, 256, 192, 128, 96 kbit/s       | Lossy formats only                                         |
| channels | original, mono                      | Mono halves the size; fine for voice                       |
| volume   | as is, normalize                    | EBU R128 loudness normalization to -16 LUFS                |

- From a video, only its audio track is kept: an easy way to extract the audio.
- Audio files show their waveform on the trimmer (decoded in the browser, for files up to 300 MB).
- Metadata such as title and artist is carried over; the sample rate is kept, except for opus, which is always 48 kHz.
- For links, only the best audio stream is downloaded.

---

## Image converter

Drop one or many images (up to 100 at once) and convert them together. Built on [sharp](https://sharp.pixelplumbing.com/).

| Option   | Values                              | Notes                                                        |
|----------|-------------------------------------|--------------------------------------------------------------|
| format   | same, jpg, png, webp, avif          | "same" keeps each image's format; png is lossless            |
| quality  | 1–100                               | For jpg, webp and avif                                       |
| max size | original, 3840 … 400 px             | Longest side; the aspect ratio is kept and nothing is enlarged |
| metadata | remove, keep                        | Removing drops EXIF data such as the camera and GPS location |

- Phone photos stored sideways are turned upright using their EXIF orientation.
- Transparent areas become white when converting to jpg, which has no transparency.
- Animated GIFs stay animated as webp; other formats keep the first frame.
- Each image is listed with its size before and after; download them one by one or all together as a zip.
- A file that cannot be read does not stop the others. HEIC photos (iPhone) are not supported yet.

---

## PDF

Simple PDF tasks, built on [pdf-lib](https://pdf-lib.js.org/). Everything happens on your machine.

| Mode          | What it does                                     | Options                                        |
|---------------|--------------------------------------------------|------------------------------------------------|
| merge         | Joins several PDFs, in the order of the list     | Reorder with ↑ ↓                               |
| images → pdf  | One image per page                               | Page size: fit the image, A4 or letter         |
| extract pages | A new PDF with some pages of one PDF             | Pages like `1-3, 5, 8-` (8 to the end), in that order |

- Images of any format the image converter reads work (they are turned upright first); on A4 and letter,
  wide images get a landscape page and none is enlarged.
- Password-protected PDFs are not supported.

---

## Architecture

The app is a small Express server plus a dependency-free frontend. Long-running work runs as
**jobs**: the client creates a job (with a link or an uploaded file), polls its progress and fetches
the result when it is done. Every tool is a job runner on top of the same core.

```
src/server.js            HTTP API (Express) + static files
src/core/                shared by every tool
  jobs.js                job queue, progress, cancellation, temp file cleanup
  input.js               option allowlists, links and uploaded files
  process.js             child processes (line-by-line output, killing process trees)
  media.js               ffprobe and ffmpeg helpers (what a file contains, progress, errors)
  archive.js             zips the results of jobs that produce several files
  sharp.js               sharp, configured for this app (import it from here)
  files.js, time.js      file names, time parsing
  paths.js               binaries and temp locations
src/tools/               one folder per tool
  index.js               tool registry
  downloader/            media downloader; ytdlp.js is reused by tools that accept links
  gif/                   video → GIF
  video/                 video converter
  audio/                 audio converter
  image/                 image converter (sharp)
  pdf/                   PDF tools (pdf-lib)
public/                  UI (plain HTML/CSS/JS modules)
  js/main.js             tool menu
  js/media-source.js     file-or-link picker with player and trimmer, shared by the media tools
  js/trimmer.js          the trimmer, with filmstrip (video) and waveform (audio)
  js/tools/<tool>.js     one module per tool
scripts/setup.js         downloads yt-dlp and copies ffmpeg/ffprobe into bin/
```

- Each job works in its own temp folder under `<os temp>/umbra-tools` (`input/`, `work/`, `out/`).
  Finished files are removed after `FILE_TTL_MINUTES`, and the whole folder is wiped on startup.
- Binaries live in `bin/` (git-ignored) and are fetched by `npm install`.

### API

- `POST /api/jobs` → creates a job and returns its state. Send JSON with a `url`, or multipart with one or more
  `file` fields, plus `tool` (`downloader` by default) and the tool's options:
  - `downloader`: `mode`, `videoFormat`, `quality`, `audioFormat`, `audioBitrate`, `playlist` (`video`, `all`)
  - `gif`: `start`, `end`, `fps`, `width`, `format`
  - `video`: `start`, `end`, `format`, `codec`, `resolution`, `fps`, `audio`, `mode`, `quality`, `targetMb`
  - `audio`: `start`, `end`, `format`, `bitrate`, `channels`, `normalize`
  - `image`: `format`, `quality`, `maxSize`, `metadata` (several files)
  - `pdf`: `mode` (`merge`, `images`, `extract`), `pageSize`, `pages` (several files)
- `GET /api/jobs/:id` → `status` (`queued`, `running`, `done`, `error`, `cancelled`), `stage` and `progress`
- `GET /api/jobs/:id/file` → the finished file (a zip when a job produced several)
- `GET /api/jobs/:id/outputs/:index` → one of the files of a job that produced several (listed in `outputs`)
- `DELETE /api/jobs/:id` → cancels the job
- `POST /api/info` `{ url, playlist? }` → what a link is: `type: 'video'` (title, uploader, duration, thumbnail,
  resolutions) or `type: 'playlist'` (title, uploader, video count). With `playlist: true`, a video link inside
  a playlist describes the playlist.

### Adding a tool

1. Create `src/tools/<tool>/index.js` exporting `{ id, accepts, parseOptions(body), run(ctx) }`:
   - `accepts`: what it takes: `'url'`, `'file'` (exactly one, `ctx.file`) and/or `'files'` (one or more, `ctx.files`).
   - `multipleOutputs: true` when it can produce several files: each one is offered on its own and all of them
     as a zip (named after `ctx.archiveName`). Otherwise the largest file in `ctx.outDir` is the result.
   - `parseOptions` validates the request (use `pickAllowed` for allowlists; throw `httpError(400, …)`).
   - `run(ctx)` writes its result into `ctx.outDir`, using `ctx.run()` for processes (so cancelling kills them)
     and `ctx.stage()` / `ctx.progress()` to report progress. Intermediate files go in `ctx.workDir`.
2. Register it in `src/tools/index.js`.
3. Add a tab and a section in `public/index.html`, and its module in `public/js/tools/`, registered in `public/js/main.js`.

## Development

```sh
npm run dev          # server with auto-reload
npm run lint         # ESLint
npm test             # Vitest (npm run test:watch to keep it running)
```

CI (GitHub Actions) runs lint and tests on every push to `main` and `development` and on pull requests.
It sets `UMBRA_SKIP_SETUP=1` so `npm ci` does not download yt-dlp and ffmpeg.

### Branches and commits

- Work happens on `development`; `main` only ever points at released versions.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/), scoped by tool
  (`feat(downloader): …`, `fix(gif): …`, `feat(core): …`). Release notes are drafted from `feat`, `fix` and `perf` commits.

### Releasing

```sh
npm run release -- patch|minor|major ["Title"] [--dry-run]
```

From a clean `development` branch, the script runs lint and tests, bumps the version, commits and tags it
(`1.0.0 · Title`), pushes, waits for CI on that commit, fast-forwards `main` to it and prints a link to a
prefilled GitHub release to review and publish. `--dry-run` prints the steps without changing anything.
Set `GITHUB_TOKEN` to raise the GitHub API rate limit while it waits for CI.

## Roadmap

- [x] Media downloader (video, audio, mute)
- [x] Generalize jobs so they are not tied to yt-dlp (file uploads as job input)
- [x] Tool menu / navigation in the UI
- [x] Video → GIF / animated WebP
- [x] Video converter (trim, compress, change codec/resolution)
- [x] Audio converter
- [x] Image converter
- [x] PDF: merge, images → PDF, extract pages
- [x] Downloader: playlists
- ~~Downloader: cookies for age-restricted videos~~ (left out on purpose, see [Media downloader](#media-downloader))

---

Intended for personal use. Respect copyright and each site's terms of service.
