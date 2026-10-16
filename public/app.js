const $ = (sel) => document.querySelector(sel);

const DEFAULTS = {
  mode: 'video',
  videoFormat: 'mp4',
  quality: '1080',
  audioFormat: 'mp3',
  audioBitrate: '320',
};
const LOSSLESS = ['wav', 'flac', 'original'];

const state = { ...DEFAULTS, ...loadSettings() };
let currentJob = null;

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem('umbra-settings')) || {};
  } catch {
    return {};
  }
}

function saveSettings() {
  try {
    localStorage.setItem('umbra-settings', JSON.stringify(state));
  } catch {
    // Storage can be unavailable (private mode, blocked site data); settings just won't persist.
  }
}

// --- Options -------------------------------------------------------------------

function render() {
  document.querySelectorAll('.group[data-key]').forEach((group) => {
    group.querySelectorAll('button').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(state[group.dataset.key] === btn.dataset.value));
    });
  });
  $('#video-options').hidden = state.mode === 'audio';
  $('#audio-options').hidden = state.mode !== 'audio';
  $('#bitrate-label').hidden = LOSSLESS.includes(state.audioFormat);
}

document.querySelectorAll('.group[data-key]').forEach((group) => {
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (!btn) return;
    state[group.dataset.key] = btn.dataset.value;
    saveSettings();
    render();
  });
});

$('#paste').addEventListener('click', async () => {
  try {
    $('#url').value = (await navigator.clipboard.readText()).trim();
    $('#url').focus();
  } catch {
    $('#url').focus();
  }
});

// --- API -----------------------------------------------------------------------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// --- Download status -----------------------------------------------------------

function setStatus(text, kind = '') {
  const el = $('#status-text');
  el.textContent = text;
  el.className = kind;
}

function setProgress(value) {
  const fill = $('#bar-fill');
  if (value == null) {
    fill.classList.add('indeterminate');
    fill.style.width = '';
  } else {
    fill.classList.remove('indeterminate');
    fill.style.width = `${Math.round(value * 100)}%`;
  }
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function formatDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function renderPreview(info) {
  $('#thumb').src = info.thumbnail || '';
  $('#thumb').hidden = !info.thumbnail;
  $('#title').textContent = info.title || 'Untitled';
  $('#meta').textContent = [info.uploader, formatDuration(info.duration), info.site]
    .filter(Boolean)
    .join(' · ');
  $('#preview').hidden = false;
}

function describe(job) {
  switch (job.status) {
    case 'queued':
      return 'queued…';
    case 'downloading': {
      const part = job.parts > 1 ? ` (part ${Math.max(job.part, 1)}/${job.parts})` : '';
      const pct = job.progress != null ? ` ${Math.round(job.progress * 100)}%` : '';
      const retry = job.attempt ? ` · retry ${job.attempt}` : '';
      return `downloading${part}${pct}${retry}`;
    }
    case 'processing':
      return 'processing with ffmpeg…';
    default:
      return job.status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(id) {
  let networkErrors = 0;
  while (currentJob === id) {
    let job;
    try {
      job = await api(`/api/jobs/${id}`);
      networkErrors = 0;
    } catch (err) {
      // fetch throws TypeError when the server is unreachable; tolerate brief outages.
      if (!(err instanceof TypeError)) throw err;
      if (++networkErrors > 10) {
        throw new Error('lost connection to the server; is it still running?', { cause: err });
      }
      setStatus('server unreachable, retrying…');
      await sleep(1500);
      continue;
    }
    if (job.status === 'done') return job;
    if (job.status === 'error') throw new Error(job.error);
    if (job.status === 'cancelled') throw new Error('cancelled');
    setStatus(describe(job));
    setProgress(job.status === 'downloading' ? job.progress : null);
    await sleep(600);
  }
  throw new Error('cancelled');
}

function triggerDownload(href) {
  const a = document.createElement('a');
  a.href = href;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#url').value.trim();
  if (!url) return;

  $('#go').disabled = true;
  $('#result').hidden = false;
  $('#preview').hidden = true;
  $('#again').hidden = true;
  $('#cancel').hidden = false;
  setStatus('analyzing link…');
  setProgress(null);

  api('/api/info', { method: 'POST', body: { url } }).then(renderPreview).catch(() => {});

  try {
    const job = await api('/api/jobs', { method: 'POST', body: { url, ...state } });
    currentJob = job.id;
    const done = await poll(job.id);
    const href = `/api/jobs/${done.id}/file`;
    setProgress(1);
    setStatus(`done · ${formatBytes(done.size)}`, 'ok');
    $('#again').href = href;
    $('#again').hidden = false;
    triggerDownload(href);
  } catch (err) {
    setProgress(0);
    setStatus(err.message, 'error');
  } finally {
    currentJob = null;
    $('#go').disabled = false;
    $('#cancel').hidden = true;
  }
});

$('#cancel').addEventListener('click', () => {
  const id = currentJob;
  currentJob = null;
  if (id) api(`/api/jobs/${id}`, { method: 'DELETE' }).catch(() => {});
});

render();
