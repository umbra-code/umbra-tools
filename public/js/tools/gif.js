// Video → GIF UI: pick a file or a link, choose the range on a trimmer, convert.
import { $, bindOptions, bindPaste, loadSettings, saveSettings } from '../dom.js';
import { createResult } from '../result.js';
import { createMediaSource } from '../media-source.js';

const DEFAULTS = {
  source: 'file',
  fps: '15',
  width: '480',
  format: 'gif',
};

export function init(section) {
  const form = $('form', section);
  const state = loadSettings('gif', DEFAULTS);
  const result = createResult($('.result-slot', section));
  const media = createMediaSource(form, state, { maxLength: 60, defaultLength: 5 });

  bindOptions(form, state, () => {
    saveSettings('gif', state);
    media.sync();
  });
  bindPaste(form);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (result.busy) return;
    const missing = media.missing();
    if (missing) return result.setStatus(missing, 'error');

    const go = $('.go', form);
    go.disabled = true;
    await result.run(
      (signal) =>
        media.submit(
          { tool: 'gif', fps: state.fps, width: state.width, format: state.format },
          { signal, onUploadProgress: result.uploadProgress },
        ),
      { onDone: (job, href) => result.showImage(href) },
    );
    go.disabled = false;
  });
}
