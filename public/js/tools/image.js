// Image converter UI: pick several images, convert them together, download each or all as a zip.
import { $, bindOptions, formatBytes, loadSettings, saveSettings } from '../dom.js';
import { upload } from '../api.js';
import { createResult, triggerDownload } from '../result.js';

const DEFAULTS = {
  format: 'webp',
  maxSize: 'original',
  metadata: 'remove',
  quality: '80',
};
const MAX_FILES = 100;

/** "−75%" when it got smaller, "+12%" when bigger. */
const sizeChange = (before, after) => {
  const pct = Math.round((after / before - 1) * 100);
  return pct <= 0 ? `−${Math.abs(pct)}%` : `+${pct}%`;
};

export function init(section) {
  const form = $('form', section);
  const state = loadSettings('image', DEFAULTS);
  const result = createResult($('.result-slot', section));
  const list = $('[data-file-list]', form);
  const thumbs = $('[data-thumbs]', form);
  let files = [];

  bindOptions(form, state, () => saveSettings('image', state));

  // --- Quality ------------------------------------------------------------------------

  const qualityValue = $('[data-quality-value]', form);
  form.quality.value = state.quality;
  qualityValue.textContent = state.quality;
  form.quality.addEventListener('input', () => {
    state.quality = form.quality.value;
    qualityValue.textContent = state.quality;
    saveSettings('image', state);
  });

  // --- Picked files ---------------------------------------------------------------------

  const fileKey = (file) => `${file.name}|${file.size}|${file.lastModified}`;

  function renderFiles() {
    for (const img of thumbs.querySelectorAll('img')) URL.revokeObjectURL(img.src);
    thumbs.replaceChildren(
      ...files.map((file, i) => {
        const li = document.createElement('li');
        li.title = `${file.name} · ${formatBytes(file.size)}`;
        const img = document.createElement('img');
        img.alt = file.name;
        img.src = URL.createObjectURL(file);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'remove';
        remove.setAttribute('aria-label', `Remove ${file.name}`);
        remove.textContent = '✕';
        remove.addEventListener('click', () => {
          files.splice(i, 1);
          renderFiles();
        });
        li.append(img, remove);
        return li;
      }),
    );
    const total = files.reduce((sum, file) => sum + file.size, 0);
    $('[data-file-count]', form).textContent = `${files.length} image${files.length === 1 ? '' : 's'} · ${formatBytes(total)}`;
    list.hidden = files.length === 0;
    $('.go', form).textContent = files.length > 1 ? `convert ${files.length} images` : 'convert';
  }

  const addFiles = (picked) => {
    const known = new Set(files.map(fileKey));
    const images = [...picked].filter((file) => file.type.startsWith('image/') || /\.(heic|heif|avif)$/i.test(file.name));
    for (const file of images) {
      if (!known.has(fileKey(file))) files.push(file);
    }
    if (files.length > MAX_FILES) {
      files = files.slice(0, MAX_FILES);
      result.setStatus(`at most ${MAX_FILES} images at once; the rest were left out`, 'error');
    }
    renderFiles();
  };

  form.files.addEventListener('change', () => {
    addFiles(form.files.files);
    form.files.value = ''; // so picking the same files again still fires "change"
  });
  $('[data-clear]', form).addEventListener('click', () => {
    files = [];
    renderFiles();
  });

  const dropzone = $('[data-dropzone]', form);
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('over');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('over');
    addFiles(e.dataTransfer.files);
  });

  // --- Submit -----------------------------------------------------------------------

  /** One row per image: size before → after, with its own download, or why it failed. */
  function showResults(job, sent) {
    const outputs = job.outputs ?? [];
    const rows = (job.results ?? []).map((item, i) => {
      if (item.error) return { name: item.name, error: item.error };
      const index = outputs.findIndex((output) => output.name === item.output);
      const href = `/api/jobs/${job.id}/outputs/${index}`;
      const before = sent[i]?.size;
      return {
        name: item.output,
        href,
        preview: href,
        detail: [
          `${item.width}×${item.height}`,
          before ? `${formatBytes(before)} → ${formatBytes(item.size)} (${sizeChange(before, item.size)})` : formatBytes(item.size),
        ].join(' · '),
      };
    });
    result.showFiles(rows);

    const converted = (job.results ?? []).filter((item) => !item.error);
    const before = sent.reduce((sum, file, i) => sum + (job.results?.[i]?.error ? 0 : file.size), 0);
    const after = converted.reduce((sum, item) => sum + item.size, 0);
    const failed = rows.length - converted.length;
    result.setStatus(
      [
        `done · ${converted.length} image${converted.length === 1 ? '' : 's'}`,
        `${formatBytes(before)} → ${formatBytes(after)} (${sizeChange(before, after)})`,
        failed ? `${failed} failed` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      failed ? 'error' : 'ok',
    );
    if (outputs.length > 1) result.setDownloadLabel('download all (.zip)');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (result.busy) return;
    if (!files.length) return result.setStatus('choose some images first', 'error');

    const sent = [...files];
    const { format, maxSize, metadata, quality } = state;
    const data = new FormData();
    for (const [key, value] of Object.entries({ tool: 'image', format, maxSize, metadata, quality })) data.append(key, value);
    for (const file of sent) data.append('file', file);

    const go = $('.go', form);
    go.disabled = true;
    await result.run((signal) => upload('/api/jobs', data, { signal, onProgress: result.uploadProgress }), {
      onDone: (job, href) => {
        showResults(job, sent);
        if ((job.outputs ?? []).length === 1) triggerDownload(href);
      },
    });
    go.disabled = false;
  });

  renderFiles();
}
