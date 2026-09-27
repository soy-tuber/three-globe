// Extract routable road / rail graphs from Natural Earth 10m roads and railroads.
//
// Output (compact JSON consumed by src/sim/roadGraph.ts):
//   { bbox, nodes: [lng0, lat0, lng1, lat1, ...], edges: [a0, b0, cls0, a1, b1, cls1, ...] }
// Roads — cls: 0 = expressway, 1 = major road, 2 = other road.
// Rails — cls: 0 = main line, 1 = secondary line, 2 = stitched gap.

const R_KM = 6371.0088;
const toRad = Math.PI / 180;

export function haversineKm(a, b) {
  const dLat = (b[1] - a[1]) * toRad;
  const dLng = (b[0] - a[0]) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function roadClass(p) {
  if (p.type === 'Ferry Route') return -1;
  if (p.expressway === 1) return 0;
  if (p.type === 'Major Highway') return 1;
  return 2;
}

/** Natural Earth railroads: category 1 = main line, 2/3 = secondary; others (ferries, unknown) skipped. */
export function railClass(p) {
  if (p.category === 1) return 0;
  if (p.category === 2 || p.category === 3) return 1;
  return -1;
}

export function buildRoadGraph(geojson, bbox, opts = {}) {
  return buildGraph(geojson, bbox, { classify: roadClass, ...opts });
}

export function buildRailGraph(geojson, bbox, opts = {}) {
  return buildGraph(geojson, bbox, { classify: railClass, stitchKm: 2.5, ...opts });
}

/**
 * Generic line-network → graph. `classify(props)` returns the edge class (lower = faster) or −1 to skip.
 */
export function buildGraph(geojson, bbox, { classify, stitchKm = 1.5 }) {
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
    const cls = classify(f.properties);
    if (cls < 0) continue;
    const g = f.geometry;
    if (!g) continue;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
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
      addEdge(i, best, 2);  // stitched gaps count as slow links
      stitched++;
    }
  });

  return contract(bbox, nodes, edges, stitched);
}

/** Douglas–Peucker on [lng, lat] points (planar degrees, fine at this tolerance). */
function simplify(pts, eps) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-18;
    let best = -1, bestD = eps * eps;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / len2));
      const ex = ax + t * dx - pts[i][0], ey = ay + t * dy - pts[i][1];
      const d = ex * ex + ey * ey;
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Collapse chains of degree-2 vertices (with equal class) into single edges that carry their
 * simplified geometry. Output:
 *   nodes:  [lng, lat, …]                  junctions and dead ends
 *   edges:  [a, b, cls, first, count, …]   `count` intermediate points starting at points[first]
 *   points: [lng, lat, …]                  intermediate geometry, in a → b order
 */
function contract(bbox, nodes, edgeMap, stitched, eps = 0.003) {
  const adj = nodes.map(() => []);
  for (const [k, cls] of edgeMap) {
    const [a, b] = k.split('|').map(Number);
    adj[a].push([b, cls]);
    adj[b].push([a, cls]);
  }
  const isJunction = i => adj[i].length !== 2 || adj[i][0][1] !== adj[i][1][1];
  const q = v => Math.round(v * 1e4) / 1e4;

  const outIndex = new Map();
  const outNodes = [];
  const outId = i => {
    let id = outIndex.get(i);
    if (id === undefined) {
      id = outNodes.length / 2;
      outIndex.set(i, id);
      outNodes.push(q(nodes[i][0]), q(nodes[i][1]));
    }
    return id;
  };
  const outEdges = [];
  const points = [];
  const seen = new Set();
  const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  const walk = (start, next, cls) => {
    const chain = [start];
    let prev = start, cur = next;
    seen.add(edgeKey(start, next));
    while (!isJunction(cur) && cur !== start) {
      chain.push(cur);
      const [n2] = adj[cur].find(([n]) => n !== prev) ?? adj[cur][0];
      seen.add(edgeKey(cur, n2));
      prev = cur;
      cur = n2;
    }
    chain.push(cur);
    const geom = simplify(chain.map(i => nodes[i]), eps);
    const inner = geom.slice(1, -1);
    outEdges.push(outId(start), outId(cur), cls, points.length / 2, inner.length);
    for (const [x, y] of inner) points.push(q(x), q(y));
  };

  for (let i = 0; i < nodes.length; i++) {
    if (!isJunction(i)) continue;
    for (const [n, cls] of adj[i]) if (!seen.has(edgeKey(i, n))) walk(i, n, cls);
  }
  // Pure loops with no junction at all.
  for (let i = 0; i < nodes.length; i++)
    for (const [n, cls] of adj[i]) if (!seen.has(edgeKey(i, n))) walk(i, n, cls);

  return {
    bbox,
    nodes: outNodes,
    edges: outEdges,
    points,
    stats: { nodes: outNodes.length / 2, edges: outEdges.length / 5, points: points.length / 2, stitched },
  };
}
