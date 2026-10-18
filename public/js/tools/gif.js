// Video → GIF UI: pick a file or a link, choose the range on a trimmer, convert.
import { $, bindOptions, bindPaste, formatTime, loadSettings, parseTime, saveSettings } from '../dom.js';
import { api, upload } from '../api.js';
import { createResult } from '../result.js';
import { createTrimmer, renderFilmstrip } from '../trimmer.js';

const DEFAULTS = {
  source: 'file',
  fps: '15',
  width: '480',
  format: 'gif',
};
const MAX_SECONDS = 60;
const DEFAULT_LENGTH = 5;
const FILMSTRIP_HEIGHT = 52;

const cssUrl = (url) => `url("${url.replace(/["\\\n]/g, encodeURIComponent)}")`;

export function init(section) {
  const form = $('form', section);
  const state = loadSettings('gif', DEFAULTS);
  const result = createResult($('.result-slot', section));
  const player = $('[data-player]', form);
  const trimmerEl = $('[data-trimmer]', form);
  const hint = $('[data-source-hint]', form);
  let file = null;

  // What each source knows about its video: { duration, start, end, frames? , thumbnail? }.
  // Kept separately so switching between file and link keeps each one's range.
  const sources = { file: null, url: null };
  const hints = { file: [''], url: [''] };

  const active = () => sources[state.source];
  const playingFile = () => state.source === 'file' && sources.file;

  // --- Range inputs ----------------------------------------------------------------

  const updateLength = () => {
    const start = parseTime(form.start.value);
    const end = parseTime(form.end.value);
    const lengthHint = $('[data-length]', form);
    const length = start != null && end != null ? end - start : null;
    lengthHint.textContent = length > 0 ? `${length.toFixed(1)} s` : '';
    lengthHint.classList.toggle('error', length != null && (length <= 0 || length > MAX_SECONDS));
  };

  const writeInputs = (start, end) => {
    form.start.value = formatTime(start, true);
    form.end.value = formatTime(end, true);
    updateLength();
  };

  const remember = (start, end) => {
    if (active()) Object.assign(active(), { start, end });
  };

  // --- Trimmer -----------------------------------------------------------------------

  const trimmer = createTrimmer(trimmerEl, {
    maxLength: MAX_SECONDS,
    onChange: ({ start, end, moving }) => {
      remember(start, end);
      writeInputs(start, end);
      // Show the frame under the handle being dragged.
      if (playingFile()) {
        player.pause();
        player.currentTime = moving === 'end' ? end : start;
      }
    },
    onSeek: (time) => {
      if (playingFile()) player.currentTime = time;
    },
  });

  /** Shows the trimmer for the active source, or hides it when that source has no video yet. */
  function showSource() {
    const [text, kind = ''] = hints[state.source];
    hint.textContent = text;
    hint.className = `hint ${kind}`;
    hint.hidden = !text;

    const data = active();
    trimmerEl.hidden = !data;
    trimmer.setPlayhead(null);
    if (!data) return;

    trimmer.setDuration(data.duration);
    const { start, end } = trimmer.setRange(data.start, data.end);
    writeInputs(start, end);

    const strip = trimmer.filmstrip;
    if (data.frames) {
      strip.style.backgroundImage = '';
      strip.replaceChildren(...data.frames);
    } else {
      strip.replaceChildren();
      strip.style.backgroundImage = data.thumbnail ? cssUrl(data.thumbnail) : '';
    }
  }

  let source = state.source;
  bindOptions(form, state, () => {
    saveSettings('gif', state);
    if (state.source !== source) {
      source = state.source;
      player.pause();
      showSource();
    }
  });
  bindPaste(form);

  form.start.addEventListener('input', updateLength);
  form.end.addEventListener('input', updateLength);

  // Typed times (on Enter or leaving the field) move the trimmer too.
  for (const input of [form.start, form.end]) {
    input.addEventListener('change', () => {
      const start = parseTime(form.start.value);
      const end = parseTime(form.end.value);
      if (!active() || start == null || end == null) return;
      const range = trimmer.setRange(start, end);
      remember(range.start, range.end);
      writeInputs(range.start, range.end);
      if (playingFile()) player.currentTime = range.start;
    });
  }

  // --- File source ---------------------------------------------------------------------

  let filmstripAbort = null;

  const setFile = (picked) => {
    if (!picked) return;
    file = picked;
    $('[data-file-label]', form).textContent = `${file.name} · change`;
    const previous = player.src;
    player.src = URL.createObjectURL(file);
    if (previous) URL.revokeObjectURL(previous);
    player.hidden = false;
    sources.file = null;
    hints.file = [''];
    if (state.source === 'file') showSource();
  };

  form.file.addEventListener('change', () => setFile(form.file.files[0]));

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

  player.addEventListener('loadedmetadata', () => {
    const { duration } = player;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const data = { duration, start: 0, end: Math.min(duration, DEFAULT_LENGTH), frames: null };
    sources.file = data;
    if (state.source === 'file') showSource();

    filmstripAbort?.abort();
    filmstripAbort = new AbortController();
    renderFilmstrip(player.src, {
      width: trimmerEl.clientWidth || form.clientWidth,
      height: FILMSTRIP_HEIGHT,
      signal: filmstripAbort.signal,
      onFrames: (frames) => {
        data.frames = frames;
        if (active() === data) trimmer.filmstrip.replaceChildren(...frames);
      },
    }).catch(() => {
      // No thumbnails: the trimmer still works on a plain track.
    });
  });

  player.addEventListener('error', () => {
    if (!file) return;
    sources.file = null;
    hints.file = ["This browser can't preview this file; type the start and end below.", 'warn'];
    if (state.source === 'file') showSource();
  });

  // Playback loops inside the selected range, like a phone trimmer.
  const tick = () => {
    if (player.paused || !playingFile()) return;
    const { start, end } = trimmer.range;
    if (player.currentTime >= end) player.currentTime = start;
    trimmer.setPlayhead(player.currentTime);
    requestAnimationFrame(tick);
  };
  player.addEventListener('play', () => {
    if (!playingFile()) return;
    const { start, end } = trimmer.range;
    if (player.currentTime < start || player.currentTime >= end) player.currentTime = start;
    requestAnimationFrame(tick);
  });
  player.addEventListener('timeupdate', () => {
    if (playingFile()) trimmer.setPlayhead(player.currentTime);
  });

  // --- Link source ---------------------------------------------------------------------

  let infoAbort = null;
  let infoTimer = null;

  async function loadInfo(url) {
    infoAbort = new AbortController();
    hints.url = ['loading video info…'];
    if (state.source === 'url') showSource();
    try {
      const info = await api('/api/info', { method: 'POST', body: { url }, signal: infoAbort.signal });
      if (info.duration) {
        sources.url = {
          duration: info.duration,
          start: 0,
          end: Math.min(info.duration, DEFAULT_LENGTH),
          thumbnail: info.thumbnail,
        };
        hints.url = [[info.title, formatTime(info.duration)].filter(Boolean).join(' · ')];
      } else {
        hints.url = ['This link has no fixed length (a live stream?); type the start and end below.', 'warn'];
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      hints.url = [err.message, 'error'];
    }
    if (state.source === 'url') showSource();
  }

  form.url.addEventListener('input', () => {
    clearTimeout(infoTimer);
    infoAbort?.abort();
    sources.url = null;
    hints.url = [''];
    if (state.source === 'url') showSource();
    const url = form.url.value.trim();
    if (/^https?:\/\/\S+\.\S+/.test(url)) infoTimer = setTimeout(() => loadInfo(url), 600);
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

    player.pause();
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

  updateLength();
  showSource();
}
