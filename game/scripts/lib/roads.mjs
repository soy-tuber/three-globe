// Extract a routable road graph from Natural Earth 10m roads.
//
// Output (compact JSON consumed by src/sim/roadGraph.ts):
//   { bbox, nodes: [lng0, lat0, lng1, lat1, ...], edges: [a0, b0, cls0, a1, b1, cls1, ...] }
// cls: 0 = expressway, 1 = major road, 2 = other road.

const R_KM = 6371.0088;
const toRad = Math.PI / 180;

export function haversineKm(a, b) {
  const dLat = (b[1] - a[1]) * toRad;
  const dLng = (b[0] - a[0]) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

function roadClass(p) {
  if (p.expressway === 1) return 0;
  if (p.type === 'Major Highway') return 1;
  return 2;
}

export function buildRoadGraph(geojson, bbox, { stitchKm = 1.5 } = {}) {
  const [w, s, e, n] = bbox;
  const inside = ([x, y]) => x >= w && x <= e && y >= s && y <= n;
  const keyOf = p => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;

  const index = new Map();
  const nodes = [];
  const edges = new Map(); // "a|b" -> cls (keep best class)
  const nodeId = p => {
    const k = keyOf(p);
    let id = index.get(k);
    if (id === undefined) {
      id = nodes.length;
      index.set(k, id);
      nodes.push([+p[0].toFixed(5), +p[1].toFixed(5)]);
    }
    return id;
  };
  const addEdge = (a, b, cls) => {
    if (a === b) return;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    const prev = edges.get(k);
    if (prev === undefined || cls < prev) edges.set(k, cls);
  };

  for (const f of geojson.features) {
    const p = f.properties;
    if (p.type === 'Ferry Route') continue;
    const g = f.geometry;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    const cls = roadClass(p);
    for (const line of lines) {
      if (!line.some(inside)) continue;
      for (let i = 1; i < line.length; i++) addEdge(nodeId(line[i - 1]), nodeId(line[i]), cls);
    }
  }

  // Stitch dangling ends that stop just short of another road (digitisation gaps).
  const degree = new Uint32Array(nodes.length);
  for (const k of edges.keys()) {
    const [a, b] = k.split('|').map(Number);
    degree[a]++;
    degree[b]++;
  }
  const cell = 0.05;
  const grid = new Map();
  nodes.forEach((p, i) => {
    const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  let stitched = 0;
  nodes.forEach((p, i) => {
    if (degree[i] !== 1) return;
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell);
    let best = -1, bestD = stitchKm;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (j === i) continue;
          const k = i < j ? `${i}|${j}` : `${j}|${i}`;
          if (edges.has(k)) continue;
          const d = haversineKm(p, nodes[j]);
          if (d < bestD) {
            bestD = d;
            best = j;
          }
        }
    if (best >= 0) {
      addEdge(i, best, 2);
      stitched++;
    }
  });

  const flatNodes = nodes.flat();
  const flatEdges = [];
  for (const [k, cls] of edges) {
    const [a, b] = k.split('|').map(Number);
    flatEdges.push(a, b, cls);
  }
  return { bbox, nodes: flatNodes, edges: flatEdges, stats: { nodes: nodes.length, edges: edges.size, stitched } };
}
