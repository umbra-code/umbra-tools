// PDF tool options and page ranges (pure, so they can be tested without PDFs).
import { httpError } from '../../core/errors.js';
import { pickAllowed } from '../../core/input.js';

export const OPTIONS = {
  mode: ['merge', 'images', 'extract'],
  pageSize: ['fit', 'a4', 'letter'],
};

export const DEFAULTS = {
  mode: 'merge',
  pageSize: 'fit',
};

/** Page sizes in points (1/72 inch), portrait. */
export const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

/**
 * Parses a page selection like "1-3, 5, 8-" (8 to the end) or "-4" (1 to 4) into ranges
 * `{ from, to }` with 1-based pages; `to` is null for "to the end". Null when it is not valid.
 */
export function parsePageSpec(text) {
  const parts = String(text ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return null;

  const ranges = [];
  for (const part of parts) {
    const match = part.match(/^(\d*)\s*(-)?\s*(\d*)$/);
    if (!match || (!match[1] && !match[3])) return null;
    const [, first, dash, last] = match;
    const from = first ? Number(first) : 1;
    const to = dash ? (last ? Number(last) : null) : from;
    if (from < 1 || (to !== null && to < from)) return null;
    ranges.push({ from, to });
  }
  return ranges;
}

/**
 * 0-based page indices for `ranges` in a document of `count` pages, in the order given.
 * Throws a readable error when a page does not exist.
 */
export function resolvePages(ranges, count) {
  const pages = [];
  for (const { from, to } of ranges) {
    const end = to ?? count;
    if (from > count || end > count) {
      throw new Error(`The PDF has ${count} page${count === 1 ? '' : 's'}; page ${Math.max(from, end)} does not exist`);
    }
    for (let page = from; page <= end; page++) pages.push(page - 1);
  }
  return pages;
}

/** Allowed options; for "extract", also the parsed page ranges. */
export function parseOptions(body = {}) {
  const options = pickAllowed(body, OPTIONS, DEFAULTS);
  if (options.mode !== 'extract') return options;

  const ranges = parsePageSpec(body.pages);
  if (!ranges) throw httpError(400, 'Write the pages to extract like "1-3, 5, 8-"');
  return { ...options, ranges };
}

/**
 * Where an image of `width`×`height` px goes on a page: `{ page: [w, h], box: { x, y, width, height } }`
 * in points. "fit" makes the page the image's size (at 96 dpi); A4 and letter turn landscape for
 * wide images and fit the image inside a margin, centered, never enlarging it past 96 dpi.
 */
export function layoutImage(width, height, pageSize, margin = 24) {
  const pt = (px) => px * 0.75; // 96 dpi
  if (pageSize === 'fit') {
    return { page: [pt(width), pt(height)], box: { x: 0, y: 0, width: pt(width), height: pt(height) } };
  }

  const [short, long] = PAGE_SIZES[pageSize];
  const [pageW, pageH] = width > height ? [long, short] : [short, long];
  const scale = Math.min((pageW - 2 * margin) / pt(width), (pageH - 2 * margin) / pt(height), 1);
  const w = pt(width) * scale;
  const h = pt(height) * scale;
  return { page: [pageW, pageH], box: { x: (pageW - w) / 2, y: (pageH - h) / 2, width: w, height: h } };
}
