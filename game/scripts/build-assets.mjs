#!/usr/bin/env node
// Asset pipeline: builds the globe's terrain textures and the road graph.
//
//   npm run assets                       # DEM from AWS Terrain Tiles (auto-download)
//   npm run assets -- --gebco ~/gebco    # DEM from GEBCO GeoTIFF tiles in ~/gebco
//   npm run assets -- --only japan       # rebuild one region
//
// Outputs (public/assets/):
//   terrain/manifest.json
//   terrain/<region>/albedo.webp   Natural Earth vectors (land, lakes, rivers, glaciers, urban
//                                  areas, roads, borders) over a hypsometric/bathymetric tint.
//   terrain/<region>/height.hgt    gzip(Int16 metres, per-row delta coded)
//   terrain/<region>/mask.png      R = land, G = night lights (urban areas), B = inland water
//   data/roads-japan.json          routable road graph (Natural Earth 10m roads)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { naturalEarth } from './lib/fetch.mjs';
import { terrariumDem, gebcoDem, encodeHeights, blur } from './lib/dem.mjs';
import { makeCanvas, fillPolygons, strokeLines, strokePolygonOutlines, readMask } from './lib/raster.mjs';
import { buildRoadGraph } from './lib/roads.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public/assets');
const BLUE_MARBLE = path.resolve(ROOT, '../example/img/earth-blue-marble.jpg');

const args = process.argv.slice(2);
const argVal = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const GEBCO_DIR = argVal('--gebco');
const ONLY = argVal('--only');

const log = (...m) => console.log(`[assets ${new Date().toISOString().slice(11, 19)}]`, ...m);

// Regions: a global base layer plus a high-resolution patch over Japan.
const REGIONS = [
  {
    id: 'world',
    bbox: [-180, -90, 180, 90],
    albedo: [8192, 4096],
    height: [4096, 2048],
    terrariumZoom: 4,
    roadDetail: 'world',
  },
  {
    id: 'japan',
    bbox: [122, 24, 154, 46],
    albedo: [4000, 2750], // 0.008°/px (~0.9 km)
    height: [3200, 2200], // 0.01°/px
    terrariumZoom: 8,
    roadDetail: 'regional',
  },
];

const gridOf = (bbox, [width, height]) => ({
  west: bbox[0],
  south: bbox[1],
  east: bbox[2],
  north: bbox[3],
  width,
  height,
});

// ------------------------------------------------------------------ palettes

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = t => Math.max(0, Math.min(1, t));
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function ramp(stops) {
  return v => {
    if (v <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
      if (v <= stops[i][0]) {
        const [v0, c0] = stops[i - 1];
        const [v1, c1] = stops[i];
        const t = (v - v0) / (v1 - v0);
        return [lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)];
      }
    }
    return stops[stops.length - 1][1];
  };
}

// Hypsometric tint (metres above sea level).
const landRamp = ramp([
  [0, [104, 146, 84]],
  [150, [122, 158, 92]],
  [500, [150, 166, 104]],
  [1000, [170, 160, 116]],
  [1800, [158, 136, 108]],
  [2800, [140, 124, 114]],
  [4000, [176, 170, 166]],
  [5500, [236, 238, 242]],
]);

// Bathymetric tint (metres below sea level).
const seaRamp = ramp([
  [0, [96, 196, 206]],
  [40, [64, 164, 198]],
  [180, [40, 126, 182]],
  [700, [30, 94, 160]],
  [2200, [22, 68, 132]],
  [4500, [15, 48, 104]],
  [7500, [9, 30, 74]],
]);

// ------------------------------------------------------------------ build

async function loadVectors() {
  log('loading Natural Earth 10m vectors');
  const names = [
    'ne_10m_land',
    'ne_10m_minor_islands',
    'ne_10m_lakes',
    'ne_10m_rivers_lake_centerlines_scale_rank',
    'ne_10m_glaciated_areas',
    'ne_10m_urban_areas',
    'ne_10m_roads',
    'ne_10m_admin_0_boundary_lines_land',
    'ne_10m_antarctic_ice_shelves_polys',
  ];
  const loaded = await Promise.all(names.map(n => naturalEarth(n)));
  return Object.fromEntries(names.map((n, i) => [n.replace('ne_10m_', ''), loaded[i]]));
}

