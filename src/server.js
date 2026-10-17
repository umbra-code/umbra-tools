import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { ROOT, UPLOAD_DIR } from './core/paths.js';
import { httpError } from './core/errors.js';
import { parseSource, parseUrl } from './core/input.js';
import { cancelJob, createJob, getJob, initTempDir, publicJob, shutdown } from './core/jobs.js';
import { tools } from './tools/index.js';
import { getInfo } from './tools/downloader/ytdlp.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 2048;

initTempDir();

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
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

app.post('/api/info', async (req, res) => {
  res.json(await getInfo(parseUrl(req.body?.url)));
});

// JSON with a `url`, or multipart with a `file`. Without `tool` it is the downloader,
// as in v1.0.
app.post('/api/jobs', upload.single('file'), (req, res) => {
  try {
    const tool = tools[req.body?.tool || 'downloader'];
    if (!tool) throw httpError(400, 'Unknown tool');
    if (req.file) req.file.originalname = decodeFileName(req.file.originalname);

    const job = createJob(tool, {
      ...parseSource(req.body, req.file, tool.accepts),
      options: tool.parseOptions(req.body ?? {}),
    });
    res.status(201).json(publicJob(job));
  } catch (err) {
    if (req.file) fs.rm(req.file.path, { force: true }, () => {});
    throw err;
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

app.delete('/api/jobs/:id', (req, res) => {
  cancelJob(findJob(req));
  res.status(204).end();
});

app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    err = httpError(tooBig ? 413 : 400, tooBig ? `Files can be at most ${MAX_UPLOAD_MB} MB` : err.message);
  }
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 422);
  res.status(status).json({ error: err.message || 'Unexpected error' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`umbra-tools listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
