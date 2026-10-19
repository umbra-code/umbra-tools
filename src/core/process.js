// Child processes: line-by-line output and killing whole process trees.
import { spawn, execFile } from 'node:child_process';
import readline from 'node:readline';

/** Kills the process and its children (e.g. ffmpeg started by yt-dlp), on Windows too. */
export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  } else {
    child.kill('SIGKILL');
  }
}

/**
 * Runs a command and resolves with its exit code and the tail of stderr; it does not
 * reject on a non-zero exit, only when the command cannot start (e.g. ENOENT).
 * `onLine` receives stdout line by line; `track` receives the child as soon as it exists.
 */
export function runProcess(command, args, { onLine, track, env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      cwd,
      env: { ...process.env, ...env },
    });
    track?.(child);

    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (d) => {
      stderr = (stderr + d).slice(-8000);
    });
    if (onLine) readline.createInterface({ input: child.stdout }).on('line', onLine);
    else child.stdout.resume();

    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}
