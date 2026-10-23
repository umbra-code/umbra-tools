// Images UI. One image opens the editor (crop, rotate, flip, size) with a live preview of the
// exact result, ready to copy or download. Several images are converted together as a batch.
import { $, $$, bindOptions, formatBytes, loadSettings, saveSettings } from '../dom.js';
import { upload } from '../api.js';
import { createResult, triggerDownload } from '../result.js';
import { fitAspect, moveRect, resizeRect, roundRect } from '../crop.js';
import { createViewer } from '../viewer.js';

const DEFAULTS = {
  format: 'webp',
  maxSize: 'original',
  metadata: 'remove',
  quality: '80',
  aspect: 'free',
};
const RATIOS = { free: null, original: 'image', '1:1': 1, '4:5': 4 / 5, '16:9': 16 / 9, '9:16': 9 / 16, '3:2': 3 / 2 };
const MAX_FILES = 100;
const MAX_SIDE = 16384;
// The crop box never gets smaller than this on screen, so it stays easy to grab.
const MIN_BOX_CSS_PX = 32;
// How long after the last change the preview is rendered.
const PREVIEW_DELAY_MS = 350;

/** "−75%" when it got smaller, "+12%" when bigger. */
const sizeChange = (before, after) => {
  const pct = Math.round((after / before - 1) * 100);
  return pct <= 0 ? `−${Math.abs(pct)}%` : `+${pct}%`;
};

