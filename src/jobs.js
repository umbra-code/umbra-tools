// In-memory download queue: each job downloads into its own temp directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import {
  spawnYtdlp,
  buildDownloadArgs,
  killTree,
  cleanError,
  isForbidden,
  RETRY_STRATEGIES,
} from './ytdlp.js';

const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 2;
const MAX_JOBS = Number(process.env.MAX_JOBS) || 50;
const FILE_TTL_MS = (Number(process.env.FILE_TTL_MINUTES) || 15) * 60_000;

// Every download lives here. If the process died without cleaning up (e.g. the terminal
// was closed), leftovers are wiped on the next start.
const TEMP_ROOT = path.join(os.tmpdir(), 'umbra-tools');
fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
fs.mkdirSync(TEMP_ROOT, { recursive: true });

const jobs = new Map();
const queue = [];
let active = 0;

const POSTPROCESSORS = /^\[(Merger|ExtractAudio|VideoRemuxer|VideoConvertor|EmbedThumbnail|Metadata|Fixup\w*)\]/;

export function getJob(id) {
  return jobs.get(id);
}

export function createJob(url, options) {
  if (jobs.size >= MAX_JOBS) {
    const err = new Error('The server is busy, try again in a few minutes');
    err.status = 429;
    throw err;
  }
  const job = {
    id: randomUUID(),
    url,
    options,
    status: 'queued',
    progress: null,
    part: 0,
    parts: 1,
    error: null,
    attempt: 0,
    selectedFormat: null,
    file: null,
    size: null,
    dir: null,
    child: null,
    cleanupTimer: null,
  };
  jobs.set(job.id, job);
  queue.push(job);
  pump();
  return job;
}

export function cancelJob(job) {
  const idx = queue.indexOf(job);
  if (idx !== -1) queue.splice(idx, 1);
  if (['queued', 'downloading', 'processing'].includes(job.status)) {
    job.status = 'cancelled';
    killTree(job.child);
    if (!job.child) scheduleCleanup(job, 0);
  }
}

export function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    part: job.part,
    parts: job.parts,
    error: job.error,
    attempt: job.attempt,
    filename: job.file ? path.basename(job.file) : null,
    size: job.size,
  };
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length) start(queue.shift());
}

function start(job) {
  active++;
  job.status = 'downloading';
  job.part = 0;
  job.progress = null;
  job.dir ??= fs.mkdtempSync(path.join(TEMP_ROOT, 'job-'));

  const extra = RETRY_STRATEGIES[job.attempt];
  const child = spawnYtdlp(
    buildDownloadArgs(job.url, job.dir, job.options, extra, job.selectedFormat),
  );
  job.child = child;

  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (d) => {
    stderr = (stderr + d).slice(-8000);
  });

  readline.createInterface({ input: child.stdout }).on('line', (line) => handleLine(job, line));

  let finished = false;
  const finish = (code, spawnError) => {
    if (finished) return;
    finished = true;
    active--;
    job.child = null;

    if (job.status === 'cancelled') {
      scheduleCleanup(job, 0);
    } else if (code === 0) {
      const file = pickOutput(job.dir);
      if (file) {
        job.file = file;
        job.size = fs.statSync(file).size;
        job.status = 'done';
        job.progress = 1;
      } else {
        fail(job, 'The download finished but no file was produced');
      }
    } else if (spawnError?.code === 'ENOENT') {
      fail(job, 'yt-dlp is not installed: run "npm run setup"');
    } else {
      const message = cleanError(stderr);
      console.error(`[job ${job.id.slice(0, 8)}] attempt ${job.attempt + 1} failed: ${message}\n  ${job.url}`);
      if (isForbidden(message) && job.attempt + 1 < RETRY_STRATEGIES.length) {
        job.attempt++;
        start(job);
        return;
      }
      fail(job, isForbidden(message) && job.selectedFormat
        ? `YouTube blocked the download (403) at the selected quality (${job.selectedFormat}); try again in a few minutes`
        : message);
    }
    if (job.status !== 'cancelled') scheduleCleanup(job, FILE_TTL_MS);
    pump();
  };

  child.on('error', (e) => finish(-1, e));
  child.on('close', (code) => finish(code));
}

function handleLine(job, line) {
  if (job.status === 'cancelled') return;

  if (line.startsWith('PROGRESS|')) {
    const [, downloaded, total, estimate, speed, eta] = line.split('|').map(Number);
    const size = total || estimate;
    job.status = 'downloading';
    job.progress = size && downloaded ? Math.min(downloaded / size, 1) : null;
    job.speed = Number.isFinite(speed) ? speed : null;
    job.eta = Number.isFinite(eta) ? eta : null;
    return;
  }

  const formats = line.match(/Downloading \d+ format\(s\): (\S+)/);
  if (formats) {
    // The first attempt decides the quality; retries stick to it.
    job.selectedFormat ??= formats[1];
    job.parts = formats[1].split('+').length;
    return;
  }
  if (line.startsWith('[download] Destination:')) {
    job.part = Math.min(job.part + 1, job.parts);
    job.progress = 0;
    return;
  }
  if (POSTPROCESSORS.test(line)) {
    job.status = 'processing';
    job.progress = null;
  }
}

function fail(job, message) {
  job.status = 'error';
  job.error = message;
}

/** The final file is the largest one in the directory (skips partial leftovers). */
function pickOutput(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => !/\.(part|ytdl|temp)$/i.test(f))
    .map((f) => path.join(dir, f))
    .filter((f) => fs.statSync(f).isFile());
  files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return files[0] || null;
}

function scheduleCleanup(job, delay) {
  clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(() => {
    if (job.dir) fs.rm(job.dir, { recursive: true, force: true }, () => {});
    jobs.delete(job.id);
  }, delay);
  job.cleanupTimer.unref();
}

/** On shutdown: kill processes and remove temp files. */
export function shutdown() {
  for (const job of jobs.values()) killTree(job.child);
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
}
