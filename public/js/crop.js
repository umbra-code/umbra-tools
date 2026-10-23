// Crop box geometry, in image pixels: rectangles are { x, y, w, h } inside a W×H image.

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** The largest rectangle of `ratio` (width / height; null = any) centered in a W×H image. */
export function fitAspect(W, H, ratio) {
  if (!ratio) return { x: 0, y: 0, w: W, h: H };
  let w = W;
  let h = w / ratio;
  if (h > H) {
    h = H;
    w = h * ratio;
  }
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

/** `rect` moved by (dx, dy), kept inside the W×H image. */
export function moveRect(rect, dx, dy, W, H) {
  return { ...rect, x: clamp(rect.x + dx, 0, W - rect.w), y: clamp(rect.y + dy, 0, H - rect.h) };
}

/**
 * `rect` resized by dragging its `corner` ('nw', 'ne', 'sw' or 'se') to (px, py): the opposite
 * corner stays put, the result stays inside the W×H image, keeps `ratio` when given and is at
 * least `min` px on each side.
 */
export function resizeRect(rect, corner, px, py, { W, H, ratio = null, min = 16 }) {
  const west = corner.includes('w');
  const north = corner.includes('n');
  // The corner that does not move, and how far the box can grow from it.
  const ax = west ? rect.x + rect.w : rect.x;
  const ay = north ? rect.y + rect.h : rect.y;
  const maxW = west ? ax : W - ax;
  const maxH = north ? ay : H - ay;

  let w = Math.abs(clamp(px, 0, W) - ax);
  let h = Math.abs(clamp(py, 0, H) - ay);

  if (ratio) {
    // Follow whichever side the pointer pulls further, then fit the limits.
    if (w / Math.max(h, 1e-9) > ratio) h = w / ratio;
    else w = h * ratio;
    const grow = Math.max(min / w, min / h, 1);
    w *= grow;
    h *= grow;
    const shrink = Math.min(maxW / w, maxH / h, 1);
    w *= shrink;
    h *= shrink;
  } else {
    w = clamp(w, Math.min(min, maxW), maxW);
    h = clamp(h, Math.min(min, maxH), maxH);
  }

  return { x: west ? ax - w : ax, y: north ? ay - h : ay, w, h };
}

/** Whole pixels, still inside the W×H image (what the server is sent). */
export function roundRect({ x, y, w, h }, W, H) {
  const left = clamp(Math.round(x), 0, W - 1);
  const top = clamp(Math.round(y), 0, H - 1);
  return {
    x: left,
    y: top,
    w: clamp(Math.round(w), 1, W - left),
    h: clamp(Math.round(h), 1, H - top),
  };
}
