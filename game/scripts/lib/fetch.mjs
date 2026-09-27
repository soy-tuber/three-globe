// Cached HTTP fetching for the asset pipeline. Everything lands in .cache/
// so re-running the pipeline is offline and fast.
import fs from 'node:fs';
import path from 'node:path';

export const CACHE_DIR = path.resolve(import.meta.dirname, '../../.cache');

export async function fetchCached(url, relPath, { retries = 4 } = {}) {
  const file = path.join(CACHE_DIR, relPath);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(file + '.part', buf);
      fs.renameSync(file + '.part', file);
      return file;
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

/** Run async jobs with bounded concurrency. */
export async function pool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const NE_BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

export async function naturalEarth(name) {
  const file = await fetchCached(`${NE_BASE}/${name}.geojson`, `ne/${name}.geojson`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
