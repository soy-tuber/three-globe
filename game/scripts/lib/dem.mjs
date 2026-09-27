// Digital elevation model sources, resampled onto an equirectangular grid.
//
//  - gebco:     GEBCO global grid GeoTIFF tiles (https://www.gebco.net/data-and-products/gridded-bathymetry-data)
//               Download "GEBCO_20xx Grid – GeoTIFF" and pass the unzipped directory via --gebco <dir>.
//  - terrarium: AWS Open Data "Terrain Tiles" (Mapzen Terrarium encoding). Land from SRTM/GMTED,
//               bathymetry from ETOPO1. Used automatically when no GEBCO directory is given.
//
// All sources return a Float32Array of metres (row-major, north-up), pixel-centre registered:
//   lng = west + (x + 0.5) / width * (east - west)
//   lat = north - (y + 0.5) / height * (north - south)

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { fetchCached, pool } from './fetch.mjs';

sharp.cache(false);

export function gridCoords(grid) {
  const { west, east, south, north, width, height } = grid;
  const lngs = new Float64Array(width);
  const lats = new Float64Array(height);
  for (let x = 0; x < width; x++) lngs[x] = west + ((x + 0.5) / width) * (east - west);
  for (let y = 0; y < height; y++) lats[y] = north - ((y + 0.5) / height) * (north - south);
  return { lngs, lats };
}

// ---------------------------------------------------------------- Terrarium

const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const MAX_MERC_LAT = 85.05112878;

const mercX = (lng, z) => ((lng + 180) / 360) * 256 * 2 ** z;
const mercY = (lat, z) => {
  const phi = (Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * 256 * 2 ** z;
};

export async function terrariumDem(grid, zoom, log = () => {}) {
  const n = 2 ** zoom;
  const x0 = Math.max(0, Math.floor(mercX(grid.west, zoom) / 256));
  const x1 = Math.min(n - 1, Math.floor((mercX(grid.east, zoom) - 1e-6) / 256));
  const y0 = Math.max(0, Math.floor(mercY(grid.north, zoom) / 256));
  const y1 = Math.min(n - 1, Math.floor((mercY(grid.south, zoom) - 1e-6) / 256));
  const tw = x1 - x0 + 1;
  const th = y1 - y0 + 1;

  // Mosaic of all tiles, decoded to metres.
  const mw = tw * 256;
  const mh = th * 256;
  const mosaic = new Float32Array(mw * mh);
  const jobs = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) jobs.push([tx, ty]);
  log(`terrarium z${zoom}: ${jobs.length} tiles`);

  let done = 0;
  await pool(jobs, 16, async ([tx, ty]) => {
    const file = await fetchCached(`${TERRARIUM_URL}/${zoom}/${tx}/${ty}.png`, `terrarium/${zoom}/${tx}/${ty}.png`);
    const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const ox = (tx - x0) * 256;
    const oy = (ty - y0) * 256;
    for (let py = 0; py < 256; py++) {
      for (let px = 0; px < 256; px++) {
        const i = (py * 256 + px) * info.channels;
        mosaic[(oy + py) * mw + ox + px] = data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
      }
    }
    if (++done % 64 === 0) log(`  ${done}/${jobs.length}`);
  });

  // Resample Web-Mercator mosaic → equirectangular grid (bilinear).
  const { lngs, lats } = gridCoords(grid);
  const out = new Float32Array(grid.width * grid.height);
  const sample = (X, Y) => {
    const fx = Math.max(0, Math.min(mw - 1.001, X - x0 * 256 - 0.5));
    const fy = Math.max(0, Math.min(mh - 1.001, Y - y0 * 256 - 0.5));
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const ax = fx - ix, ay = fy - iy;
    const i = iy * mw + ix;
    return (
      mosaic[i] * (1 - ax) * (1 - ay) +
      mosaic[i + 1] * ax * (1 - ay) +
      mosaic[i + mw] * (1 - ax) * ay +
      mosaic[i + mw + 1] * ax * ay
    );
  };
  const xs = Array.from(lngs, lng => mercX(lng, zoom));
  for (let y = 0; y < grid.height; y++) {
    const Y = mercY(lats[y], zoom);
    for (let x = 0; x < grid.width; x++) out[y * grid.width + x] = sample(xs[x], Y);
  }
  return out;
}

// ---------------------------------------------------------------- GEBCO

// GEBCO GeoTIFF tiles are named like
//   gebco_2024_n90.0_s0.0_w-180.0_e-90.0.tif
// Each covers 90°×90° at 15 arc-seconds (21600×21600, int16 metres). They are read with `geotiff`
// (sharp would push them through an sRGB pipeline and clip the negative bathymetry).
const GEBCO_NAME = /n(-?\d+(?:\.\d+)?)_s(-?\d+(?:\.\d+)?)_w(-?\d+(?:\.\d+)?)_e(-?\d+(?:\.\d+)?)\.tiff?$/i;

