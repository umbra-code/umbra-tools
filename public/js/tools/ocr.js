// Text from image UI: paste a screenshot (Ctrl+V), drop or pick images, and the text in them
// shows up ready to copy. It starts reading as soon as there is an image; no button to press.
import { $, bindOptions, loadSettings, saveSettings } from '../dom.js';
import { upload } from '../api.js';
import { createResult } from '../result.js';

const DEFAULTS = { lang: 'spa+eng' };
const MAX_FILES = 100;
// Below this Tesseract was unsure about much of the text.
const LOW_CONFIDENCE = 70;

// Browsers often give HEIC photos no type at all.
const isImage = (file) => file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name);

/** Pasted screenshots are all called "image.png": give them a name that says what they are. */
function named(file) {
  if (file.name && file.name !== 'image.png') return file;
  const time = new Date().toTimeString().slice(0, 8).replaceAll(':', '.');
  const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
  return new File([file], `screenshot ${time}.${ext}`, { type: file.type });
}

/** Copies `text`, showing how it went on `button` for a moment. */
async function copyText(button, text) {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'copied ✓';
  } catch {
    button.textContent = "couldn't copy";
  }
  setTimeout(() => (button.textContent = label), 1600);
}

export function init(section) {
  const form = $('form', section);
  const state = loadSettings('ocr', DEFAULTS);
  const result = createResult($('.result-slot', section));
  const cards = $('[data-ocr-results]', section);
  const hint = $('[data-ocr-hint]', form);
  let files = [];
  let previews = [];
  let running = null; // the reading in progress, if any

  const setHint = (text, kind = '') => {
    hint.textContent = text;
    hint.className = `hint ${kind}`;
    hint.hidden = !text;
  };

  function clearCards() {
    for (const url of previews) URL.revokeObjectURL(url);
    previews = [];
    cards.replaceChildren();
  }

  /** One card per image: its thumbnail, the text (editable before copying) and a copy button. */
  function showResults(results) {
    clearCards();
    const items = results.map((item, i) => {
      const card = document.createElement('article');
      card.className = 'ocr-card';

      const thumb = document.createElement('img');
      thumb.className = 'ocr-thumb';
      thumb.alt = '';
      const url = URL.createObjectURL(files[i]);
      previews.push(url);
      thumb.src = url;
      thumb.addEventListener('error', () => (thumb.hidden = true)); // HEIC: the browser cannot show it

      const body = document.createElement('div');
      body.className = 'ocr-body';
      const head = document.createElement('div');
      head.className = 'ocr-head';
      const name = document.createElement('p');
      name.className = 'ocr-name';
      name.textContent = item.name;
      name.title = item.name;
      head.append(name);
      body.append(head);

      const note = document.createElement('p');
      if (item.error || !item.text) {
        note.className = `hint ${item.error ? 'error' : 'warn'}`;
        note.textContent = item.error || 'No text found in this image.';
        body.append(note);
      } else {
        const text = document.createElement('textarea');
        text.className = 'ocr-text';
        text.value = item.text;
        text.spellcheck = false;
        text.setAttribute('aria-label', `Text read from ${item.name}`);
        text.rows = Math.min(14, Math.max(3, item.text.split('\n').length + 1));

        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'ghost small';
        copy.textContent = 'copy';
        copy.addEventListener('click', () => copyText(copy, text.value));
        head.append(copy);
        body.append(text);

        if (item.confidence < LOW_CONFIDENCE) {
          note.className = 'hint warn';
          note.textContent = 'Some of it was hard to read: check the text before using it.';
          body.append(note);
        }
      }
      card.append(thumb, body);
      return card;
    });

    const read = () => [...cards.querySelectorAll('.ocr-text')];
    cards.append(...items);
    if (read().length > 1) {
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'chip ocr-all';
      all.textContent = 'copy all';
      all.addEventListener('click', () => copyText(all, read().map((t) => t.value).join('\n\n')));
      cards.prepend(all);
    }
    // One image: its text is ready to edit or copy right away.
    if (items.length === 1) read()[0]?.focus({ preventScroll: true });
  }

  async function readImages(picked) {
    const images = [...picked].filter(isImage).map(named);
    if (!images.length) return setHint('only images can go here', 'error');
    setHint(images.length < picked.length ? 'only images can go here; the other files were left out' : '', 'error');
    if (images.length > MAX_FILES) setHint(`at most ${MAX_FILES} images at once; the rest were left out`, 'error');

    // A new image while reading another: the newest one wins.
    if (running) {
      $('.cancel', section).click();
      await running;
    }
    files = images.slice(0, MAX_FILES);
    clearCards();
    running = result.run(
      (signal) => {
        const data = new FormData();
        data.append('tool', 'ocr');
        data.append('lang', state.lang);
        for (const file of files) data.append('file', file);
        return upload('/api/jobs', data, { signal, onProgress: result.uploadProgress });
      },
      {
        onDone: (job) => {
          const found = job.results.filter((r) => r.text).length;
          result.setDownloadLabel('download .txt');
          result.setStatus(
            found ? `read ${found === 1 ? '1 image' : `${found} of ${job.results.length} images`}` : 'no text found',
            found ? 'ok' : 'warn',
          );
          showResults(job.results);
        },
      },
    );
    await running;
    running = null;
  }

  bindOptions(form, state, () => {
    saveSettings('ocr', state);
    // Another language: read the same images again.
    if (files.length) readImages(files);
  });

  form.files.addEventListener('change', () => {
    readImages(form.files.files);
    form.files.value = ''; // so picking the same file again still reads it
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
    readImages(e.dataTransfer.files);
  });

  // Ctrl+V anywhere while this tool is open. Pasting text (e.g. into a result) is left alone.
  document.addEventListener('paste', (e) => {
    if (section.hidden) return;
    const pasted = [...(e.clipboardData?.files ?? [])].filter(isImage);
    if (!pasted.length) return;
    e.preventDefault();
    readImages(pasted);
  });

  // The same from a button, for phones and tablets, which have no Ctrl+V.
  $('[data-paste-image]', form).addEventListener('click', async () => {
    try {
      const items = await navigator.clipboard.read();
      const blobs = [];
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) blobs.push(new File([await item.getType(type)], 'image.png', { type }));
      }
      if (blobs.length) readImages(blobs);
      else setHint('there is no image in the clipboard; copy a screenshot first', 'warn');
    } catch {
      setHint("the browser didn't allow reading the clipboard; press Ctrl + V instead", 'warn');
    }
  });
}