async function loadDem(region, grid) {
  if (GEBCO_DIR) return { heights: await gebcoDem(grid, GEBCO_DIR, log), source: 'GEBCO' };
  return { heights: await terrariumDem(grid, region.terrariumZoom, log), source: 'AWS Terrain Tiles (Terrarium)' };
}

/** Bilinear upsample of a height grid to another grid size (same bbox). */
function resample(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const fy = Math.max(0, Math.min(sh - 1.001, ((y + 0.5) / dh) * sh - 0.5));
    const iy = Math.floor(fy), ay = fy - iy;
    for (let x = 0; x < dw; x++) {
      const fx = Math.max(0, Math.min(sw - 1.001, ((x + 0.5) / dw) * sw - 0.5));
      const ix = Math.floor(fx), ax = fx - ix;
      const i = iy * sw + ix;
      out[y * dw + x] =
        src[i] * (1 - ax) * (1 - ay) + src[i + 1] * ax * (1 - ay) + src[i + sw] * (1 - ax) * ay + src[i + sw + 1] * ax * ay;
    }
  }
  return out;
}

async function blueMarbleTint(grid) {
  // NASA Blue Marble (public domain, bundled with three-globe) is used only as a low-frequency
  // biome tint so that deserts read as deserts and rainforests as rainforests.
  const meta = await sharp(BLUE_MARBLE).metadata();
  const left = Math.floor(((grid.west + 180) / 360) * meta.width);
  const right = Math.ceil(((grid.east + 180) / 360) * meta.width);
  const top = Math.floor(((90 - grid.north) / 180) * meta.height);
  const bottom = Math.ceil(((90 - grid.south) / 180) * meta.height);
  const { data } = await sharp(BLUE_MARBLE)
    .extract({ left, top, width: right - left, height: bottom - top })
    .blur(1.2)
    .resize(grid.width, grid.height, { kernel: 'cubic', fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

function landMaskCanvas(grid, v) {
  const { ctx } = makeCanvas(grid);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, grid.width, grid.height);
  fillPolygons(ctx, grid, v.land, '#fff');
  fillPolygons(ctx, grid, v.minor_islands, '#fff');
  fillPolygons(ctx, grid, v.lakes, '#000', p => (p.scalerank ?? 0) <= 9);
  return readMask(ctx, grid);
}

function water(ctx, grid, v, scale) {
  const lakeColor = 'rgb(74,150,190)';
  fillPolygons(ctx, grid, v.lakes, lakeColor);
  strokeLines(
    ctx,
    grid,
    v.rivers_lake_centerlines_scale_rank,
    p => {
      const rank = p.scalerank ?? 10;
      if (rank > (scale > 2 ? 10 : 7)) return null;
      return { color: 'rgba(74,150,190,0.9)', width: Math.max(0.6, (2.4 - rank * 0.18) * scale) };
    },
    p => p.featurecla !== 'Lake Centerline',
  );
}

async function buildAlbedo(region, v, dem, demW, demH) {
  const grid = gridOf(region.bbox, region.albedo);
  const scale = region.id === 'world' ? 1 : 2.2; // stroke widths relative to pixel size
  log(`${region.id}: albedo ${grid.width}×${grid.height}`);

  const heights = resample(dem, demW, demH, grid.width, grid.height);
  const land = landMaskCanvas(grid, v);
  const bm = await blueMarbleTint(grid);

  const { ctx } = makeCanvas(grid);
  const img = ctx.createImageData(grid.width, grid.height);
  const px = img.data;
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    const l = land[i];

    // Land: hypsometric tint blended with the Blue Marble biome tint.
    let [r, g, b] = landRamp(Math.max(0, h));
    const br = bm[i * 3], bg = bm[i * 3 + 1], bb = bm[i * 3 + 2];
    const oceanLike = bb > bg * 1.05 && bb > br * 1.25 && br + bg + bb < 260;
    if (!oceanLike) {
      // Brighten & slightly saturate the (dark) Blue Marble colours.
      const luma = 0.3 * br + 0.59 * bg + 0.11 * bb;
      const sat = 1.2, gain = 1.45;
      const tr = Math.min(255, (luma + (br - luma) * sat) * gain);
      const tg = Math.min(255, (luma + (bg - luma) * sat) * gain);
      const tb = Math.min(255, (luma + (bb - luma) * sat) * gain);
      const w = 0.62 * (1 - smoothstep(3500, 5500, h)); // let high peaks stay snowy
      r = lerp(r, tr, w);
      g = lerp(g, tg, w);
      b = lerp(b, tb, w);
    }

    // Sea: bathymetric tint.
    const [sr, sg, sb] = seaRamp(Math.max(0, -h));

    px[i * 4] = lerp(sr, r, l);
    px[i * 4 + 1] = lerp(sg, g, l);
    px[i * 4 + 2] = lerp(sb, b, l);
    px[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  // Vector overlays (Natural Earth).
  strokePolygonOutlines(ctx, grid, v.land, 'rgba(255,248,225,0.28)', 1.0 * scale);
  fillPolygons(ctx, grid, v.glaciated_areas, 'rgba(242,246,250,0.88)');
  fillPolygons(ctx, grid, v.antarctic_ice_shelves_polys, 'rgba(228,238,246,0.92)');
  fillPolygons(ctx, grid, v.urban_areas, region.id === 'world' ? 'rgba(214,196,176,0.5)' : 'rgba(206,196,182,0.5)');
  water(ctx, grid, v, scale);
  strokeLines(
    ctx,
    grid,
    v.admin_0_boundary_lines_land,
    () => ({ color: 'rgba(255,255,255,0.42)', width: 0.9 * scale, dash: [4 * scale, 3 * scale] }),
  );
  strokeLines(ctx, grid, v.roads, p => {
    if (p.type === 'Ferry Route') return null;
    if (region.roadDetail === 'world') {
      if (p.type !== 'Major Highway') return null;
      return { color: 'rgba(250,232,196,0.30)', width: 0.8 };
    }
    if (p.expressway === 1) return { color: 'rgba(255,230,170,0.62)', width: 1.1 * scale };
    if (p.type === 'Major Highway') return { color: 'rgba(250,240,220,0.42)', width: 0.8 * scale };
    return { color: 'rgba(250,240,220,0.22)', width: 0.6 * scale };
  });

  const file = path.join(OUT, 'terrain', region.id, 'albedo.webp');
  const raw = ctx.getImageData(0, 0, grid.width, grid.height).data;
  await sharp(Buffer.from(raw.buffer), { raw: { width: grid.width, height: grid.height, channels: 4 } })
    .removeAlpha()
    .webp({ quality: 88, effort: 5 })
    .toFile(file);
  return { url: `assets/terrain/${region.id}/albedo.webp`, width: grid.width, height: grid.height };
}

async function buildMask(region, v) {
  const grid = gridOf(region.bbox, region.height);
  log(`${region.id}: mask ${grid.width}×${grid.height}`);
  const land = landMaskCanvas(grid, v);

  const lightsCanvas = makeCanvas(grid).ctx;
  lightsCanvas.fillStyle = '#000';
  lightsCanvas.fillRect(0, 0, grid.width, grid.height);
  fillPolygons(lightsCanvas, grid, v.urban_areas, '#fff');
  strokeLines(lightsCanvas, grid, v.roads, p =>
    p.type === 'Major Highway' || p.expressway === 1 ? { color: 'rgba(255,255,255,0.22)', width: 1 } : null,
  );
  const lights = blur(readMask(lightsCanvas, grid), grid.width, grid.height, region.id === 'world' ? 1 : 2);

  const waterCanvas = makeCanvas(grid).ctx;
  waterCanvas.fillStyle = '#000';
  waterCanvas.fillRect(0, 0, grid.width, grid.height);
  fillPolygons(waterCanvas, grid, v.lakes, '#fff');
  const inland = readMask(waterCanvas, grid);

  const buf = Buffer.alloc(grid.width * grid.height * 3);
  for (let i = 0; i < land.length; i++) {
    buf[i * 3] = Math.round(land[i] * 255);
    buf[i * 3 + 1] = Math.round(Math.min(1, lights[i] * 1.4) * 255);
    buf[i * 3 + 2] = Math.round(inland[i] * 255);
  }
  const file = path.join(OUT, 'terrain', region.id, 'mask.png');
  await sharp(buf, { raw: { width: grid.width, height: grid.height, channels: 3 } })
    .png({ compressionLevel: 9, palette: false })
    .toFile(file);
  return { land, url: `assets/terrain/${region.id}/mask.png`, width: grid.width, height: grid.height };
}

/** Web-Mercator tiles stop at ±85.05°; replace the smeared rows beyond ±84° with a smooth cap. */
function fillPolarCaps(h, grid) {
  const rowOf = lat => Math.round(((grid.north - lat) / (grid.north - grid.south)) * grid.height - 0.5);
  const caps = [
    { edge: rowOf(84), from: 0, to: rowOf(84) },
    { edge: rowOf(-84), from: rowOf(-84) + 1, to: grid.height },
  ];
  for (const { edge, from, to } of caps) {
    if (edge < 0 || edge >= grid.height || from >= to) continue;
    let avg = 0;
    for (let x = 0; x < grid.width; x++) avg += h[edge * grid.width + x];
    avg /= grid.width;
    for (let y = Math.max(0, from); y < Math.min(grid.height, to); y++) {
      const t = Math.min(1, Math.abs(y - edge) / (grid.height * 0.012));
      for (let x = 0; x < grid.width; x++) {
        const i = y * grid.width + x;
        h[i] = h[edge * grid.width + x] * (1 - t) + avg * t;
      }
    }
  }
}

async function buildRegion(region, v) {
  fs.mkdirSync(path.join(OUT, 'terrain', region.id), { recursive: true });
  const grid = gridOf(region.bbox, region.height);
  log(`${region.id}: DEM ${grid.width}×${grid.height}`);
  const { heights: rawDem, source } = await loadDem(region, grid);
  if (!GEBCO_DIR) fillPolarCaps(rawDem, grid);

  const mask = await buildMask(region, v);
  // Make coastlines agree with Natural Earth: land is never below sea level
  // (except genuine depressions well inland), sea never above it.
  const dem = new Float32Array(rawDem.length);
  for (let i = 0; i < dem.length; i++) {
    const l = mask.land[i];
    let h = rawDem[i];
    if (l > 0.5 && h < 1) h = Math.max(h, l > 0.99 && h < -5 ? h : 1);
    if (l < 0.5 && h > -1) h = -1;
    dem[i] = h;
  }

  const hgt = zlib.gzipSync(encodeHeights(dem, grid.width, grid.height), { level: 9 });
  fs.writeFileSync(path.join(OUT, 'terrain', region.id, 'height.hgt'), hgt);
  log(`${region.id}: height.hgt ${(hgt.length / 1e6).toFixed(1)} MB`);

  const albedo = await buildAlbedo(region, v, dem, grid.width, grid.height);
  return {
    id: region.id,
    bbox: region.bbox,
    albedo,
    height: { url: `assets/terrain/${region.id}/height.hgt`, width: grid.width, height: grid.height },
    mask: { url: mask.url, width: mask.width, height: mask.height },
    demSource: source,
  };
}

async function main() {
  const v = await loadVectors();
  fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });

  log('road graph (Japan)');
  const roads = buildRoadGraph(v.roads, [122, 24, 154, 46]);
  log(`  ${roads.stats.nodes} nodes, ${roads.stats.edges} edges, ${roads.stats.stitched} stitched`);
  const { stats: _stats, ...roadJson } = roads;
  fs.writeFileSync(path.join(OUT, 'data', 'roads-japan.json'), JSON.stringify(roadJson));

  const manifestFile = path.join(OUT, 'terrain', 'manifest.json');
  const prev = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { regions: [] };
  const regions = [];
  for (const region of REGIONS) {
    if (ONLY && ONLY !== region.id) {
      const old = prev.regions.find(r => r.id === region.id);
      if (old) regions.push(old);
      continue;
    }
    regions.push(await buildRegion(region, v));
  }
  const manifest = {
    generated: new Date().toISOString(),
    attribution: [
      'Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com',
      GEBCO_DIR
        ? 'GEBCO Compilation Group (GEBCO Grid)'
        : 'Terrain Tiles: Mapzen/AWS Open Data (SRTM, GMTED, ETOPO1 and others)',
      'NASA Blue Marble (biome tint)',
    ],
    regions,
  };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  log('done');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