export function listGebcoTiles(dir) {
  return fs
    .readdirSync(dir)
    .map(f => {
      const m = f.match(GEBCO_NAME);
      if (!m) return null;
      const [north, south, west, east] = m.slice(1).map(Number);
      return { file: path.join(dir, f), north, south, west, east };
    })
    .filter(Boolean);
}

export async function gebcoDem(grid, dir, log = () => {}) {
  const { fromFile } = await import('geotiff');
  const candidates = listGebcoTiles(dir);
  if (!candidates.length) throw new Error(`No GEBCO GeoTIFF tiles (gebco_*_n.._s.._w.._e...tif) found in ${dir}`);

  const { lngs, lats } = gridCoords(grid);
  const out = new Float32Array(grid.width * grid.height).fill(NaN);
  const degPerPxOut = (grid.east - grid.west) / grid.width;

  for (const t of candidates) {
    const tiff = await fromFile(t.file);
    const image = await tiff.getImage();
    // Prefer the georeferenced bounds; fall back to those in the file name.
    try {
      const [w0, s0, e0, n0] = image.getBoundingBox();
      Object.assign(t, { west: w0, south: s0, east: e0, north: n0 });
    } catch {
      /* no geokeys — keep filename bounds */
    }
    if (!(t.east > grid.west && t.west < grid.east && t.north > grid.south && t.south < grid.north)) continue;

    const W = image.getWidth(), H = image.getHeight();
    const tileDegW = t.east - t.west, tileDegH = t.north - t.south;
    // Read at ~2× the output resolution, in horizontal bands so a 21600² tile never sits in memory whole.
    const w = Math.min(W, Math.ceil((tileDegW / degPerPxOut) * 2));
    const h = Math.min(H, Math.ceil((tileDegH / degPerPxOut) * 2));
    log(`gebco ${path.basename(t.file)} ${W}×${H} → ${w}×${h}`);
    const px = new Float32Array(w * h);
    const bands = Math.max(1, Math.ceil(H / 2700));
    let row = 0;
    for (let b = 0; b < bands; b++) {
      const y0 = Math.floor((b * H) / bands), y1 = Math.floor(((b + 1) * H) / bands);
      const rows = b === bands - 1 ? h - row : Math.round(((y1 - y0) / H) * h);
      if (rows <= 0) continue;
      const [band] = await image.readRasters({
        window: [0, y0, W, y1],
        width: w,
        height: rows,
        resampleMethod: 'bilinear',
        interleave: false,
      });
      px.set(band, row * w);
      row += rows;
    }

    for (let y = 0; y < grid.height; y++) {
      const lat = lats[y];
      if (lat > t.north || lat < t.south) continue;
      const fy = Math.max(0, Math.min(h - 1.001, ((t.north - lat) / tileDegH) * h - 0.5));
      const iy = Math.floor(fy), ay = fy - iy;
      for (let x = 0; x < grid.width; x++) {
        const lng = lngs[x];
        if (lng < t.west || lng > t.east) continue;
        const fx = Math.max(0, Math.min(w - 1.001, ((lng - t.west) / tileDegW) * w - 0.5));
        const ix = Math.floor(fx), ax = fx - ix;
        const i = iy * w + ix;
        out[y * grid.width + x] =
          px[i] * (1 - ax) * (1 - ay) + px[i + 1] * ax * (1 - ay) + px[i + w] * (1 - ax) * ay + px[i + w + 1] * ax * ay;
      }
    }
  }
  let missing = 0;
  for (let i = 0; i < out.length; i++) if (Number.isNaN(out[i])) (out[i] = 0), missing++;
  if (missing === out.length) throw new Error(`GEBCO tiles in ${dir} do not cover the region`);
  if (missing) log(`gebco: ${missing} pixels outside the supplied tiles were set to 0`);
  return out;
}

// ---------------------------------------------------------------- Encoding

/**
 * Height grid binary (".hgt.bin", served gzip-compressed as ".hgt.gz"):
 *   Int16 metres, row-major north-up, horizontally delta-coded per row for compressibility.
 */
export function encodeHeights(heights, width, height) {
  const out = new Int16Array(width * height);
  for (let y = 0; y < height; y++) {
    let prev = 0;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const v = Math.max(-11000, Math.min(9000, Math.round(heights[i])));
      out[i] = v - prev;
      prev = v;
    }
  }
  return Buffer.from(out.buffer);
}

/** Small separable box blur (in-place result returned), used to soften DEM speckle. */
export function blur(src, width, height, radius, wrapX = false) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const k = radius * 2 + 1;
  const col = wrapX ? x => (x + width) % width : x => Math.max(0, Math.min(width - 1, x));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0;
      for (let d = -radius; d <= radius; d++) s += src[y * width + col(x + d)];
      tmp[y * width + x] = s / k;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0;
      for (let d = -radius; d <= radius; d++) s += tmp[Math.max(0, Math.min(height - 1, y + d)) * width + x];
      out[y * width + x] = s / k;
    }
  }
  return out;
}
