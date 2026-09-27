// Rasterise GeoJSON (lng/lat) onto equirectangular canvases.
import { createCanvas, Path2D } from '@napi-rs/canvas';

export function makeCanvas(grid) {
  const canvas = createCanvas(grid.width, grid.height);
  const ctx = canvas.getContext('2d');
  return { canvas, ctx };
}

function projector(grid) {
  const sx = grid.width / (grid.east - grid.west);
  const sy = grid.height / (grid.north - grid.south);
  return (lng, lat) => [(lng - grid.west) * sx, (grid.north - lat) * sy];
}

const intersects = (bbox, grid) =>
  bbox[2] >= grid.west && bbox[0] <= grid.east && bbox[3] >= grid.south && bbox[1] <= grid.north;

function ringsBbox(rings) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const ring of rings)
    for (const [x, y] of ring) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  return [w, s, e, n];
}

/** Iterate geometries as lists of rings/lines, skipping those outside the grid. */
function* parts(geojson, grid, kind) {
  for (const f of geojson.features) {
    const g = f.geometry;
    if (!g) continue;
    const polys =
      kind === 'polygon'
        ? g.type === 'Polygon'
          ? [g.coordinates]
          : g.type === 'MultiPolygon'
            ? g.coordinates
            : []
        : g.type === 'LineString'
          ? [[g.coordinates]]
          : g.type === 'MultiLineString'
            ? g.coordinates.map(l => [l])
            : [];
    for (const rings of polys) {
      if (!intersects(ringsBbox(rings), grid)) continue;
      yield { rings, props: f.properties };
    }
  }
}

export function fillPolygons(ctx, grid, geojson, style, filter = () => true) {
  const project = projector(grid);
  const path = new Path2D();
  for (const { rings, props } of parts(geojson, grid, 'polygon')) {
    if (!filter(props)) continue;
    for (const ring of rings) {
      ring.forEach(([lng, lat], i) => {
        const [x, y] = project(lng, lat);
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      });
      path.closePath();
    }
  }
  ctx.fillStyle = style;
  ctx.fill(path, 'evenodd');
  return path;
}

export function strokeLines(ctx, grid, geojson, styleFn, filter = () => true) {
  const project = projector(grid);
  // Group by style so each group is a single stroke call.
  const groups = new Map();
  for (const { rings, props } of parts(geojson, grid, 'line')) {
    if (!filter(props)) continue;
    const style = styleFn(props);
    if (!style) continue;
    const key = JSON.stringify(style);
    if (!groups.has(key)) groups.set(key, { style, path: new Path2D() });
    const { path } = groups.get(key);
    for (const line of rings) {
      line.forEach(([lng, lat], i) => {
        const [x, y] = project(lng, lat);
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      });
    }
  }
  for (const { style, path } of groups.values()) {
    ctx.save();
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (style.dash) ctx.setLineDash(style.dash);
    ctx.stroke(path);
    ctx.restore();
  }
}

export function strokePolygonOutlines(ctx, grid, geojson, color, width) {
  const project = projector(grid);
  const path = new Path2D();
  for (const { rings } of parts(geojson, grid, 'polygon')) {
    for (const ring of rings) {
      ring.forEach(([lng, lat], i) => {
        const [x, y] = project(lng, lat);
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      });
      path.closePath();
    }
  }
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.stroke(path);
  ctx.restore();
}

/** Coverage (0..1) of a white-on-black mask canvas. */
export function readMask(ctx, grid) {
  const { data } = ctx.getImageData(0, 0, grid.width, grid.height);
  const out = new Float32Array(grid.width * grid.height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4] / 255;
  return out;
}
