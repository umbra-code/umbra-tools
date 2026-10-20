// Tool menu: each tab shows one tool; the choice is kept in the URL hash (#gif).
import { $, $$ } from './dom.js';
import * as downloader from './tools/downloader.js';
import * as gif from './tools/gif.js';
import * as video from './tools/video.js';
import * as audio from './tools/audio.js';
import * as image from './tools/image.js';
import * as pdf from './tools/pdf.js';

const tools = { downloader, gif, video, audio, image, pdf };
const DEFAULT_TOOL = 'downloader';

for (const [id, tool] of Object.entries(tools)) tool.init($(`#tool-${id}`));

function select(id) {
  if (!tools[id]) id = DEFAULT_TOOL;
  for (const tab of $$('[data-tool]')) tab.setAttribute('aria-selected', String(tab.dataset.tool === id));
  for (const other of Object.keys(tools)) $(`#tool-${other}`).hidden = other !== id;
}

for (const tab of $$('[data-tool]')) {
  tab.addEventListener('click', () => {
    history.replaceState(null, '', `#${tab.dataset.tool}`);
    select(tab.dataset.tool);
  });
}

select(location.hash.slice(1));
