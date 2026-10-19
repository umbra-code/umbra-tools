// Video converter UI: trim, resize, change format and compress a file or a link.
import { $, $$, bindOptions, bindPaste, loadSettings, saveSettings } from '../dom.js';
import { createResult, triggerDownload } from '../result.js';
import { createMediaSource } from '../media-source.js';

const DEFAULTS = {
  source: 'file',
  format: 'mp4',
  codec: 'h264',
  resolution: 'original',
  fps: 'original',
  audio: 'keep',
  mode: 'quality',
  quality: 'balanced',
  targetMb: '10',
};

// Same budget as the server (src/tools/video/options.js): audio at 128 kbit/s, 3% overhead.
const AUDIO_KBPS = 128;
const MIN_VIDEO_KBPS = 100;

const videoKbps = (targetMb, seconds, withAudio) =>
  Math.floor((targetMb * 1024 * 1024 * 8 * 0.97) / 1000 / seconds - (withAudio ? AUDIO_KBPS : 0));

export function init(section) {
  const form = $('form', section);
  const state = loadSettings('video', DEFAULTS);
  const result = createResult($('.result-slot', section));
  const sizeHint = $('[data-size-hint]', form);
  let range = { start: null, end: null };

  /** For "to a size": what bitrate that leaves, so a too-small target is caught before converting. */
  const updateSizeHint = () => {
    const { start, end } = range;
    const seconds = start != null && end != null ? end - start : null;
    const targetMb = Number(form.targetMb.value);
    if (!seconds || seconds <= 0 || !(targetMb > 0)) {
      sizeHint.textContent = '';
      return;
    }
    const kbps = videoKbps(targetMb, seconds, state.audio === 'keep');
    const tooSmall = kbps < MIN_VIDEO_KBPS;
    const low = kbps < 1000;
    sizeHint.textContent = tooSmall
      ? 'too small for this length; pick a bigger size or a shorter range'
      : `≈ ${kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbit/s` : `${kbps} kbit/s`} for the video${low ? ' · a lower resolution will look better' : ''}`;
    sizeHint.className = `hint ${tooSmall ? 'error' : low ? 'warn' : ''}`;
  };

  // The whole video by default: converting usually means all of it.
  const media = createMediaSource(form, state, {
    onRangeChange: (next) => {
      range = next;
      updateSizeHint();
    },
  });

  bindOptions(form, state, () => {
    saveSettings('video', state);
    media.sync();
    updateSizeHint();
  });
  bindPaste(form);

  form.targetMb.value = state.targetMb;
  form.targetMb.addEventListener('input', () => {
    state.targetMb = form.targetMb.value;
    saveSettings('video', state);
    updateSizeHint();
  });
  for (const btn of $$('[data-mb]', form)) {
    btn.addEventListener('click', () => {
      form.targetMb.value = btn.dataset.mb;
      form.targetMb.dispatchEvent(new Event('input'));
    });
  }
  updateSizeHint();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (result.busy) return;
    const missing = media.missing();
    if (missing) return result.setStatus(missing, 'error');

    const { format, codec, resolution, fps, audio, mode, quality } = state;
    const options = { tool: 'video', format, codec, resolution, fps, audio, mode, quality, targetMb: form.targetMb.value };
    const go = $('.go', form);
    go.disabled = true;
    await result.run(
      (signal) => media.submit(options, { signal, onUploadProgress: result.uploadProgress }),
      {
        onDone: (job, href) => {
          result.showVideo(href);
          triggerDownload(href);
        },
      },
    );
    go.disabled = false;
  });
}
