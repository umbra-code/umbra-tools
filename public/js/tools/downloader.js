// Media downloader UI: a single video, or a whole playlist.
import { $, bindOptions, bindPaste, formatBytes, formatTime, loadSettings, saveSettings } from '../dom.js';
import { api } from '../api.js';
import { createResult, triggerDownload } from '../result.js';

const DEFAULTS = {
  mode: 'video',
  videoFormat: 'mp4',
  quality: '1080',
  audioFormat: 'mp3',
  audioBitrate: '320',
  playlist: 'video',
};

/** True for links to a video that is part of a playlist (YouTube's "watch?v=…&list=…"). */
const hasPlaylist = (url) => {
  try {
    const params = new URL(url).searchParams;
    return params.has('list') && params.has('v');
  } catch {
    return false;
  }
};

export function init(section) {
  const form = $('form', section);
  const state = loadSettings('downloader', DEFAULTS);
  const result = createResult($('.result-slot', section));
  const preview = $('[data-link-preview]', form);
  const choice = $('[data-playlist-choice]', form);

  // What the pasted link is: a video or a playlist (`info`), and for a video inside a
  // playlist, that playlist once "whole playlist" is picked (`playlistInfo`).
  let link = null;
  let info = null;
  let playlistInfo = null;
  let loading = null; // the info request in flight: { url, promise }

  const wantsPlaylist = () => info?.type === 'playlist' || (hasPlaylist(link) && state.playlist === 'all');

  function showPreview() {
    const shown = wantsPlaylist() && playlistInfo ? playlistInfo : info;
    preview.hidden = !shown;
    if (!shown) return;
    $('.thumb', preview).src = shown.thumbnail || '';
    $('.thumb', preview).hidden = !shown.thumbnail;
    $('.title', preview).textContent = shown.title || 'Untitled';
    const length =
      shown.type === 'playlist'
        ? `${shown.count ?? '?'} videos${shown.count > shown.maxItems ? ` · the first ${shown.maxItems} will be downloaded` : ''}`
        : formatTime(shown.duration);
    $('.meta', preview).textContent = [shown.uploader, length, shown.site].filter(Boolean).join(' · ');
  }

  async function loadInfo(url, { playlist = false } = {}) {
    try {
      const data = await api('/api/info', { method: 'POST', body: { url, playlist } });
      if (url !== link) return; // a newer link was pasted meanwhile
      if (playlist) playlistInfo = data;
      else info = data;
    } catch (err) {
      if (url === link && !playlist) {
        info = null;
        result.setStatus(err.message, 'error');
      }
    }
    showPreview();
  }

  let timer = null;
  form.url.addEventListener('input', () => {
    clearTimeout(timer);
    link = form.url.value.trim();
    info = null;
    playlistInfo = null;
    state.playlist = 'video';
    choice.hidden = !hasPlaylist(link);
    render();
    showPreview();
    if (/^https?:\/\/\S+\.\S+/.test(link)) {
      const url = link;
      timer = setTimeout(() => {
        loading = { url, promise: loadInfo(url) };
      }, 600);
    }
  });

  const render = bindOptions(form, state, () => {
    // The playlist choice belongs to the current link, not to the saved settings.
    saveSettings('downloader', { ...state, playlist: 'video' });
    if (wantsPlaylist() && !playlistInfo && hasPlaylist(link)) loadInfo(link, { playlist: true });
    showPreview();
  });
  state.playlist = 'video';
  render();
  bindPaste(form);

  /** One row per downloaded video of a playlist, each with its own download. */
  function showPlaylistResult(job) {
    result.showFiles(
      job.outputs.map((output, i) => ({
        name: output.name.replace(/\s*\[[^\]]+\]\.(\w+)$/, '.$1'),
        detail: formatBytes(output.size),
        href: `/api/jobs/${job.id}/outputs/${i}`,
      })),
    );
    result.setDownloadLabel('download all (.zip)');
    const failed = job.failed ? ` · ${job.failed} could not be downloaded` : '';
    result.setStatus(`done · ${job.outputs.length} videos · ${formatBytes(job.size)}${failed}`, job.failed ? 'error' : 'ok');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = form.url.value.trim();
    if (!url || result.busy) return;
    if (url !== link) form.url.dispatchEvent(new Event('input'));

    const go = $('.go', form);
    go.disabled = true;
    await result.run(
      async (signal) => {
        // Know what the link is before starting: a playlist is downloaded differently.
        // Reuse the request already in flight for this link instead of starting another.
        clearTimeout(timer);
        if (!info) {
          result.setStatus('analyzing link…');
          if (loading?.url !== url) loading = { url, promise: loadInfo(url) };
          await loading.promise;
        }
        const shown = wantsPlaylist() && playlistInfo ? playlistInfo : info;
        if (shown) result.showPreview(shown.type === 'playlist' ? { ...shown, duration: null } : shown);
        const { mode, videoFormat, quality, audioFormat, audioBitrate } = state;
        const playlist = wantsPlaylist() ? 'all' : 'video';
        const body = { tool: 'downloader', url, mode, videoFormat, quality, audioFormat, audioBitrate, playlist };
        return api('/api/jobs', { method: 'POST', body, signal });
      },
      {
        onDone: (job, href) => {
          if (job.outputs?.length > 1) showPlaylistResult(job);
          else triggerDownload(href);
        },
      },
    );
    go.disabled = false;
  });
}
