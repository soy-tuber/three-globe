// Loads the terrain assets produced by scripts/build-assets.mjs and provides a CPU-side
// height sampler that mirrors what the GPU displaces, so objects sit on the ground.
import * as THREE from 'three';

export interface RegionManifest {
  id: string;
  bbox: [number, number, number, number];
  albedo: { url: string; width: number; height: number };
  height: { url: string; width: number; height: number };
  mask: { url: string; width: number; height: number };
  demSource: string;
}

export interface TerrainManifest {
  attribution: string[];
  regions: RegionManifest[];
}

export interface TerrainRegion {
  meta: RegionManifest;
  /** metres, row-major, north-up */
  heights: Int16Array;
  heightTex: THREE.DataTexture;
  albedoTex: THREE.Texture;
  maskTex: THREE.Texture;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  // Servers may or may not have transparently decoded the gzip stream already.
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return buf;
}

async function loadHeights(url: string, width: number, height: number): Promise<Int16Array> {
  const bytes = await fetchBytes(url);
  const deltas = new Int16Array(bytes.buffer, bytes.byteOffset, width * height);
  const out = new Int16Array(width * height);
  for (let y = 0; y < height; y++) {
    let v = 0;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      v += deltas[row + x];
      out[row + x] = v;
    }
  }
  return out;
}

function heightTexture(heights: Int16Array, width: number, height: number): THREE.DataTexture {
  // Half-float R16F: linearly filterable on every WebGL2 device. Rows are flipped so north is at v = 1,
  // matching image textures (flipY) and the globe's UVs.
  const data = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    const src = y * width;
    const dst = (height - 1 - y) * width;
    for (let x = 0; x < width; x++) data[dst + x] = THREE.DataUtils.toHalfFloat(heights[src + x]);
  }
  const tex = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function loadTexture(url: string, color: boolean, maxAnisotropy: number): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(
      url,
      tex => {
        tex.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.anisotropy = maxAnisotropy;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        resolve(tex);
      },
      undefined,
      reject,
    );
  });
}

export async function loadTerrain(
  baseUrl: string,
  maxAnisotropy: number,
  onProgress: (label: string, done: number, total: number) => void,
): Promise<{ manifest: TerrainManifest; regions: TerrainRegion[] }> {
  const manifest: TerrainManifest = await (await fetch(`${baseUrl}assets/terrain/manifest.json`)).json();
  const total = manifest.regions.length * 3;
  let done = 0;
  const tick = (label: string) => onProgress(label, ++done, total);

  const regions = await Promise.all(
    manifest.regions.map(async meta => {
      const [heights, albedoTex, maskTex] = await Promise.all([
        loadHeights(baseUrl + meta.height.url, meta.height.width, meta.height.height).then(h => {
          tick(`${meta.id}: 標高データ`);
          return h;
        }),
        loadTexture(baseUrl + meta.albedo.url, true, maxAnisotropy).then(t => {
          tick(`${meta.id}: 地表テクスチャ`);
          return t;
        }),
        loadTexture(baseUrl + meta.mask.url, false, 1).then(t => {
          tick(`${meta.id}: 海陸マスク`);
          return t;
        }),
      ]);
      return {
        meta,
        heights,
        heightTex: heightTexture(heights, meta.height.width, meta.height.height),
        albedoTex,
        maskTex,
      } satisfies TerrainRegion;
    }),
  );
  return { manifest, regions };
}

/** Bilinear height (metres) from a region, or null if outside it. */
export function sampleRegion(r: TerrainRegion, lat: number, lng: number): number | null {
  const [w, s, e, n] = r.meta.bbox;
  if (lng < w || lng > e || lat < s || lat > n) return null;
  const W = r.meta.height.width, H = r.meta.height.height;
  const fx = Math.max(0, Math.min(W - 1.001, ((lng - w) / (e - w)) * W - 0.5));
  const fy = Math.max(0, Math.min(H - 1.001, ((n - lat) / (n - s)) * H - 0.5));
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const ax = fx - ix, ay = fy - iy;
  const i = iy * W + ix;
  const h = r.heights;
  return h[i] * (1 - ax) * (1 - ay) + h[i + 1] * ax * (1 - ay) + h[i + W] * (1 - ax) * ay + h[i + W + 1] * ax * ay;
}
