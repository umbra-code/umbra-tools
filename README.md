# umbra tools

A self-hosted toolbox for everyday media and file tasks: downloading, converting and
transforming video, audio, images and documents, all from one local web app.
Everything runs on your machine, so files never leave it and there are no upload limits.

## Tools

| Tool | Status | Description |
|------|--------|-------------|
| [Media downloader](#media-downloader) | ✅ available | Download video or audio from YouTube and [a thousand other sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) |
| Video → GIF | 🗺️ planned | Turn a clip (or a time range of it) into a GIF or animated WebP |
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
- YouTube only serves 1440p and 4K as VP9 or AV1 (H.264 tops out at 1080p). A 1440p+ mp4 therefore
  contains VP9 video, which plays fine in browsers and VLC but may not open in older editors.
- If YouTube answers `403 Forbidden`, the job retries, first unchanged and then as other YouTube clients.
  Retries are pinned to the format chosen by the first attempt, so a retry never silently downgrades quality.
- Playlists are not supported yet.

**Maintenance:** YouTube changes often and yt-dlp is updated to keep up. If downloads start failing:

```sh
npm run update-ytdlp
```

---

## Architecture

The app is a small Express server plus a dependency-free frontend. Long-running work runs as
**jobs**: the client creates a job, polls its progress and fetches the result when it is done.
The downloader is the first tool built on this; new tools are meant to reuse the same pieces.

```
src/server.js     HTTP API (Express) + static files
src/jobs.js       job queue, progress tracking, temp file cleanup
src/ytdlp.js      media downloader: yt-dlp calls and format → argument mapping
public/           UI (plain HTML/CSS/JS)
scripts/setup.js  downloads yt-dlp and copies ffmpeg/ffprobe into bin/
```

- Each job works in its own temp folder under `<os temp>/umbra-tools`. Finished files are removed after
  `FILE_TTL_MINUTES`, and the whole folder is wiped on startup.
- Binaries live in `bin/` (git-ignored) and are fetched by `npm install`.

### API (media downloader)

- `POST /api/info` `{ url }` → title, uploader, duration, thumbnail and available resolutions
- `POST /api/jobs` `{ url, mode, videoFormat, quality, audioFormat, audioBitrate }` → creates a download
- `GET /api/jobs/:id` → status and progress
- `GET /api/jobs/:id/file` → the finished file
- `DELETE /api/jobs/:id` → cancels the job

### Adding a tool

Planned structure as the toolbox grows:

1. Put the tool's logic in its own module under `src/tools/<tool>/` (argument building, validation).
2. Run it as a job so it gets queuing, progress, cancellation and cleanup for free.
3. Give it its own page or section in the UI, reachable from a shared tool menu.

## Roadmap

- [x] Media downloader (video, audio, mute)
- [ ] Generalize jobs so they are not tied to yt-dlp (file uploads as job input)
- [ ] Tool menu / navigation in the UI
- [ ] Video → GIF / animated WebP
- [ ] Video converter (trim, compress, change codec/resolution)
- [ ] Audio converter
- [ ] Image converter
- [ ] Document converter
- [ ] Downloader: playlists, cookies for age-restricted videos

---

Intended for personal use. Respect copyright and each site's terms of service.
