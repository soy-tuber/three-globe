// Asset-pipeline tests (scripts/lib). These run in Node; no network access needed.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
// @ts-expect-error — plain JS module
import { gebcoDem, encodeHeights } from '../scripts/lib/dem.mjs';
// @ts-expect-error — plain JS module
import { buildRoadGraph } from '../scripts/lib/roads.mjs';

/** Minimal uncompressed TIFF with signed 16-bit samples, like GEBCO's GeoTIFF tiles. */
function writeInt16Tiff(file: string, W: number, H: number, data: Int16Array) {
  const entries: [number, number, number, number][] = [
    [256, 3, 1, W], [257, 3, 1, H], [258, 3, 1, 16], [259, 3, 1, 1], [262, 3, 1, 1],
    [273, 4, 1, 0], [277, 3, 1, 1], [278, 3, 1, H], [279, 4, 1, W * H * 2], [339, 3, 1, 2],
  ];
  const dataOffset = 8 + 2 + entries.length * 12 + 4;
  const buf = Buffer.alloc(dataOffset + W * H * 2);
  buf.write('II', 0);
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(8, 4);
  buf.writeUInt16LE(entries.length, 8);
  entries.forEach(([tag, type, count, value], i) => {
    const o = 10 + i * 12;
    buf.writeUInt16LE(tag, o);
    buf.writeUInt16LE(type, o + 2);
    buf.writeUInt32LE(count, o + 4);
    const v = tag === 273 ? dataOffset : value;
    if (type === 3) buf.writeUInt16LE(v, o + 8);
    else buf.writeUInt32LE(v, o + 8);
  });
  for (let i = 0; i < W * H; i++) buf.writeInt16LE(data[i], dataOffset + i * 2);
  fs.writeFileSync(file, buf);
}

describe('GEBCO loader', () => {
  it('reads signed int16 GeoTIFF tiles (negative bathymetry survives)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gebco-'));
    const W = 900, H = 900; // 0.1°/px over n90 s0 w90 e180
    const px = new Int16Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px[y * W + x] = Math.round(((x + 0.5) / W) * 9000 - 5000);
    writeInt16Tiff(path.join(dir, 'gebco_2024_n90.0_s0.0_w90.0_e180.0.tif'), W, H, px);

    const grid = { west: 122, south: 24, east: 154, north: 46, width: 64, height: 44 };
    const h: Float32Array = await gebcoDem(grid, dir);
    for (const x of [0, 32, 63]) {
      const lng = 122 + ((x + 0.5) / 64) * 32;
      expect(h[20 * 64 + x]).toBeCloseTo((lng - 90) * 100 - 5000, -2); // within ~50 m
    }
    expect(Math.min(...h)).toBeLessThan(-1500);
  });
});

describe('height encoding', () => {
  it('delta-coded Int16 round-trips', () => {
    const W = 5, H = 3;
    const src = Float32Array.from({ length: W * H }, (_, i) => (i % 2 ? -1 : 1) * i * 731.4);
    const bytes = zlib.gunzipSync(zlib.gzipSync(encodeHeights(src, W, H)));
    const d = new Int16Array(bytes.buffer, bytes.byteOffset, W * H);
    for (let y = 0; y < H; y++) {
      let v = 0;
      for (let x = 0; x < W; x++) {
        v += d[y * W + x];
        expect(v).toBe(Math.max(-11000, Math.min(9000, Math.round(src[y * W + x]))));
      }
    }
  });
});

describe('road graph extraction', () => {
  it('snaps shared vertices, stitches small gaps and contracts chains', () => {
    const fc = {
      features: [
        { properties: { type: 'Major Highway', expressway: 1 }, geometry: { type: 'LineString', coordinates: [[139, 35], [139.1, 35]] } },
        { properties: { type: 'Road', expressway: 0 }, geometry: { type: 'LineString', coordinates: [[139.1, 35], [139.2, 35]] } },
        // Starts 500 m short of the previous line's end → stitched.
        { properties: { type: 'Road', expressway: 0 }, geometry: { type: 'LineString', coordinates: [[139.2055, 35], [139.3, 35]] } },
        { properties: { type: 'Ferry Route' }, geometry: { type: 'LineString', coordinates: [[139, 35], [140, 35]] } },
      ],
    };
    const g = buildRoadGraph(fc, [122, 24, 154, 46]);
    // Ferry skipped; the 500 m gap stitched; degree-2 chains contracted → only the class change
    // at 139.1 and the two dead ends remain as junctions.
    expect(g.stats.stitched).toBeGreaterThanOrEqual(1);
    expect(g.stats.nodes).toBe(3);
    expect(g.stats.edges).toBe(2);
    const classes = [g.edges[2], g.edges[7]].sort();
    expect(classes).toEqual([0, 2]);
    // The contracted slow edge keeps its geometry (at most simplified away when collinear).
    expect(g.points.length % 2).toBe(0);
  });
});
