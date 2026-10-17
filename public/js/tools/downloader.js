// Media downloader UI.
import { $, bindOptions, bindPaste, loadSettings, saveSettings } from '../dom.js';
import { api } from '../api.js';
import { createResult, triggerDownload } from '../result.js';

const DEFAULTS = {
  mode: 'video',
  videoFormat: 'mp4',
  quality: '1080',
  audioFormat: 'mp3',
  audioBitrate: '320',
};

export function init(section) {
  const form = $('form', section);
  const state = loadSettings('downloader', DEFAULTS);
  const result = createResult($('.result-slot', section));

  bindOptions(form, state, () => saveSettings('downloader', state));
  bindPaste(form);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = form.url.value.trim();
    if (!url || result.busy) return;

    const go = $('.go', form);
    go.disabled = true;
    await result.run(
      (signal) => {
        api('/api/info', { method: 'POST', body: { url }, signal }).then(result.showPreview).catch(() => {});
        return api('/api/jobs', { method: 'POST', body: { tool: 'downloader', url, ...state }, signal });
      },
      { onDone: (job, href) => triggerDownload(href) },
    );
    go.disabled = false;
  });
}
