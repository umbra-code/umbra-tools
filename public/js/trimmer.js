// A phone-style trimmer: a filmstrip with two handles to pick a time range.
// Drag a handle to move one end, drag the selection to move both, click the track to seek.
// Handles also work with the keyboard: arrows move 0.1 s, Shift+arrows 1 s.
import { formatTime } from './dom.js';

const MIN_LENGTH = 0.1;
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * Keeps a range inside [0, duration], at least MIN_LENGTH and at most `maxLength` long.
 * `moving` says which end the user is dragging ('start' or 'end'): that one stops at the
 * limits while the other stays put. Otherwise (typed in, moved as a whole) the start wins.
 */
export function clampRange(start, end, { duration, maxLength, moving = null }) {
  let s = clamp(start, 0, duration);
  let e = clamp(end, 0, duration);
  if (moving === 'start') {
    s = clamp(s, Math.max(0, e - maxLength), e - MIN_LENGTH);
  } else if (moving === 'end') {
    e = clamp(e, s + MIN_LENGTH, Math.min(duration, s + maxLength));
  } else {
    e = clamp(e, Math.min(s + MIN_LENGTH, duration), Math.min(duration, s + maxLength));
    s = Math.min(s, e - MIN_LENGTH);
  }
  return { start: Math.max(0, s), end: e };
}

/**
 * Builds the trimmer inside `root`.
 * `onChange({ start, end, moving })` fires while the user drags ('start', 'end' or 'move');
 * `onSeek(time)` fires when the track is clicked outside the selection.
 */
export function createTrimmer(root, { maxLength, onChange, onSeek }) {
  root.classList.add('trimmer');
  root.innerHTML = `
    <div class="track" data-track>
      <div class="strip-clip">
        <div class="filmstrip" data-filmstrip></div>
        <div class="shade start" data-shade="start"></div>
        <div class="shade end" data-shade="end"></div>
      </div>
      <div class="selection" data-selection>
        <span class="handle start" data-handle="start" role="slider" tabindex="0" aria-label="Start"></span>
        <span class="handle end" data-handle="end" role="slider" tabindex="0" aria-label="End"></span>
      </div>
      <div class="playhead" data-playhead hidden></div>
    </div>
    <div class="trimmer-times">
      <span data-time="start"></span>
      <span data-time="length"></span>
      <span data-time="end"></span>
    </div>`;

  const q = (selector) => root.querySelector(selector);
  const track = q('[data-track]');
  const selection = q('[data-selection]');
  const handles = { start: q('[data-handle=start]'), end: q('[data-handle=end]') };
  const playhead = q('[data-playhead]');

  let duration = 0;
  let start = 0;
  let end = 0;

  const pct = (time) => (duration ? (time / duration) * 100 : 0);

  function render() {
    selection.style.left = `${pct(start)}%`;
    selection.style.width = `${pct(end - start)}%`;
    q('[data-shade=start]').style.width = `${pct(start)}%`;
    q('[data-shade=end]').style.width = `${100 - pct(end)}%`;
    q('[data-time=start]').textContent = formatTime(start, true);
    q('[data-time=end]').textContent = formatTime(end, true);
    q('[data-time=length]').textContent = `${(end - start).toFixed(1)} s`;
    for (const [name, value] of Object.entries({ start, end })) {
      handles[name].setAttribute('aria-valuemin', '0');
      handles[name].setAttribute('aria-valuemax', String(duration));
      handles[name].setAttribute('aria-valuenow', value.toFixed(1));
      handles[name].setAttribute('aria-valuetext', formatTime(value, true));
    }
  }

  /** Applies a range, keeping it inside the video and within the length limits. */
  function apply(nextStart, nextEnd, moving) {
    ({ start, end } = clampRange(nextStart, nextEnd, { duration, maxLength, moving }));
    render();
    return { start, end };
  }

  const update = (s, e, moving) => {
    apply(s, e, moving);
    onChange?.({ start, end, moving });
  };

  const timeAt = (clientX) => {
    const rect = track.getBoundingClientRect();
    return clamp((clientX - rect.left) / rect.width, 0, 1) * duration;
  };

  // --- Pointer -------------------------------------------------------------------

  let drag = null;

  track.addEventListener('pointerdown', (e) => {
    if (!duration || e.button > 0) return;
    const handle = e.target.closest('[data-handle]');
    const time = timeAt(e.clientX);
    if (handle) {
      drag = { type: handle.dataset.handle };
      handle.focus();
    } else if (e.target.closest('[data-selection]')) {
      drag = { type: 'move', offset: time - start, length: end - start };
    } else {
      onSeek?.(time);
      return;
    }
    track.setPointerCapture(e.pointerId);
    track.classList.add('dragging');
    e.preventDefault();
  });

  track.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const time = timeAt(e.clientX);
    if (drag.type === 'start') update(time, end, 'start');
    else if (drag.type === 'end') update(start, time, 'end');
    else {
      const s = clamp(time - drag.offset, 0, duration - drag.length);
      update(s, s + drag.length, 'move');
    }
  });

  const stopDrag = () => {
    drag = null;
    track.classList.remove('dragging');
  };
  track.addEventListener('pointerup', stopDrag);
  track.addEventListener('pointercancel', stopDrag);

  // --- Keyboard ------------------------------------------------------------------

  for (const [name, handle] of Object.entries(handles)) {
    handle.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const delta = step * (e.shiftKey ? 1 : 0.1);
      if (name === 'start') update(start + delta, end, 'start');
      else update(start, end + delta, 'end');
    });
  }

  return {
    filmstrip: q('[data-filmstrip]'),

    get range() {
      return { start, end };
    },

    setDuration(value) {
      duration = value;
      render();
    },

    /** Sets the range from code (no onChange); returns it after clamping. */
    setRange(s, e) {
      return apply(s, e, null);
    },

    /** Moves the playback position marker; null hides it. */
    setPlayhead(time) {
      playhead.hidden = time == null;
      if (time != null) playhead.style.left = `${pct(time)}%`;
    },
  };
}

const once = (target, event, timeoutMs = 4000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeoutMs);
    target.addEventListener(event, () => (clearTimeout(timer), resolve()), { once: true });
    target.addEventListener('error', () => (clearTimeout(timer), reject(new Error('video error'))), { once: true });
  });

/**
 * Draws frames of the video at `src`, spread over its length, for a strip of `width`×`height` px.
 * Runs in the browser with a hidden video and a canvas per frame; stops when `signal` aborts.
 * `onFrames(canvases)` gets the (still empty) canvases right away, so they can be shown
 * while they fill in.
 */
export async function renderFilmstrip(src, { width, height, signal, onFrames }) {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = src;
  await once(video, 'loadedmetadata');

  const aspect = video.videoWidth / video.videoHeight || 16 / 9;
  const count = clamp(Math.ceil(width / (height * aspect)), 1, 24);
  const scale = window.devicePixelRatio || 1;

  const frames = Array.from({ length: count }, () => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(height * aspect * scale);
    canvas.height = Math.round(height * scale);
    return canvas;
  });
  onFrames(frames);

  try {
    for (const [i, canvas] of frames.entries()) {
      if (signal.aborted) break;
      video.currentTime = ((i + 0.5) / count) * video.duration;
      await once(video, 'seeked');
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    }
  } catch {
    // Some frames could not be decoded; the strip keeps whatever was drawn.
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}
