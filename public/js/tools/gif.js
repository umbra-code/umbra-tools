// Video → GIF UI: pick a file or a link, choose the range on a trimmer, convert.
import { $, bindOptions, bindPaste, loadSettings, saveSettings } from '../dom.js';
import { createResult } from '../result.js';
import { createMediaSource } from '../media-source.js';

const DEFAULTS = {
  source: 'file',
  fps: '15',
  width: '480',
  format: 'gif',
  speed: '1',
  direction: 'forward',
};

// Same limit as the server (GIF_MAX_SECONDS), for the clip and for the animation.
const MAX_SECONDS = 60;

export function init(section) {
  const form = $('form', section);
  const state = loadSettings('gif', DEFAULTS);
  const result = createResult($('.result-slot', section));
  const lengthHint = $('[data-gif-length]', form);
  let range = { start: null, end: null };

  /** How long the animation lasts once sped up, slowed down or played back and forth. */
  const updateLength = () => {
    const { start, end } = range;
    const changed = state.speed !== '1' || state.direction === 'boomerang';
    if (!changed || start == null || end == null || end <= start) {
      lengthHint.textContent = '';
      return;
    }
    const seconds = (end - start) / Number(state.speed);
    const length = seconds * (state.direction === 'boomerang' ? 2 : 1);
    const tooLong = seconds > MAX_SECONDS;
    lengthHint.textContent = tooLong
      ? `too long at ${state.speed}×; pick at most ${MAX_SECONDS * Number(state.speed)} s`
      : `the animation lasts ${length.toFixed(1)} s`;
    lengthHint.className = `hint ${tooLong ? 'error' : ''}`;
  };

  const media = createMediaSource(form, state, {
    maxLength: MAX_SECONDS,
    defaultLength: 5,
    // A GIF in: to speed it up, slow it down, reverse it or make it a boomerang.
    accept: 'video/*,image/gif',
    label: 'drop a video or a GIF here or click to choose one',
    onRangeChange: (next) => {
      range = next;
      updateLength();
    },
  });

  bindOptions(form, state, () => {
    saveSettings('gif', state);
    media.sync();
    updateLength();
  });
  bindPaste(form);
  updateLength();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (result.busy) return;
    const missing = media.missing();
    if (missing) return result.setStatus(missing, 'error');

    const { fps, width, format, speed, direction } = state;
    const go = $('.go', form);
    go.disabled = true;
    await result.run(
      (signal) =>
        media.submit(
          { tool: 'gif', fps, width, format, speed, direction },
          { signal, onUploadProgress: result.uploadProgress },
        ),
      { onDone: (job, href) => result.showImage(href) },
    );
    go.disabled = false;
  });
}
