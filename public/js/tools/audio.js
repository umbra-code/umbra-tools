// Audio converter UI: convert, trim, downmix and normalize audio, or extract it from a video.
import { $, bindOptions, bindPaste, loadSettings, saveSettings } from '../dom.js';
import { createResult, triggerDownload } from '../result.js';
import { createMediaSource } from '../media-source.js';

const DEFAULTS = {
  source: 'file',
  format: 'mp3',
  bitrate: '192',
  channels: 'original',
  normalize: 'off',
};

export function init(section) {
  const form = $('form', section);
  const state = loadSettings('audio', DEFAULTS);
  const result = createResult($('.result-slot', section));
  const media = createMediaSource(form, state, {
    accept: 'audio/*,video/*',
    label: 'drop an audio or video file here, or click to choose one',
  });

  bindOptions(form, state, () => {
    saveSettings('audio', state);
    media.sync();
  });
  bindPaste(form);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (result.busy) return;
    const missing = media.missing();
    if (missing) return result.setStatus(missing, 'error');

    const { format, bitrate, channels, normalize } = state;
    const go = $('.go', form);
    go.disabled = true;
    await result.run(
      (signal) =>
        media.submit({ tool: 'audio', format, bitrate, channels, normalize }, { signal, onUploadProgress: result.uploadProgress }),
      {
        onDone: (job, href) => {
          result.showAudio(href);
          triggerDownload(href);
        },
      },
    );
    go.disabled = false;
  });
}
