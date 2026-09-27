// Global sea-navigation grid for ship routing.
//
// The ocean is rasterised at twice the target resolution and OR-downsampled, so a cell is navigable
// when any meaningful part of it is sea — this keeps narrow straits (Akashi, Bosporus, Gibraltar) open.
// Output: gzip(bitset, row-major north-up, 1 = navigable).
import { makeCanvas, fillPolygons, readMask } from './raster.mjs';

export function buildSeaGrid(ocean, { width = 3600, height = 1800, polarLimit = 78 } = {}) {
  const fine = { west: -180, south: -90, east: 180, north: 90, width: width * 2, height: height * 2 };
  const { ctx } = makeCanvas(fine);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, fine.width, fine.height);
  fillPolygons(ctx, fine, ocean, '#fff');
  const sea = readMask(ctx, fine);

  const bits = new Uint8Array(Math.ceil((width * height) / 8));
  let count = 0;
  for (let y = 0; y < height; y++) {
    const lat = 90 - ((y + 0.5) / height) * 180;
    if (Math.abs(lat) > polarLimit) continue; // pack ice
    for (let x = 0; x < width; x++) {
      let m = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) m = Math.max(m, sea[(y * 2 + dy) * fine.width + x * 2 + dx]);
      if (m > 0.3) {
        const i = y * width + x;
        bits[i >> 3] |= 1 << (i & 7);
        count++;
      }
    }
  }
  return { bits, width, height, navigable: count };
}
