// Metadata UI: read a file's metadata (flagging what is sensitive), edit it or clean it.
import { $, bindOptions, loadSettings, saveSettings } from '../dom.js';
import { upload } from '../api.js';
import { createResult, triggerDownload } from '../result.js';

const DEFAULTS = { clean: 'on', cover: 'keep' };

const PLACEHOLDERS = {
  date: { image: '2024-05-01 18:30', audio: '2024', video: '2024-05-01' },
  keywords: { pdf: 'comma, separated, words' },
};

export function init(section) {
  const form = $('form', section);
  const state = loadSettings('metadata', DEFAULTS);
  const result = createResult($('.result-slot', section));
  const editor = $('[data-editor]', form);
  const hint = $('[data-inspect-hint]', form);
  let file = null;
  let cover = null;
  let info = null;
  let reading = null;

  const setHint = (text, kind = '') => {
    hint.textContent = text;
    hint.className = `hint ${kind}`;
    hint.hidden = !text;
  };

  const element = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  };

  const updateCleanHint = () => {
    $('[data-clean-hint]', form).textContent =
      state.clean === 'on'
        ? 'Only the fields above are kept: the details listed (and any other tags) are removed.'
        : 'The details listed stay in the file; only the fields above change.';
  };

  const renderOptions = bindOptions(form, state, () => {
    // The cover choice belongs to the current file, not to the saved settings.
    saveSettings('metadata', { ...state, cover: 'keep' });
    updateCleanHint();
  });
  state.cover = 'keep';
  renderOptions();
  updateCleanHint();

  // --- Showing what the file says -------------------------------------------------

  function render() {
    const sensitive = info.details.filter((d) => d.sensitive);
    const alert = $('[data-alert]', form);
    alert.hidden = !sensitive.length;
    alert.textContent = sensitive.length
      ? `⚠ This file reveals: ${sensitive.map((d) => d.label.toLowerCase()).join(', ')}. Remove "everything else" before sharing it.`
      : '';

    const details = $('[data-details]', form);
    details.replaceChildren(
      ...(info.details.length
        ? info.details.map((d) => {
            const li = element('li', d.sensitive ? 'sensitive' : '');
            li.append(element('span', 'meta-label', d.label), element('span', 'meta-value', d.value));
            return li;
          })
        : [element('li', 'meta-empty', 'Nothing else: only the fields below.')]),
    );

    const fields = $('[data-fields]', form);
    fields.replaceChildren(
      ...info.fields.map(({ key, label, value }) => {
        const wrap = element('label', `meta-field${key === 'comment' ? ' wide' : ''}`);
        const input = key === 'comment' ? element('textarea') : element('input');
        input.name = `field-${key}`;
        input.dataset.field = key;
        input.value = value;
        input.placeholder = PLACEHOLDERS[key]?.[info.kind] ?? '';
        if (key === 'comment') input.rows = 2;
        wrap.append(element('span', 'option-label', label), input);
        return wrap;
      }),
    );
    if (!info.fields.length) fields.append(element('p', 'hint', 'This format has no place for these fields; it can only be cleaned.'));

    // The cover choice only shows for audio formats that can hold one.
    state.cover = 'keep';
    $('[data-cover-option]', form).hidden = !info.cover?.supported;
    $('[data-cover-option] .option-label', form).textContent = info.cover?.present ? 'cover (this file has one)' : 'cover (none yet)';
    cover = null;
    $('[data-cover-label]', form).textContent = 'choose the cover image';
    renderOptions();

    editor.hidden = false;
  }

  async function read(picked) {
    if (!picked) return;
    file = picked;
    info = null;
    editor.hidden = true;
    $('[data-file-label]', form).textContent = `${file.name} · change`;
    setHint('reading the file…');

    const data = new FormData();
    data.append('file', file);
    const current = (reading = upload('/api/tools/metadata/inspect', data, {
      onProgress: (value) => value != null && value < 1 && setHint(`uploading to read it… ${Math.round(value * 100)}%`),
    }));
    try {
      const found = await current;
      if (current !== reading) return; // another file was picked meanwhile
      info = found;
      setHint('');
      render();
    } catch (err) {
      if (current === reading) setHint(err.message, 'error');
    }
  }

  // --- Picking files ----------------------------------------------------------------

  const bindDrop = (zone, input, onFile) => {
    input.addEventListener('change', () => {
      onFile(input.files[0]);
      input.value = '';
    });
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      onFile(e.dataTransfer.files[0]);
    });
  };

  bindDrop($('[data-dropzone]', form), form.file, read);
  bindDrop($('[data-cover-drop]', form), form.cover, (picked) => {
    // Browsers often give HEIC photos no type at all.
    if (!picked || !(picked.type.startsWith('image/') || /\.(heic|heif)$/i.test(picked.name))) return;
    cover = picked;
    $('[data-cover-label]', form).textContent = `${picked.name} · change`;
  });

  // --- Saving -----------------------------------------------------------------------

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (result.busy || !file || !info) return;
    if (state.cover === 'replace' && !cover) return result.setStatus('choose the cover image first', 'error');

    const fields = Object.fromEntries([...form.querySelectorAll('[data-field]')].map((input) => [input.dataset.field, input.value]));
    const data = new FormData();
    data.append('tool', 'metadata');
    data.append('fields', JSON.stringify(fields));
    data.append('clean', state.clean);
    data.append('cover', info.cover?.supported ? state.cover : 'keep');
    data.append('file', file);
    if (state.cover === 'replace' && cover) data.append('cover', cover);

    const go = $('.go', form);
    go.disabled = true;
    await result.run((signal) => upload('/api/jobs', data, { signal, onProgress: result.uploadProgress }), {
      onDone: (job, href) => triggerDownload(href),
    });
    go.disabled = false;
  });
}
