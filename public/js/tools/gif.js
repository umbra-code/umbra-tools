// Video → GIF UI: pick a file (with a player to choose the range) or a link.
import { $, $$, bindOptions, bindPaste, formatTime, loadSettings, parseTime, saveSettings } from '../dom.js';
import { api, upload } from '../api.js';
import { createResult } from '../result.js';

const DEFAULTS = {
  source: 'file',
  fps: '15',
  width: '480',
  format: 'gif',
};
const MAX_SECONDS = 60;

export function init(section) {
  const form = $('form', section);
  const state = loadSettings('gif', DEFAULTS);
  const result = createResult($('.result-slot', section));
  const player = $('[data-player]', form);
  const fileInput = form.file;
  let file = null;

  bindOptions(form, state, () => saveSettings('gif', state));
  bindPaste(form);

  // --- Range ---------------------------------------------------------------------

  const updateLength = () => {
    const start = parseTime(form.start.value);
    const end = parseTime(form.end.value);
    const hint = $('[data-length]', form);
    const length = start != null && end != null ? end - start : null;
    hint.textContent = length > 0 ? `${formatTime(length, true).replace(/^0:/, '')} s` : '';
    hint.classList.toggle('error', length != null && (length <= 0 || length > MAX_SECONDS));
  };
  form.start.addEventListener('input', updateLength);
  form.end.addEventListener('input', updateLength);
  updateLength();

  for (const btn of $$('[data-mark]', form)) {
    btn.addEventListener('click', () => {
      form[btn.dataset.mark].value = formatTime(player.currentTime, true);
      updateLength();
    });
  }

  // --- File picking ----------------------------------------------------------------

  const setFile = (picked) => {
    if (!picked) return;
    file = picked;
    $('[data-file-label]', form).textContent = `${file.name} · change`;
    URL.revokeObjectURL(player.src);
    player.src = URL.createObjectURL(file);
    player.hidden = false;
    for (const btn of $$('[data-mark]', form)) btn.hidden = false;
  };

  fileInput.addEventListener('change', () => setFile(fileInput.files[0]));

  const dropzone = $('[data-dropzone]', form);
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('over');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('over');
    setFile(e.dataTransfer.files[0]);
  });

  // When the video loads, suggest a range if the default one does not fit.
  player.addEventListener('loadedmetadata', () => {
    const end = parseTime(form.end.value);
    if (end == null || end > player.duration) {
      form.start.value = '0:00';
      form.end.value = formatTime(Math.min(player.duration, 5), true);
      updateLength();
    }
  });

  // --- Submit -----------------------------------------------------------------------

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (result.busy) return;

    const options = {
      tool: 'gif',
      start: form.start.value.trim(),
      end: form.end.value.trim(),
      fps: state.fps,
      width: state.width,
      format: state.format,
    };

    if (state.source === 'file' && !file) {
      result.setStatus('choose a video first', 'error');
      return;
    }
    const url = form.url.value.trim();
    if (state.source === 'url' && !url) {
      form.url.focus();
      return;
    }

    const go = $('.go', form);
    go.disabled = true;
    await result.run(
      (signal) => {
        if (state.source === 'url') {
          return api('/api/jobs', { method: 'POST', body: { ...options, url }, signal });
        }
        const data = new FormData();
        for (const [key, value] of Object.entries(options)) data.append(key, value);
        data.append('file', file);
        return upload('/api/jobs', data, {
          signal,
          onProgress: (value) => {
            result.setStatus(`uploading${value != null ? ` ${Math.round(value * 100)}%` : '…'}`);
            result.setProgress(value);
          },
        });
      },
      { onDone: (job, href) => result.showImage(href) },
    );
    go.disabled = false;
  });
}
