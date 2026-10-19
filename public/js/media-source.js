// The "what video?" part of a tool's form: a file (with a player) or a link, plus the range,
// picked on a trimmer or typed. Cloned from #media-source-template into `[data-media-source]`.
import { $, formatTime, parseTime } from './dom.js';
import { api, upload } from './api.js';
import { createTrimmer, renderFilmstrip } from './trimmer.js';

const FILMSTRIP_HEIGHT = 52;

const cssUrl = (url) => `url("${url.replace(/["\\\n]/g, encodeURIComponent)}")`;

/**
 * `state.source` ('file' or 'url') selects the source; call `sync()` after it changes.
 * `maxLength`: longest range allowed (seconds). `defaultLength`: initial range for a new video.
 * `onRangeChange({ start, end })`: called whenever the range changes (seconds or null).
 */
export function createMediaSource(form, state, { maxLength = Infinity, defaultLength = Infinity, onRangeChange } = {}) {
  $('[data-media-source]', form).append($('#media-source-template').content.cloneNode(true));

  const player = $('[data-player]', form);
  const trimmerEl = $('[data-trimmer]', form);
  const hint = $('[data-source-hint]', form);
  let file = null;

  // What each source knows about its video: { duration, start, end, frames?, thumbnail? }.
  // Kept separately so switching between file and link keeps each one's range.
  const sources = { file: null, url: null };
  const hints = { file: [''], url: [''] };

  const active = () => sources[state.source];
  const playingFile = () => state.source === 'file' && sources.file;

  // --- Range inputs ----------------------------------------------------------------

  const typedRange = () => ({ start: parseTime(form.start.value), end: parseTime(form.end.value) });

  const updateLength = () => {
    const { start, end } = typedRange();
    const lengthHint = $('[data-length]', form);
    const length = start != null && end != null ? end - start : null;
    lengthHint.textContent = length > 0 ? `${length.toFixed(1)} s` : '';
    lengthHint.classList.toggle('error', length != null && (length <= 0 || length > maxLength));
    onRangeChange?.({ start, end });
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
    maxLength,
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

  form.start.addEventListener('input', updateLength);
  form.end.addEventListener('input', updateLength);

  // Typed times (on Enter or leaving the field) move the trimmer too.
  for (const input of [form.start, form.end]) {
    input.addEventListener('change', () => {
      const { start, end } = typedRange();
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
    const data = { duration, start: 0, end: Math.min(duration, defaultLength), frames: null };
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
          end: Math.min(info.duration, defaultLength),
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

  let source = state.source;
  updateLength();
  showSource();

  return {
    /** Call after the options change, to follow a switch between file and link. */
    sync() {
      if (state.source === source) return;
      source = state.source;
      player.pause();
      showSource();
    },

    /** The selected range in seconds (from the inputs; null when not valid). */
    get range() {
      return typedRange();
    },

    /** A message when there is nothing to work on yet; null when ready. */
    missing() {
      if (state.source === 'file' && !file) return 'choose a video first';
      if (state.source === 'url' && !form.url.value.trim()) return 'paste a link first';
      return null;
    },

    /**
     * Creates the job with the active source: JSON for a link, a multipart upload for a file.
     * `fields` are the tool and its options; the range is added here.
     */
    submit(fields, { signal, onUploadProgress }) {
      player.pause();
      const body = { ...fields, start: form.start.value.trim(), end: form.end.value.trim() };
      if (state.source === 'url') {
        return api('/api/jobs', { method: 'POST', body: { ...body, url: form.url.value.trim() }, signal });
      }
      const data = new FormData();
      for (const [key, value] of Object.entries(body)) data.append(key, value);
      data.append('file', file);
      return upload('/api/jobs', data, { signal, onProgress: onUploadProgress });
    },
  };
}
