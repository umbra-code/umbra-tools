// Edit image UI: a canvas preview with a crop box, rotate and flip buttons, and the output size.
import { $, $$, bindOptions, loadSettings, saveSettings } from '../dom.js';
import { upload } from '../api.js';
import { createResult, triggerDownload } from '../result.js';
import { fitAspect, moveRect, resizeRect, roundRect } from '../crop.js';

const DEFAULTS = { aspect: 'free', format: 'original' };
const RATIOS = { free: null, original: 'image', '1:1': 1, '4:5': 4 / 5, '16:9': 16 / 9, '9:16': 9 / 16, '3:2': 3 / 2 };
const MAX_SIDE = 16384;
// The crop box never gets smaller than this on screen, so it stays easy to grab.
const MIN_BOX_CSS_PX = 32;

export function init(section) {
  const form = $('form', section);
  const state = loadSettings('edit', DEFAULTS);
  const result = createResult($('.result-slot', section));
  const editor = $('[data-editor]', form);
  const canvas = $('[data-canvas]', form);
  const box = $('[data-box]', form);
  const hint = $('[data-edit-hint]', form);

  let file = null;
  let bitmap = null;
  // Rotation (clockwise degrees) and flips, applied in the same order as the server.
  let transform = { rotate: 0, flipH: false, flipV: false };
  let crop = null; // in pixels of the transformed image (the canvas)
  let scale = 1; // output size = crop size × scale

  const ratio = () => (RATIOS[state.aspect] === 'image' ? canvas.width / canvas.height : RATIOS[state.aspect]);
  const cssScale = () => canvas.clientWidth / canvas.width || 1;

  const setHint = (text, kind = '') => {
    hint.textContent = text;
    hint.className = `hint ${kind}`;
    hint.hidden = !text;
  };

  // --- Preview -------------------------------------------------------------------------

  /** Draws the picture rotated and flipped: the canvas is what the server will crop. */
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

  function renderBox() {
    if (!crop) return;
    const s = cssScale();
    Object.assign(box.style, {
      left: `${crop.x * s}px`,
      top: `${crop.y * s}px`,
      width: `${crop.w * s}px`,
      height: `${crop.h * s}px`,
    });
    const { w, h } = roundRect(crop, canvas.width, canvas.height);
    $('[data-crop-info]', form).textContent =
      w === canvas.width && h === canvas.height ? `whole image · ${w} × ${h} px` : `crop · ${w} × ${h} px of ${canvas.width} × ${canvas.height}`;
    renderSize();
  }
  new ResizeObserver(renderBox).observe(canvas);

  const resetCrop = () => {
    crop = fitAspect(canvas.width, canvas.height, ratio());
    renderBox();
  };

  // --- Output size ----------------------------------------------------------------------

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
    });
    input.addEventListener('change', renderSize);
  }
  for (const btn of $$('[data-scale]', form)) {
    btn.addEventListener('click', () => {
      scale = Number(btn.dataset.scale);
      renderSize();
    });
  }

  // --- Crop box dragging ----------------------------------------------------------------

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
      ? resizeRect(drag.rect, drag.corner, point.x, point.y, {
          W: canvas.width,
          H: canvas.height,
          ratio: ratio(),
          min: MIN_BOX_CSS_PX / cssScale(),
        })
      : moveRect(drag.rect, point.x - drag.start.x, point.y - drag.start.y, canvas.width, canvas.height);
    renderBox();
  });
  const stopDrag = () => {
    drag = null;
  };
  box.addEventListener('pointerup', stopDrag);
  box.addEventListener('pointercancel', stopDrag);

  // --- Rotate and flip ------------------------------------------------------------------

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

  // Only a new aspect ratio moves the crop box; other options (like the format) leave it alone.
  let aspect = state.aspect;
  bindOptions(form, state, () => {
    saveSettings('edit', state);
    if (state.aspect === aspect) return;
    aspect = state.aspect;
    if (bitmap) resetCrop();
  });

  // --- Picking the image ------------------------------------------------------------------

  async function open(picked) {
    if (!picked) return;
    let opened;
    try {
      // Browsers apply the photo's EXIF orientation here, as the server does.
      opened = await createImageBitmap(picked);
    } catch {
      setHint("This browser can't open that image; try a JPEG, PNG, WebP or AVIF.", 'error');
      return;
    }
    bitmap?.close();
    bitmap = opened;
    file = picked;
    transform = { rotate: 0, flipH: false, flipV: false };
    scale = 1;
    $('[data-file-label]', form).textContent = `${file.name} · change`;
    setHint('');
    editor.hidden = false;
    draw();
    resetCrop();
  }

  const dropzone = $('[data-dropzone]', form);
  form.file.addEventListener('change', () => {
    open(form.file.files[0]);
    form.file.value = '';
  });
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('over');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('over');
    open(e.dataTransfer.files[0]);
  });

  // --- Saving ---------------------------------------------------------------------------

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (result.busy || !file || !crop) return;

    const area = roundRect(crop, canvas.width, canvas.height);
    const { width, height } = outputSize();
    const fields = {
      tool: 'edit',
      rotate: transform.rotate,
      flipH: transform.flipH ? '1' : '0',
      flipV: transform.flipV ? '1' : '0',
      cropX: area.x,
      cropY: area.y,
      cropWidth: area.w,
      cropHeight: area.h,
      width,
      height,
      format: state.format,
    };
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.append(key, String(value));
    data.append('file', file);

    const go = $('.go', form);
    go.disabled = true;
    await result.run((signal) => upload('/api/jobs', data, { signal, onProgress: result.uploadProgress }), {
      onDone: (job, href) => {
        result.showImage(href);
        triggerDownload(href);
      },
    });
    go.disabled = false;
  });
}
