// PDF tool UI: merge PDFs, turn images into a PDF or extract pages. Each mode keeps its own files.
import { $, bindOptions, formatBytes, loadSettings, saveSettings } from '../dom.js';
import { upload } from '../api.js';
import { createResult, triggerDownload } from '../result.js';

const DEFAULTS = {
  mode: 'merge',
  pageSize: 'fit',
};
const MAX_FILES = 100;

const MODES = {
  merge: {
    accept: 'application/pdf,.pdf',
    label: 'drop the PDFs to merge here, or click to choose them',
    multiple: true,
    isValid: (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name),
    hint: (n) => (n < 2 ? 'add at least one more PDF' : `${n} PDFs, merged from top to bottom`),
    submit: 'merge pdfs',
  },
  images: {
    accept: 'image/*,.heic,.heif',
    label: 'drop images here, or click to choose them',
    multiple: true,
    // Browsers often give HEIC photos no type at all.
    isValid: (file) => file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name),
    hint: (n) => `${n} image${n === 1 ? '' : 's'}, one per page, from top to bottom`,
    submit: 'create pdf',
  },
  extract: {
    accept: 'application/pdf,.pdf',
    label: 'drop a PDF here, or click to choose it',
    multiple: false,
    isValid: (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name),
    hint: () => '',
    submit: 'extract pages',
  },
};

export function init(section) {
  const form = $('form', section);
  const state = loadSettings('pdf', DEFAULTS);
  const result = createResult($('.result-slot', section));
  const rows = $('[data-file-rows]', form);
  const hint = $('[data-files-hint]', form);
  const lists = { merge: [], images: [], extract: [] };

  const mode = () => MODES[state.mode];
  const files = () => lists[state.mode];

  const button = (label, title, onClick, disabled = false) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost small';
    btn.textContent = label;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.disabled = disabled;
    btn.addEventListener('click', onClick);
    return btn;
  };

  function render() {
    const list = files();
    form.files.accept = mode().accept;
    form.files.multiple = mode().multiple;
    $('[data-drop-label]', form).textContent = mode().label;
    $('.go', form).textContent = mode().submit;

    rows.replaceChildren(
      ...list.map((file, i) => {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'file-row-name';
        name.textContent = file.name;
        const size = document.createElement('span');
        size.className = 'file-row-size';
        size.textContent = formatBytes(file.size);
        const move = (to) => () => {
          list.splice(to, 0, ...list.splice(i, 1));
          render();
        };
        li.append(name, size);
        if (mode().multiple) {
          li.append(button('↑', `Move ${file.name} up`, move(i - 1), i === 0));
          li.append(button('↓', `Move ${file.name} down`, move(i + 1), i === list.length - 1));
        }
        li.append(
          button('✕', `Remove ${file.name}`, () => {
            list.splice(i, 1);
            render();
          }),
        );
        return li;
      }),
    );
    rows.hidden = list.length === 0;
    const text = list.length ? mode().hint(list.length) : '';
    hint.textContent = text;
    hint.hidden = !text;
  }

  const addFiles = (picked) => {
    const valid = [...picked].filter(mode().isValid);
    if (valid.length < picked.length) {
      result.setStatus(state.mode === 'images' ? 'only images can go into the PDF' : 'only PDF files work here', 'error');
    }
    if (!mode().multiple) {
      lists[state.mode] = valid.slice(0, 1);
    } else {
      lists[state.mode] = [...files(), ...valid].slice(0, MAX_FILES);
    }
    render();
  };

  bindOptions(form, state, () => {
    saveSettings('pdf', state);
    render();
  });

  form.files.addEventListener('change', () => {
    addFiles(form.files.files);
    form.files.value = ''; // so picking the same file again still fires "change"
  });

  const dropzone = $('[data-dropzone]', form);
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('over');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('over');
    addFiles(e.dataTransfer.files);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (result.busy) return;
    const list = files();
    if (!list.length) return result.setStatus(state.mode === 'images' ? 'choose some images first' : 'choose a PDF first', 'error');
    if (state.mode === 'merge' && list.length < 2) return result.setStatus('add at least two PDFs to merge', 'error');
    if (state.mode === 'extract' && !form.pages.value.trim()) {
      form.pages.focus();
      return result.setStatus('write the pages to extract, like 1-3, 5', 'error');
    }

    const data = new FormData();
    const fields = { tool: 'pdf', mode: state.mode, pageSize: state.pageSize, pages: form.pages.value.trim() };
    for (const [key, value] of Object.entries(fields)) data.append(key, value);
    for (const file of list) data.append('file', file);

    const go = $('.go', form);
    go.disabled = true;
    await result.run((signal) => upload('/api/jobs', data, { signal, onProgress: result.uploadProgress }), {
      onDone: (job, href) => triggerDownload(href),
    });
    go.disabled = false;
  });

  render();
}
