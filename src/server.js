import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getInfo, sanitizeOptions, OPTIONS, DEFAULTS } from './ytdlp.js';
import { createJob, getJob, cancelJob, publicJob, shutdown } from './jobs.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(root, 'public')));

function parseUrl(value) {
  const err = new Error('Enter a valid link (http or https)');
  err.status = 400;
  if (typeof value !== 'string' || value.length > 2048) throw err;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw err;
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw err;
  return url.href;
}

function findJob(req) {
  const job = getJob(req.params.id);
  if (!job) {
    const err = new Error('Download not found or expired');
    err.status = 404;
    throw err;
  }
  return job;
}

app.get('/api/options', (req, res) => {
  res.json({ options: OPTIONS, defaults: DEFAULTS });
});

app.post('/api/info', async (req, res) => {
  const url = parseUrl(req.body?.url);
  res.json(await getInfo(url));
});

app.post('/api/jobs', (req, res) => {
  const url = parseUrl(req.body?.url);
  const job = createJob(url, sanitizeOptions(req.body));
  res.status(201).json(publicJob(job));
});

app.get('/api/jobs/:id', (req, res) => {
  res.json(publicJob(findJob(req)));
});

app.get('/api/jobs/:id/file', (req, res) => {
  const job = findJob(req);
  if (job.status !== 'done') {
    return res.status(409).json({ error: 'The file is not ready yet' });
  }
  res.download(job.file, path.basename(job.file));
});

app.delete('/api/jobs/:id', (req, res) => {
  cancelJob(findJob(req));
  res.status(204).end();
});

app.use((err, req, res, _next) => {
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
