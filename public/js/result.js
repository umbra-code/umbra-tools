// The result panel each tool shows below its form: preview, progress, status and the file.
import { $, formatBytes, formatTime } from './dom.js';
import { api, pollJob } from './api.js';

function describe(job) {
  if (job.status === 'queued') return 'queued…';
  const pct = job.progress != null ? ` ${Math.round(job.progress * 100)}%` : '';
  const retry = job.attempt ? ` · retry ${job.attempt}` : '';
  switch (job.stage) {
    case 'downloading': {
      const part = job.parts > 1 ? ` (part ${Math.max(job.part, 1)}/${job.parts})` : '';
      return `downloading${part}${pct}${retry}`;
    }
    case 'processing':
      return 'processing with ffmpeg…';
    case 'converting':
      return `converting${pct || '…'}`;
    default:
      return `working${pct || '…'}`;
  }
}

/** Creates a result panel inside `slot` (cloned from #result-template). */
export function createResult(slot) {
  slot.append($('#result-template').content.cloneNode(true));
  const panel = $('.result', slot);
  const el = (cls) => $(`.${cls}`, panel);
  let controller = null;

  const setStatus = (text, kind = '') => {
    el('status-text').textContent = text;
    el('status-text').className = `status-text ${kind}`;
  };

  const setProgress = (value) => {
    const fill = el('bar-fill');
    fill.classList.toggle('indeterminate', value == null);
    fill.style.width = value == null ? '' : `${Math.round(value * 100)}%`;
  };

  el('cancel').addEventListener('click', () => controller?.abort());

  return {
    setStatus,
    setProgress,

    get busy() {
      return controller !== null;
    },

    showPreview({ thumbnail, title, uploader, duration, site }) {
      el('thumb').src = thumbnail || '';
      el('thumb').hidden = !thumbnail;
      el('title').textContent = title || 'Untitled';
      el('meta').textContent = [uploader, formatTime(duration), site].filter(Boolean).join(' · ');
      el('preview').hidden = false;
    },

    /**
     * Runs a job end to end. `create(signal)` starts it and resolves with the job;
     * on success `onDone(job, href)` gets the finished job and its download URL.
     */
    async run(create, { onDone } = {}) {
      controller = new AbortController();
      const { signal } = controller;
      let jobId = null;
      signal.addEventListener('abort', () => {
        if (jobId) api(`/api/jobs/${jobId}`, { method: 'DELETE' }).catch(() => {});
      });

      panel.hidden = false;
      el('preview').hidden = true;
      el('output').hidden = true;
      el('again').hidden = true;
      el('cancel').hidden = false;
      setStatus('starting…');
      setProgress(null);

      try {
        const job = await create(signal);
        jobId = job.id;
        const done = await pollJob(job.id, {
          signal,
          onUpdate: (update) => {
            setStatus(describe(update));
            setProgress(update.progress);
          },
          onOffline: () => setStatus('server unreachable, retrying…'),
        });
        const href = `/api/jobs/${done.id}/file`;
        setProgress(1);
        setStatus(`done · ${formatBytes(done.size)}`, 'ok');
        el('again').href = href;
        el('again').hidden = false;
        onDone?.(done, href);
      } catch (err) {
        setProgress(0);
        setStatus(err.name === 'AbortError' ? 'cancelled' : err.message, 'error');
      } finally {
        controller = null;
        el('cancel').hidden = true;
      }
    },

    /** Shows an image result (e.g. a GIF) inside the panel. */
    showImage(src) {
      el('output').src = src;
      el('output').hidden = false;
    },
  };
}

/** Starts a browser download without leaving the page. */
export function triggerDownload(href) {
  const a = document.createElement('a');
  a.href = href;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}
