// Small DOM helpers shared by every tool.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function loadSettings(key, defaults) {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(`umbra:${key}`)) };
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(key, state) {
  try {
    localStorage.setItem(`umbra:${key}`, JSON.stringify(state));
  } catch {
    // Storage can be unavailable (private mode, blocked site data); settings just won't persist.
  }
}

/**
 * Wires the segmented button groups (`.group[data-key]`) inside `root` to `state`,
 * and shows or hides elements with `data-show-when="key=a,b"` or `"key!=a,b"`.
 * Returns a function that re-renders, e.g. after changing `state` from code.
 */
export function bindOptions(root, state, onChange) {
  const render = () => {
    for (const group of $$('.group[data-key]', root)) {
      for (const btn of $$('button[data-value]', group)) {
        btn.setAttribute('aria-pressed', String(state[group.dataset.key] === btn.dataset.value));
      }
    }
    for (const el of $$('[data-show-when]', root)) {
      const [, key, negate, values] = el.dataset.showWhen.match(/^(\w+)(!?)=(.*)$/);
      const matches = values.split(',').includes(state[key]);
      el.hidden = negate ? matches : !matches;
    }
  };

  for (const group of $$('.group[data-key]', root)) {
    group.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-value]');
      if (!btn) return;
      state[group.dataset.key] = btn.dataset.value;
      render();
      onChange?.(state);
    });
  }
  render();
  return render;
}

/** Wires `[data-paste]` buttons to fill the closest link input from the clipboard. */
export function bindPaste(root) {
  for (const btn of $$('[data-paste]', root)) {
    const input = $('input[type=url]', btn.parentElement);
    btn.addEventListener('click', async () => {
      try {
        input.value = (await navigator.clipboard.readText()).trim();
        // Let listeners react as if the user had typed it.
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } catch {
        // Clipboard access denied: the user can still paste by hand.
      }
      input.focus();
    });
  }
}

export function formatBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
}

/** 83.5 → "1:23.5"; `decimals` keeps tenths of a second. */
export function formatTime(seconds, decimals = false) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = decimals ? Math.round((seconds % 60) * 10) / 10 : Math.floor(seconds % 60);
  const ss = String(s).padStart(s % 1 ? 4 : 2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Same rules as the server's parseTime: "83", "1:23", "1:23.5", "1:02:03". */
export function parseTime(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(text)) return null;
  const parts = text.split(':').map(Number);
  if (parts.slice(1).some((part) => part >= 60)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}
