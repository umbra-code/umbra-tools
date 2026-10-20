// In-memory job queue shared by every tool. Each job gets its own temp directory:
//   input/  the uploaded files, if any
//   work/   intermediate files (removed when the job ends)
//   out/    the result: its largest file is what the user downloads, or, for tools with
//           `multipleOutputs`, every file in it (also offered together as a zip)
// A tool only implements `run(ctx)`; queuing, progress, cancellation and cleanup live here.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TEMP_ROOT, UPLOAD_DIR } from './paths.js';
import { killTree, runProcess } from './process.js';
import { largestFile, listFiles, safeFileName } from './files.js';
import { zipFiles } from './archive.js';
import { httpError } from './errors.js';

const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 2;
const MAX_JOBS = Number(process.env.MAX_JOBS) || 50;
const FILE_TTL_MS = (Number(process.env.FILE_TTL_MINUTES) || 15) * 60_000;
// Cancelled jobs lose their files right away but stay visible for a while, so a client
// polling them sees "cancelled" instead of "not found".
const CANCELLED_TTL_MS = 60_000;

const jobs = new Map();
const queue = [];
let active = 0;

/** Starts from a clean temp directory; leftovers come from a process that died without cleaning up. */
export function initTempDir() {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

export function getJob(id) {
  return jobs.get(id);
}

/**
 * `input` is `{ url }`, `{ file }` or `{ files }` (files as `{ path, name }`), plus the tool's
 * parsed `options`.
 */
export function createJob(tool, input) {
  if (jobs.size >= MAX_JOBS) throw httpError(429, 'The server is busy, try again in a few minutes');

  const dir = fs.mkdtempSync(path.join(TEMP_ROOT, 'job-'));
  // Move the uploads into the job so they are cleaned up with it.
  const moveIn = (file) => {
    const target = path.join(dir, 'input', path.basename(file.path));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(file.path, target);
    return { ...file, path: target };
  };
  if (input.file) input = { ...input, file: moveIn(input.file) };
  if (input.files) input = { ...input, files: input.files.map(moveIn) };

  const job = {
    id: randomUUID(),
    tool,
    input,
    dir,
    status: 'queued',
    stage: null,
    progress: null,
    info: {},
    error: null,
    file: null,
    size: null,
    outputs: null,
    children: new Set(),
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
  if (job.status !== 'queued' && job.status !== 'running') return;

  const wasQueued = job.status === 'queued';
  job.status = 'cancelled';
  for (const child of job.children) killTree(child);
  // A running job cleans up when its tool stops (see start).
  if (wasQueued) cleanUpCancelled(job);
}

function cleanUpCancelled(job) {
  fs.rm(job.dir, { recursive: true, force: true }, () => {});
  scheduleCleanup(job, CANCELLED_TTL_MS);
}

export function publicJob(job) {
  return {
    id: job.id,
    tool: job.tool.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    ...job.info,
    error: job.error,
    filename: job.file ? path.basename(job.file) : null,
    size: job.size,
    // Each result of a multiple-output job, downloadable at /api/jobs/:id/outputs/:index.
    outputs: job.outputs?.map(({ file, size }) => ({ name: path.basename(file), size })) ?? null,
  };
}

/** The path of a multiple-output job's result by index, or null. */
export const jobOutput = (job, index) => job.outputs?.[index]?.file ?? null;

function pump() {
  while (active < MAX_CONCURRENT && queue.length) start(queue.shift());
}

async function start(job) {
  active++;
  job.status = 'running';
  const ctx = createContext(job);

  try {
    fs.mkdirSync(ctx.workDir, { recursive: true });
    fs.mkdirSync(ctx.outDir, { recursive: true });
    await job.tool.run(ctx);
    if (job.status === 'cancelled') return;

    if (job.tool.multipleOutputs || ctx.multipleOutputs) {
      const files = listFiles(ctx.outDir);
      if (!files.length) throw new Error('The job finished but produced no file');
      job.outputs = files.map((file) => ({ file, size: fs.statSync(file).size }));
      if (files.length === 1) {
        job.file = files[0];
      } else {
        ctx.stage('packing');
        job.file = path.join(job.dir, `${safeFileName(ctx.archiveName ?? job.tool.id)}.zip`);
        await zipFiles(files, job.file);
      }
    } else {
      job.file = largestFile(ctx.outDir);
      if (!job.file) throw new Error('The job finished but produced no file');
    }
    job.size = fs.statSync(job.file).size;
    job.status = 'done';
    job.stage = null;
    job.progress = 1;
  } catch (err) {
    if (job.status !== 'cancelled') {
      job.status = 'error';
      job.error = err.message;
      ctx.log(`failed: ${err.message}`);
    }
  } finally {
    active--;
    // Only the result is worth keeping around until it is downloaded.
    for (const dir of [ctx.workDir, path.join(job.dir, 'input')]) {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
    if (job.status === 'cancelled') cleanUpCancelled(job);
    else scheduleCleanup(job, FILE_TTL_MS);
    pump();
  }
}

/** What a tool's `run(ctx)` gets to work with. */
function createContext(job) {
  return {
    url: job.input.url,
    file: job.input.file,
    files: job.input.files,
    options: job.input.options,
    workDir: path.join(job.dir, 'work'),
    outDir: path.join(job.dir, 'out'),
    /** Name (without .zip) of the archive a multiple-output job is offered as. */
    archiveName: null,
    /** Set to true for a run that produces several files (as tools with `multipleOutputs` always do). */
    multipleOutputs: false,

    get cancelled() {
      return job.status === 'cancelled';
    },

    /** What the job is doing, for the UI ("downloading", "converting"…); resets the progress. */
    stage(stage, progress = null) {
      job.stage = stage;
      job.progress = progress;
    },

    /** Progress of the current stage, from 0 to 1, or null when unknown. */
    progress(value) {
      job.progress = value;
    },

    /** Extra tool-specific fields for the UI (e.g. `{ part, parts, attempt }`). */
    set(info) {
      Object.assign(job.info, info);
    },

    log(message) {
      console.error(`[${job.tool.id} ${job.id.slice(0, 8)}] ${message}`);
    },

    /** Like runProcess, but the process is killed when the job is cancelled. */
    async run(command, args, options = {}) {
      if (job.status === 'cancelled') throw new Error('cancelled');
      try {
        return await runProcess(command, args, {
          ...options,
          track: (child) => {
            job.children.add(child);
            child.on('close', () => job.children.delete(child));
          },
        });
      } catch (err) {
        if (err.code === 'ENOENT') {
          throw new Error(`${path.parse(command).name} is not installed: run "npm run setup"`, { cause: err });
        }
        throw err;
      }
    },
  };
}

function scheduleCleanup(job, delay) {
  clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(() => {
    fs.rm(job.dir, { recursive: true, force: true }, () => {});
    jobs.delete(job.id);
  }, delay);
  job.cleanupTimer.unref();
}

/** On shutdown: kill processes and remove temp files. */
export function shutdown() {
  for (const job of jobs.values()) {
    for (const child of job.children) killTree(child);
  }
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
}
