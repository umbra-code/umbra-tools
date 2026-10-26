// Decodes one HEIC picture to RGBA pixels. Runs in a worker thread: libheif's WebAssembly
// decoder blocks while it works (about a second for a 12 MP photo), which would stall the server.
import { parentPort, workerData } from 'node:worker_threads';
import decode from 'heic-decode';

const { width, height, data } = await decode({ buffer: workerData });
parentPort.postMessage({ width, height, data }, [data.buffer]);
