// Image viewer with zoom, panning and a before/after comparison.
// Zoom: fit, 100% or 200% (buttons), double-click to toggle fit ↔ 100%, Ctrl + wheel to zoom
// where the pointer is. When zoomed in, drag to move around. Compare: a divider shows the
// original on the left and the result on the right; drag it to move it.
import { $, $$ } from './dom.js';

const MAX_ZOOM = 8;

/** Fit-to-view scale for a width×height image in a viewport: never above 1 (no upscaling). */
export function fitScale(width, height, viewWidth, viewHeight) {
  return Math.min(1, viewWidth / width, viewHeight / height);
}

/**
 * Scroll position that keeps the image point under (px, py) — viewport coordinates — in place
 * when the scale changes from `from` to `to`.
 */
export function anchoredScroll({ scrollLeft, scrollTop }, px, py, from, to) {
  const ratio = to / from;
  return { left: (scrollLeft + px) * ratio - px, top: (scrollTop + py) * ratio - py };
}

export function createViewer(root) {
  const viewport = $('[data-viewport]', root);
  const content = $('[data-viewer-content]', root);
  const result = $('[data-live-img]', root);
  const before = $('[data-before]', root);
  const handle = $('[data-compare-handle]', root);
  const compareButton = $('[data-compare]', root);

  let size = null; // the result's width and height, in pixels
  let zoom = 'fit'; // 'fit' or a scale (1 = actual pixels)
  let comparing = false;
  let split = 50; // divider position, % of the image width

  const maxHeight = () => Math.min(window.innerHeight * 0.6, 760);
  const fit = () => fitScale(size.width, size.height, viewport.clientWidth, maxHeight());
  const scale = () => (zoom === 'fit' ? fit() : zoom);

  function layout() {
    if (!size) return;
    const s = scale();
    content.style.width = `${size.width * s}px`;
    content.style.height = `${size.height * s}px`;
    viewport.classList.toggle('zoomed', s > fit() + 1e-6);
    // From 2× up, show real pixels instead of a blur, so compression artifacts are visible.
    content.classList.toggle('pixelated', s >= 2);
    for (const btn of $$('[data-zoom]', root)) {
      btn.setAttribute('aria-pressed', String(btn.dataset.zoom === String(zoom)));
    }
  }
  new ResizeObserver(layout).observe(viewport);
  window.addEventListener('resize', layout);

  /** Changes the zoom, keeping the point under (px, py) in place (the center by default). */
  function setZoom(next, px = viewport.clientWidth / 2, py = viewport.clientHeight / 2) {
    if (!size) return;
    const from = scale();
    zoom = next === 'fit' ? 'fit' : Math.min(Math.max(next, fit()), MAX_ZOOM);
    layout();
    const { left, top } = anchoredScroll(viewport, px, py, from, scale());
    viewport.scrollTo({ left, top });
  }

  function renderCompare() {
    before.hidden = !comparing;
    handle.hidden = !comparing;
    handle.style.left = `${split}%`;
    result.style.clipPath = comparing ? `inset(0 0 0 ${split}%)` : '';
    compareButton.setAttribute('aria-pressed', String(comparing));
  }

  for (const btn of $$('[data-zoom]', root)) {
    btn.addEventListener('click', () => setZoom(btn.dataset.zoom === 'fit' ? 'fit' : Number(btn.dataset.zoom)));
  }
  compareButton.addEventListener('click', () => {
    comparing = !comparing;
    renderCompare();
  });

  const pointIn = (e) => {
    const rect = viewport.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  viewport.addEventListener('dblclick', (e) => {
    const { x, y } = pointIn(e);
    setZoom(zoom === 'fit' ? 1 : 'fit', x, y);
  });
  viewport.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey || !size) return; // a plain wheel scrolls the page as usual
      e.preventDefault();
      const { x, y } = pointIn(e);
      setZoom(scale() * (e.deltaY < 0 ? 1.25 : 0.8), x, y);
    },
    { passive: false },
  );

  // Dragging: the divider moves the comparison; elsewhere, when zoomed in, it pans.
  let drag = null;
  viewport.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || !size) return;
    const onHandle = comparing && e.target.closest('[data-compare-handle]');
    if (!onHandle && !viewport.classList.contains('zoomed')) return;
    drag = { divider: Boolean(onHandle), x: e.clientX, y: e.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add('dragging');
    e.preventDefault();
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.divider) {
      const rect = content.getBoundingClientRect();
      split = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
      renderCompare();
    } else {
      viewport.scrollTo({ left: drag.left - (e.clientX - drag.x), top: drag.top - (e.clientY - drag.y) });
    }
  });
  const stopDrag = () => {
    drag = null;
    viewport.classList.remove('dragging');
  };
  viewport.addEventListener('pointerup', stopDrag);
  viewport.addEventListener('pointercancel', stopDrag);

  renderCompare();

  return {
    /**
     * Shows a result (`src`, `width`×`height`) and, for the comparison, draws the matching
     * original with `drawBefore(ctx, width, height)`. Zoom and divider stay as they were.
     */
    show(src, { width, height }, drawBefore) {
      size = { width, height };
      result.src = src;
      before.width = width;
      before.height = height;
      drawBefore?.(before.getContext('2d'), width, height);
      layout();
      renderCompare();
    },

    reset() {
      size = null;
      result.removeAttribute('src');
      content.style.width = '';
      content.style.height = '';
      viewport.classList.remove('zoomed');
    },
  };
}
