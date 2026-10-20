// The result panel each tool shows below its form: preview, progress, status and the file.
import { $, formatBytes, formatTime } from './dom.js';
import { api, pollJob } from './api.js';

function describe(job) {
  if (job.status === 'queued') return 'queued…';
  const pct = job.progress != null ? ` ${Math.round(job.progress * 100)}%` : '';
  const retry = job.attempt ? ` · retry ${job.attempt}` : '';
  const pass = job.passes > 1 ? ` (pass ${job.pass}/${job.passes})` : '';
  switch (job.stage) {
    case 'downloading': {
      if (job.items) return `downloading video ${Math.max(job.item, 1)}/${job.items}${pct}`;
      const part = job.parts > 1 ? ` (part ${Math.max(job.part, 1)}/${job.parts})` : '';
      return `downloading${part}${pct}${retry}`;
    }
    case 'processing':
      return 'processing with ffmpeg…';
    case 'analyzing':
      return `analyzing${pass}${pct || '…'}`;
    case 'converting':
      return `converting${pass}${pct || '…'}`;
    case 'packing':
      return 'packing the zip…';
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

    /** Shows upload progress (0–1, or null when unknown). */
    uploadProgress(value) {
      setStatus(`uploading${value != null ? ` ${Math.round(value * 100)}%` : '…'}`);
      setProgress(value);
    },

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
      for (const media of [el('output-video'), el('output-audio')]) {
        media.pause();
        media.removeAttribute('src');
        media.hidden = true;
      }
      el('output-list').replaceChildren();
      el('output-list').hidden = true;
      el('again').textContent = 'download';
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

    /** Shows a video result inside the panel, ready to play. */
    showVideo(src) {
      el('output-video').src = src;
      el('output-video').hidden = false;
    },

    /** Shows an audio result inside the panel, ready to play. */
    showAudio(src) {
      el('output-audio').src = src;
      el('output-audio').hidden = false;
    },

    /** Changes the text of the main download link (e.g. "download all (.zip)"). */
    setDownloadLabel(text) {
      el('again').textContent = text;
    },

    /**
     * Lists several results: `{ name, detail, href?, preview?, error? }` each.
     * Rows with `href` get a download link; `preview` shows a thumbnail.
     */
    showFiles(items) {
      el('output-list').replaceChildren(
        ...items.map(({ name, detail, href, preview, error }) => {
          const li = document.createElement('li');
          li.className = error ? 'failed' : '';

          const thumb = document.createElement('img');
          thumb.className = 'file-thumb';
          thumb.alt = '';
          thumb.loading = 'lazy';
          if (preview) thumb.src = preview;
          else thumb.hidden = true;

          const text = document.createElement('div');
          text.className = 'file-text';
          const title = document.createElement('p');
          title.className = 'file-name';
          title.textContent = name;
          const meta = document.createElement('p');
          meta.className = `file-detail ${error ? 'error' : ''}`;
          meta.textContent = error || detail;
          text.append(title, meta);

          li.append(thumb, text);
          if (href) {
            const link = document.createElement('a');
            link.href = href;
            link.download = '';
            link.textContent = 'download';
            li.append(link);
          }
          return li;
        }),
      );
      el('output-list').hidden = false;
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
