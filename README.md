# umbra tools

A self-hosted toolbox for everyday media and file tasks: downloading, converting and
transforming video, audio, images and documents, all from one local web app.
Everything runs on your machine, so files never leave it and there are no upload limits.

## Tools

| Tool | Status | Description |
|------|--------|-------------|
| [Media downloader](#media-downloader) | ✅ available | Save video or audio from a link, on any [site supported by yt-dlp](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) |
| [Video → GIF](#video--gif) | ✅ available | Turn a time range of a video file or link into a GIF or animated WebP |
| Video converter | 🗺️ planned | Change container/codec, resolution or bitrate; trim and compress |
| Audio converter | 🗺️ planned | Convert between mp3, m4a, opus, wav, flac…; extract audio from video |
| Image converter | 🗺️ planned | Convert between png, jpg, webp, avif…; resize and compress |
| Document converter | 🗺️ planned | Convert between common document formats (e.g. to PDF) |

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
| `GIF_MAX_SECONDS`          | `60`        | Longest clip Video → GIF accepts                    |
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
- Playlists are not supported yet.

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
  files.js, time.js      file names, time parsing
  paths.js               binaries and temp locations
src/tools/               one folder per tool
  index.js               tool registry
  downloader/            media downloader; ytdlp.js is reused by tools that accept links
  gif/                   video → GIF
public/                  UI (plain HTML/CSS/JS modules)
  js/main.js             tool menu
  js/tools/<tool>.js     one module per tool
scripts/setup.js         downloads yt-dlp and copies ffmpeg/ffprobe into bin/
```

- Each job works in its own temp folder under `<os temp>/umbra-tools` (`input/`, `work/`, `out/`).
  Finished files are removed after `FILE_TTL_MINUTES`, and the whole folder is wiped on startup.
- Binaries live in `bin/` (git-ignored) and are fetched by `npm install`.

### API

- `POST /api/jobs` → creates a job and returns its state. Send JSON with a `url`, or multipart with a `file`,
  plus `tool` (`downloader` by default) and the tool's options:
  - `downloader`: `mode`, `videoFormat`, `quality`, `audioFormat`, `audioBitrate`
  - `gif`: `start`, `end`, `fps`, `width`, `format`
- `GET /api/jobs/:id` → `status` (`queued`, `running`, `done`, `error`, `cancelled`), `stage` and `progress`
- `GET /api/jobs/:id/file` → the finished file
- `DELETE /api/jobs/:id` → cancels the job
- `POST /api/info` `{ url }` → title, uploader, duration, thumbnail and available resolutions of a link

### Adding a tool

1. Create `src/tools/<tool>/index.js` exporting `{ id, accepts, parseOptions(body), run(ctx) }`:
   - `accepts`: `['url']`, `['file']` or both.
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
- [ ] Video converter (trim, compress, change codec/resolution)
- [ ] Audio converter
- [ ] Image converter
- [ ] Document converter
- [ ] Downloader: playlists, cookies for age-restricted videos

---

Intended for personal use. Respect copyright and each site's terms of service.
