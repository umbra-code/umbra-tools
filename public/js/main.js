// Tool menu: each entry of the sidebar shows one tool; the choice is kept in the URL hash (#gif).
import { $, $$ } from './dom.js';
import * as downloader from './tools/downloader.js';
import * as gif from './tools/gif.js';
import * as video from './tools/video.js';
import * as audio from './tools/audio.js';
import * as image from './tools/image.js';
import * as pdf from './tools/pdf.js';
import * as metadata from './tools/metadata.js';

const tools = { downloader, gif, video, audio, image, pdf, metadata };
const DEFAULT_TOOL = 'downloader';

for (const [id, tool] of Object.entries(tools)) tool.init($(`#tool-${id}`));

function select(id) {
  if (!tools[id]) id = DEFAULT_TOOL;
  for (const tab of $$('[data-tool]')) tab.setAttribute('aria-selected', String(tab.dataset.tool === id));
  for (const other of Object.keys(tools)) $(`#tool-${other}`).hidden = other !== id;
  const name = $(`#tool-${id} .tool-head h1`)?.textContent;
  document.title = name ? `${name} · umbra tools` : 'umbra tools';
}

for (const tab of $$('[data-tool]')) {
  tab.addEventListener('click', () => {
    history.replaceState(null, '', `#${tab.dataset.tool}`);
    select(tab.dataset.tool);
    window.scrollTo({ top: 0 });
  });
}

// The logo links to #downloader; back/forward and typed hashes work too.
window.addEventListener('hashchange', () => select(location.hash.slice(1)));

select(location.hash.slice(1));
