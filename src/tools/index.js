// Every tool, by id. A tool is `{ id, accepts, parseOptions(body), run(ctx) }`; see src/core/jobs.js.
import downloader from './downloader/index.js';
import gif from './gif/index.js';

export const tools = Object.fromEntries([downloader, gif].map((tool) => [tool.id, tool]));
