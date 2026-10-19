// Time values typed by users: "83", "1:23", "1:23.5" or "1:02:03".
import { httpError } from './errors.js';

/** Parses a time into seconds; null when it is not a valid time. */
export function parseTime(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(text)) return null;
  const parts = text.split(':').map(Number);
  if (parts.slice(1).some((part) => part >= 60)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

const isBlank = (value) => value == null || String(value).trim() === '';

/**
 * The `start`/`end` range of a request, in seconds. A blank start is 0; a blank end is null
 * ("until the end"), or a 400 when `requireEnd` is set. Throws a 400 for anything invalid.
 */
export function parseRange(body = {}, { requireEnd = false } = {}) {
  const start = isBlank(body.start) ? 0 : parseTime(body.start);
  const end = isBlank(body.end) ? null : parseTime(body.end);

  if (start === null) throw httpError(400, 'Invalid start time; use seconds or m:ss');
  if (end === null && (requireEnd || !isBlank(body.end))) {
    throw httpError(400, 'Invalid end time; use seconds or m:ss');
  }
  if (end !== null && end <= start) throw httpError(400, 'The end must be after the start');
  return { start, end };
}

/** 83.5 → "1:23.5", 3723 → "1:02:03". */
export function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round((seconds % 60) * 10) / 10;
  const ss = String(s).padStart(s % 1 ? 4 : 2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
