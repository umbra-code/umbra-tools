// Every tool, by id. A tool is `{ id, accepts, parseOptions(body), run(ctx) }`; see src/core/jobs.js.
import audio from './audio/index.js';
import downloader from './downloader/index.js';
import gif from './gif/index.js';
import image from './image/index.js';
import pdf from './pdf/index.js';
import video from './video/index.js';

export const tools = Object.fromEntries([downloader, gif, video, audio, image, pdf].map((tool) => [tool.id, tool]));