export function init(section) {
  const form = $('form', section);
  const state = loadSettings('image', DEFAULTS);
  const result = createResult($('.result-slot', section));
  const hint = $('[data-image-hint]', form);
  let files = [];

  const setHint = (text, kind = '') => {
    hint.textContent = text;
    hint.className = `hint ${kind}`;
    hint.hidden = !text;
  };

  // --- Options shared by both modes -----------------------------------------------------

  let aspect = state.aspect;
  bindOptions(form, state, () => {
    saveSettings('image', state);
    // Only a new aspect ratio moves the crop box; other options leave it alone.
    if (state.aspect !== aspect) {
      aspect = state.aspect;
      if (editor.ready) editor.resetCrop();
    }
    schedulePreview();
  });

  const qualityValue = $('[data-quality-value]', form);
  form.quality.value = state.quality;
  qualityValue.textContent = state.quality;
  form.quality.addEventListener('input', () => {
    state.quality = form.quality.value;
    qualityValue.textContent = state.quality;
    saveSettings('image', state);
    schedulePreview();
  });

  // --- Mode: one image (editor) or several (batch) -----------------------------------------

  function setMode() {
    const one = files.length === 1;
    $('[data-editor]', form).hidden = !one || !editor.ready;
    $('[data-live]', form).hidden = !one;
    $('[data-file-list]', form).hidden = files.length < 2;
    $('[data-options]', form).hidden = files.length === 0;
    for (const el of $$('[data-single]', form)) el.hidden = !one;
    for (const el of $$('[data-batch]', form)) el.hidden = files.length < 2;
    $('[data-drop-label]', form).textContent = files.length
      ? 'add more images, or drop new ones'
      : 'drop one image to edit it, or several to convert them together';
  }

  // --- Batch: the picked images ----------------------------------------------------------------

  const thumbs = $('[data-thumbs]', form);
  const fileKey = (file) => `${file.name}|${file.size}|${file.lastModified}`;

  function renderFiles() {
    for (const img of thumbs.querySelectorAll('img')) URL.revokeObjectURL(img.src);
    thumbs.replaceChildren(
      ...(files.length < 2
        ? []
        : files.map((file, i) => {
            const li = document.createElement('li');
            li.title = `${file.name} · ${formatBytes(file.size)}`;
            const img = document.createElement('img');
            img.alt = file.name;
            img.src = URL.createObjectURL(file);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'remove';
            remove.setAttribute('aria-label', `Remove ${file.name}`);
            remove.textContent = '✕';
            remove.addEventListener('click', () => setFiles(files.filter((_, j) => j !== i)));
            li.append(img, remove);
            return li;
          })),
    );
    const total = files.reduce((sum, file) => sum + file.size, 0);
    $('[data-file-count]', form).textContent = `${files.length} images · ${formatBytes(total)}`;
    $('.go', form).textContent = `convert ${files.length} images`;
  }

  /** Changes the picked images and switches between editing one and converting several. */
  function setFiles(next) {
    const previous = files.length === 1 ? files[0] : null;
    files = next.slice(0, MAX_FILES);
    if (next.length > MAX_FILES) setHint(`at most ${MAX_FILES} images at once; the rest were left out`, 'error');
    renderFiles();
    // A different image must not show the last one's result while its own is on the way.
    if (files[0] !== previous || files.length !== 1) resetLive();
    if (files.length === 1) editor.open(files[0]);
    else editor.close();
    setMode();
  }

  const addFiles = (picked) => {
    const images = [...picked].filter((file) => file.type.startsWith('image/') || /\.(heic|heif|avif)$/i.test(file.name));
    if (images.length < picked.length) setHint('only images can go here; the other files were left out', 'error');
    else setHint('');
    const known = new Set(files.map(fileKey));
    setFiles([...files, ...images.filter((file) => !known.has(fileKey(file)))]);
  };

  form.files.addEventListener('change', () => {
    addFiles(form.files.files);
    form.files.value = ''; // so picking the same files again still fires "change"
  });
  $('[data-clear]', form).addEventListener('click', () => setFiles([]));

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

  // --- One image: the editor -------------------------------------------------------------------

  const editor = createEditor(form, state, {
    onChange: () => schedulePreview(),
    onError: (message) => setHint(message, 'error'),
  });

  // --- One image: the live result ----------------------------------------------------------------

  const live = $('[data-live]', form);
  const viewer = createViewer(live);
  const liveMeta = $('[data-live-meta]', form);
  const download = $('[data-download]', form);
  let kept = null; // { file, promise of the upload id }
  let previewTimer = null;
  let previewAbort = null;
  let resultBlob = null;
  let resultUrl = null;

  const setLive = (text, kind = '') => {
    liveMeta.textContent = text;
    liveMeta.className = `live-meta ${kind}`;
  };

  function resetLive() {
    clearTimeout(previewTimer);
    previewAbort?.abort();
    resultBlob = null;
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = null;
    viewer.reset();
    download.removeAttribute('href');
    setLive('');
  }

  /** The id of the current image on the server, uploading it once (again if it expired). */
  function keptUpload(file, { fresh = false } = {}) {
    if (kept?.file === file && !fresh) return kept.promise;
    if (kept) fetch(`/api/uploads/${kept.id}`, { method: 'DELETE' }).catch(() => {});
    const data = new FormData();
    data.append('file', file);
    const entry = { file, id: null };
    entry.promise = upload('/api/uploads', data, {
      onProgress: (value) => value != null && value < 1 && setLive(`uploading… ${Math.round(value * 100)}%`),
    }).then((res) => (entry.id = res.id));
    kept = entry;
    return entry.promise;
  }

  /** Re-renders the result shortly after the last change, dropping any older render. */
  function schedulePreview() {
    if (files.length !== 1 || !editor.ready) return;
    clearTimeout(previewTimer);
    live.classList.add('updating');
    if (!resultBlob) setLive('rendering…');
    previewTimer = setTimeout(renderPreview, PREVIEW_DELAY_MS);
  }

  async function renderPreview() {
    const file = files[0];
    previewAbort?.abort();
    const abort = (previewAbort = new AbortController());
    const options = { format: state.format, quality: state.quality, metadata: state.metadata, ...editor.edits() };
    // The original, framed as this request (cropped, rotated, flipped), for the comparison.
    const frame = editor.frame();

    const request = async (fresh) => {
      const id = await keptUpload(file, { fresh });
      return fetch('/api/tools/image/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upload: id, ...options }),
        signal: abort.signal,
      });
    };

    try {
      setLive('rendering…');
      let res = await request(false);
      // The server forgets uploads after a while: send it again once.
      if (res.status === 404) res = await request(true);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);

      const meta = JSON.parse(decodeURIComponent(res.headers.get('X-Result')));
      resultBlob = await res.blob();
      if (abort.signal.aborted) return;

      if (resultUrl) URL.revokeObjectURL(resultUrl);
      resultUrl = URL.createObjectURL(resultBlob);
      viewer.show(resultUrl, meta, (ctx, width, height) =>
        ctx.drawImage(frame.canvas, frame.x, frame.y, frame.w, frame.h, 0, 0, width, height),
      );
      download.href = resultUrl;
      download.download = meta.name;
      setLive(
        `${meta.format} · ${meta.width} × ${meta.height} · ${formatBytes(meta.size)} (${sizeChange(file.size, meta.size)})`,
        meta.size > file.size ? 'warn' : 'ok',
      );
    } catch (err) {
      if (err.name !== 'AbortError') setLive(err.message, 'error');
    } finally {
      if (previewAbort === abort) live.classList.remove('updating');
    }
  }

  // Browsers can only put PNG images on the clipboard: other formats are converted on the way.
  $('[data-copy]', form).addEventListener('click', async () => {
    if (!resultBlob) return;
    const button = $('[data-copy]', form);
    try {
      let png = resultBlob;
      if (png.type !== 'image/png') {
        const bitmap = await createImageBitmap(resultBlob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      button.textContent = resultBlob.type === 'image/png' ? 'copied ✓' : 'copied as PNG ✓';
    } catch {
      button.textContent = "couldn't copy";
    }
    setTimeout(() => (button.textContent = 'copy'), 1800);
  });

  // --- Several images: convert as a batch ------------------------------------------------------

  /** One row per image: size before → after, with its own download, or why it failed. */
  function showResults(job, sent) {
    const outputs = job.outputs ?? [];
    const rows = (job.results ?? []).map((item, i) => {
      if (item.error) return { name: item.name, error: item.error };
      const index = outputs.findIndex((output) => output.name === item.output);
      const href = `/api/jobs/${job.id}/outputs/${index}`;
      const before = sent[i]?.size;
      return {
        name: item.output,
        href,
        preview: href,
        detail: [
          `${item.width}×${item.height}`,
          before ? `${formatBytes(before)} → ${formatBytes(item.size)} (${sizeChange(before, item.size)})` : formatBytes(item.size),
        ].join(' · '),
      };
    });
    result.showFiles(rows);

    const converted = (job.results ?? []).filter((item) => !item.error);
    const before = sent.reduce((sum, file, i) => sum + (job.results?.[i]?.error ? 0 : file.size), 0);
    const after = converted.reduce((sum, item) => sum + item.size, 0);
    const failed = rows.length - converted.length;
    result.setStatus(
      [
        `done · ${converted.length} image${converted.length === 1 ? '' : 's'}`,
        `${formatBytes(before)} → ${formatBytes(after)} (${sizeChange(before, after)})`,
        failed ? `${failed} failed` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      failed ? 'error' : 'ok',
    );
    if (outputs.length > 1) result.setDownloadLabel('download all (.zip)');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    // One image needs no button: its result is already there, ready to download.
    if (result.busy || files.length < 2) return;

    const sent = [...files];
    const { format, maxSize, metadata, quality } = state;
    const data = new FormData();
    for (const [key, value] of Object.entries({ tool: 'image', format, maxSize, metadata, quality })) data.append(key, value);
    for (const file of sent) data.append('file', file);

    const go = $('.go', form);
    go.disabled = true;
    await result.run((signal) => upload('/api/jobs', data, { signal, onProgress: result.uploadProgress }), {
      onDone: (job, href) => {
        showResults(job, sent);
        if ((job.outputs ?? []).length === 1) triggerDownload(href);
      },
    });
    go.disabled = false;
  });

  setMode();
}

/**
 * The single-image editor: a canvas preview of the picture rotated and flipped (exactly what
 * the server crops) with a draggable crop box, and the output size.
 */
function createEditor(form, state, { onChange, onError }) {
  const canvas = $('[data-canvas]', form);
  const box = $('[data-box]', form);
  let bitmap = null;
  // Rotation (clockwise degrees) and flips, applied in the same order as the server.
  let transform = { rotate: 0, flipH: false, flipV: false };
  let crop = null; // in pixels of the transformed image (the canvas)
  let scale = 1; // output size = crop size × scale

  const ratio = () => (RATIOS[state.aspect] === 'image' ? canvas.width / canvas.height : RATIOS[state.aspect]);
  const cssScale = () => canvas.clientWidth / canvas.width || 1;

  function draw() {
    const turned = transform.rotate % 180 !== 0;
    canvas.width = turned ? bitmap.height : bitmap.width;
    canvas.height = turned ? bitmap.width : bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(transform.flipH ? -1 : 1, transform.flipV ? -1 : 1);
    ctx.rotate((transform.rotate * Math.PI) / 180);
    ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    ctx.restore();
  }

  const isWhole = (area) => area.x === 0 && area.y === 0 && area.w === canvas.width && area.h === canvas.height;

  const outputSize = () => {
    const { w, h } = roundRect(crop, canvas.width, canvas.height);
    const s = Math.min(scale, MAX_SIDE / w, MAX_SIDE / h);
    return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
  };

  function renderSize() {
    const { width, height } = outputSize();
    if (document.activeElement !== form.outWidth) form.outWidth.value = width;
    if (document.activeElement !== form.outHeight) form.outHeight.value = height;
    for (const btn of $$('[data-scale]', form)) btn.setAttribute('aria-pressed', String(Number(btn.dataset.scale) === scale));
  }

  function renderBox() {
    if (!crop) return;
    const s = cssScale();
    Object.assign(box.style, { left: `${crop.x * s}px`, top: `${crop.y * s}px`, width: `${crop.w * s}px`, height: `${crop.h * s}px` });
    const area = roundRect(crop, canvas.width, canvas.height);
    $('[data-crop-info]', form).textContent = isWhole(area)
      ? `whole image · ${area.w} × ${area.h} px`
      : `crop · ${area.w} × ${area.h} px of ${canvas.width} × ${canvas.height}`;
    renderSize();
  }
  new ResizeObserver(renderBox).observe(canvas);

  function resetCrop() {
    crop = fitAspect(canvas.width, canvas.height, ratio());
    renderBox();
    onChange();
  }

  // Typing one side scales the other with it.
  for (const [input, side] of [
    [form.outWidth, 'w'],
    [form.outHeight, 'h'],
  ]) {
    input.addEventListener('input', () => {
      const value = Number(input.value);
      if (!crop || !(value > 0)) return;
      scale = value / roundRect(crop, canvas.width, canvas.height)[side];
      renderSize();
      onChange();
    });
    input.addEventListener('change', renderSize);
  }
  for (const btn of $$('[data-scale]', form)) {
    btn.addEventListener('click', () => {
      scale = Number(btn.dataset.scale);
      renderSize();
      onChange();
    });
  }

  // Dragging: inside the box moves it, the corners resize it. The preview updates on release.
  let drag = null;
  const toImage = (e) => {
    const rect = canvas.getBoundingClientRect();
    const s = cssScale();
    return { x: (e.clientX - rect.left) / s, y: (e.clientY - rect.top) / s };
  };
  box.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    drag = { corner: e.target.dataset.corner ?? null, start: toImage(e), rect: { ...crop } };
    box.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const point = toImage(e);
    crop = drag.corner
      ? resizeRect(drag.rect, drag.corner, point.x, point.y, { W: canvas.width, H: canvas.height, ratio: ratio(), min: MIN_BOX_CSS_PX / cssScale() })
      : moveRect(drag.rect, point.x - drag.start.x, point.y - drag.start.y, canvas.width, canvas.height);
    renderBox();
  });
  const stopDrag = () => {
    if (drag) onChange();
    drag = null;
  };
  box.addEventListener('pointerup', stopDrag);
  box.addEventListener('pointercancel', stopDrag);

  const actions = {
    'rotate-left': () => (transform.rotate = (transform.rotate + 270) % 360),
    'rotate-right': () => (transform.rotate = (transform.rotate + 90) % 360),
    'flip-h': () => (transform.flipH = !transform.flipH),
    'flip-v': () => (transform.flipV = !transform.flipV),
    reset: () => {
      transform = { rotate: 0, flipH: false, flipV: false };
      scale = 1;
    },
  };
  for (const btn of $$('[data-action]', form)) {
    btn.addEventListener('click', () => {
      if (!bitmap) return;
      actions[btn.dataset.action]();
      draw();
      resetCrop();
    });
  }

  let opening = null;

  return {
    get ready() {
      return Boolean(bitmap);
    },
    resetCrop,

    async open(file) {
      opening = file;
      let opened;
      try {
        // Browsers apply the photo's EXIF orientation here, as the server does.
        opened = await createImageBitmap(file);
      } catch {
        if (opening === file) onError("This browser can't open that image; try a JPEG, PNG, WebP or AVIF.");
        return;
      }
      if (opening !== file) return opened.close(); // another image was picked meanwhile
      bitmap?.close();
      bitmap = opened;
      transform = { rotate: 0, flipH: false, flipV: false };
      scale = 1;
      draw();
      $('[data-editor]', form).hidden = false;
      resetCrop();
    },

    close() {
      opening = null;
      bitmap?.close();
      bitmap = null;
      crop = null;
    },

    /** The picture as the editor shows it (rotated, flipped) and the crop in it, in whole pixels. */
    frame() {
      return { canvas, ...roundRect(crop, canvas.width, canvas.height) };
    },

    /** The edits for the server; crop and size only when they change something. */
    edits() {
      const area = roundRect(crop, canvas.width, canvas.height);
      const { width, height } = outputSize();
      const resized = width !== area.w || height !== area.h;
      return {
        rotate: transform.rotate,
        flipH: transform.flipH ? '1' : '0',
        flipV: transform.flipV ? '1' : '0',
        ...(isWhole(area) ? {} : { cropX: area.x, cropY: area.y, cropWidth: area.w, cropHeight: area.h }),
        ...(resized ? { width, height } : {}),
      };
    },
  };
}
