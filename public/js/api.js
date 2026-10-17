// Talking to the server: JSON requests, uploads with progress, and polling jobs.

export async function api(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(path, {
    method,
    signal,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

/** Posts a multipart form; fetch cannot report upload progress, XMLHttpRequest can. */
export function upload(path, formData, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => onProgress?.(e.lengthComputable ? e.loaded / e.total : null);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else reject(new Error(xhr.response?.error || `Error ${xhr.status}`));
    };
    xhr.onerror = () => reject(new TypeError('upload failed: the server is unreachable'));
    xhr.onabort = () => reject(new DOMException('cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(formData);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls a job until it finishes, calling `onUpdate` with each state.
 * Resolves with the finished job; rejects on error, cancellation or a lost server.
 */
export async function pollJob(id, { onUpdate, onOffline, signal }) {
  let networkErrors = 0;
  while (!signal.aborted) {
    let job;
    try {
      job = await api(`/api/jobs/${id}`, { signal });
      networkErrors = 0;
    } catch (err) {
      // fetch throws TypeError when the server is unreachable; tolerate brief outages.
      if (!(err instanceof TypeError)) throw err;
      if (++networkErrors > 10) {
        throw new Error('lost connection to the server; is it still running?', { cause: err });
      }
      onOffline?.();
      await sleep(1500);
      continue;
    }
    if (job.status === 'done') return job;
    if (job.status === 'error') throw new Error(job.error);
    if (job.status === 'cancelled') break;
    onUpdate(job);
    await sleep(600);
  }
  throw new DOMException('cancelled', 'AbortError');
}
