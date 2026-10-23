import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { ROOT, UPLOAD_DIR } from './core/paths.js';
import { httpError } from './core/errors.js';
import { parseSource, parseUrl } from './core/input.js';
import { cancelJob, createJob, getJob, initTempDir, jobOutput, publicJob, shutdown } from './core/jobs.js';
import { getUpload, keepUpload, removeUpload } from './core/uploads.js';
import { tools } from './tools/index.js';
import { getInfo } from './tools/downloader/ytdlp.js';
import { autoUpdateYtdlp } from './tools/downloader/update.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 2048;
const MAX_FILES = Number(process.env.MAX_FILES) || 100;

initTempDir();

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: MAX_FILES },
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(ROOT, 'public')));

function findJob(req) {
  const job = getJob(req.params.id);
  if (!job) throw httpError(404, 'Job not found or expired');
  return job;
}

/** busboy decodes multipart file names as latin1; browsers send UTF-8. */
const decodeFileName = (name) => Buffer.from(name, 'latin1').toString('utf8');

// `playlist: true` describes the playlist a video link belongs to, instead of the video.
app.post('/api/info', async (req, res) => {
  res.json(await getInfo(parseUrl(req.body?.url), { playlist: req.body?.playlist === true }));
});

const removeUploads = (files) => {
  for (const file of files) fs.rm(file.path, { force: true }, () => {});
};

// JSON with a `url`, or multipart with one or more `file` fields (plus a `cover` for tools
// that take one). Without `tool` it is the downloader, as in v1.0.
app.post('/api/jobs', upload.fields([{ name: 'file', maxCount: MAX_FILES }, { name: 'cover', maxCount: 1 }]), (req, res) => {
  const files = req.files?.file ?? [];
  const cover = req.files?.cover?.[0];
  const uploads = [...files, ...(cover ? [cover] : [])];
  try {
    const tool = tools[req.body?.tool || 'downloader'];
    if (!tool) throw httpError(400, 'Unknown tool');
    for (const file of uploads) file.originalname = decodeFileName(file.originalname);
    if (cover && !tool.attachments?.includes('cover')) throw httpError(400, 'This tool does not take a cover');

    const job = createJob(tool, {
      ...parseSource(req.body, files, tool.accepts),
      ...(cover ? { attachments: { cover: { path: cover.path, name: cover.originalname } } } : {}),
      options: tool.parseOptions(req.body ?? {}),
    });
    res.status(201).json(publicJob(job));
  } catch (err) {
    removeUploads(uploads);
    throw err;
  }
});

// Uploads kept for a while, so a tool can preview the same file many times without the
// browser sending it again (see src/core/uploads.js).
app.post('/api/uploads', upload.single('file'), (req, res) => {
  if (!req.file) throw httpError(400, 'Choose a file to upload');
  res.status(201).json(keepUpload(req.file, decodeFileName(req.file.originalname)));
});

app.delete('/api/uploads/:id', (req, res) => {
  removeUpload(req.params.id);
  res.status(204).end();
});

// The exact result for a kept upload, without a job, for tools that can (`preview`).
// The body is the result; X-Result says what it is (e.g. its format and size) as URI-encoded
// JSON, since headers only take latin1 and file names can have any character.
app.post('/api/tools/:tool/preview', async (req, res) => {
  const tool = tools[req.params.tool];
  if (!tool?.preview) throw httpError(404, 'This tool has no preview');
  const kept = getUpload(req.body?.upload);
  if (!kept) throw httpError(404, 'The file is no longer on the server; choose it again');

  // A newer preview replaces this one in the browser: stop working on it when it hangs up.
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });

  let result;
  try {
    result = await tool.preview(kept, tool.parseOptions(req.body ?? {}), { signal: abort.signal });
  } catch (err) {
    if (abort.signal.aborted) return; // nobody is listening anymore
    throw err;
  }
  const { data, contentType, meta } = result;
  res.set({ 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Result': encodeURIComponent(JSON.stringify(meta)) }).send(data);
});

// Reads what a file says about itself, for tools that can (`inspect`), without starting a job.
app.post('/api/tools/:tool/inspect', upload.single('file'), async (req, res) => {
  try {
    const tool = tools[req.params.tool];
    if (!tool?.inspect) throw httpError(404, 'This tool cannot inspect files');
    if (!req.file) throw httpError(400, 'Choose a file to upload');
    const name = decodeFileName(req.file.originalname);
    try {
      res.json(await tool.inspect({ path: req.file.path, name }));
    } catch (err) {
      throw httpError(422, err.message);
    }
  } finally {
    if (req.file) removeUploads([req.file]);
  }
});

app.get('/api/jobs/:id', (req, res) => {
  res.json(publicJob(findJob(req)));
});

app.get('/api/jobs/:id/file', (req, res) => {
  const job = findJob(req);
  if (job.status !== 'done') throw httpError(409, 'The file is not ready yet');
  res.download(job.file, path.basename(job.file));
});

// One result of a job that produced several files (the whole set is /file, as a zip).
app.get('/api/jobs/:id/outputs/:index', (req, res) => {
  const file = jobOutput(findJob(req), Number(req.params.index));
  if (!file) throw httpError(404, 'File not found');
  res.download(file, path.basename(file));
});

app.delete('/api/jobs/:id', (req, res) => {
  cancelJob(findJob(req));
  res.status(204).end();
});

app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: [413, `Files can be at most ${MAX_UPLOAD_MB} MB`],
      LIMIT_FILE_COUNT: [413, `At most ${MAX_FILES} files can be uploaded at once`],
    };
    const [status, message] = messages[err.code] ?? [400, err.message];
    err = httpError(status, message);
  }
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 422);
  res.status(status).json({ error: err.message || 'Unexpected error' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`umbra-tools listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  autoUpdateYtdlp();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
