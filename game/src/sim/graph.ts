// Routable line network (roads or railways) built by scripts/build-assets.mjs.
//
// Chains of degree-2 vertices are contracted into edges that carry their geometry, so endpoints can lie
// in the middle of an edge. Routing therefore snaps to the nearest point *on an edge* and runs A* from
// both of that edge's ends.
import { haversineKm, type LatLng } from './geo';

/** Segment classes. Their meaning depends on the network (see modes.ts); 3 is always an access leg. */
export const SegClass = { Fast: 0, Major: 1, Minor: 2, Access: 3 } as const;
export type SegClass = (typeof SegClass)[keyof typeof SegClass];

export interface GraphJson {
  bbox: [number, number, number, number];
  /** junctions: flat [lng, lat, …] */
  nodes: number[];
  /** flat [a, b, cls, firstPoint, pointCount, …] */
  edges: number[];
  /** intermediate edge geometry: flat [lng, lat, …] in a → b order */
  points: number[];
}

export interface TransportPath {
  points: LatLng[];
  /** class of segment i (points[i] → points[i+1]) */
  segmentClass: Uint8Array;
  lengthKm: number;
  /** free-flow travel time in minutes */
  durationMin: number;
}

export type Speeds = readonly [number, number, number, number];

interface Snap {
  edge: number;
  /** distance from the edge's `a` end along its geometry */
  alongKm: number;
  distKm: number;
  point: LatLng;
}

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  peekKey() {
    return this.keys[0];
  }
  push(id: number, key: number) {
    const ids = this.ids, keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): number {
    const ids = this.ids, keys = this.keys;
    const top = ids[0];
    const lastId = ids.pop()!, lastKey = keys.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lastKey) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = lastId;
      keys[i] = lastKey;
    }
    return top;
  }
}

export function pathFromPoints(points: LatLng[], cls: SegClass[], speeds: Speeds): TransportPath {
  let lengthKm = 0, durationMin = 0;
  for (let i = 0; i < cls.length; i++) {
    const d = haversineKm(points[i], points[i + 1]);
    lengthKm += d;
    durationMin += (d / speeds[cls[i]]) * 60;
  }
  return { points, segmentClass: Uint8Array.from(cls), lengthKm, durationMin };
}

export class TransportGraph {
  readonly bbox: [number, number, number, number];
  readonly nodeCount: number;
  private readonly nodeLng: Float64Array;
  private readonly nodeLat: Float64Array;
  private readonly edgeA: Uint32Array;
  private readonly edgeB: Uint32Array;
  private readonly edgeCls: Uint8Array;
  /** per edge: its full geometry (endpoints included) */
  private readonly geom: LatLng[][];
  private readonly cum: Float64Array[];
  private readonly edgeLen: Float64Array;
  // CSR adjacency: node → (edge, other node)
  private readonly offsets: Uint32Array;
  private readonly adjEdge: Uint32Array;
  private readonly adjNode: Uint32Array;
  // spatial hash over segments: cell → [edge, segment, …]
  private readonly cellDeg = 0.1;
  private readonly cells = new Map<number, number[]>();

  constructor(
    json: GraphJson,
    readonly speeds: Speeds,
  ) {
    this.bbox = json.bbox;
    const n = (this.nodeCount = json.nodes.length / 2);
    this.nodeLng = new Float64Array(n);
    this.nodeLat = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.nodeLng[i] = json.nodes[2 * i];
      this.nodeLat[i] = json.nodes[2 * i + 1];
    }
    const m = json.edges.length / 5;
    this.edgeA = new Uint32Array(m);
    this.edgeB = new Uint32Array(m);
    this.edgeCls = new Uint8Array(m);
    this.geom = new Array(m);
    this.cum = new Array(m);
    this.edgeLen = new Float64Array(m);
    const degree = new Uint32Array(n);
    for (let e = 0; e < m; e++) {
      const [a, b, cls, first, count] = json.edges.slice(5 * e, 5 * e + 5);
      this.edgeA[e] = a;
      this.edgeB[e] = b;
      this.edgeCls[e] = cls;
      const g: LatLng[] = [this.node(a)];
      for (let k = 0; k < count; k++) g.push({ lng: json.points[2 * (first + k)], lat: json.points[2 * (first + k) + 1] });
      g.push(this.node(b));
      this.geom[e] = g;
      const c = new Float64Array(g.length);
      for (let k = 1; k < g.length; k++) c[k] = c[k - 1] + haversineKm(g[k - 1], g[k]);
      this.cum[e] = c;
      this.edgeLen[e] = c[g.length - 1];
      degree[a]++;
      degree[b]++;
      for (let k = 1; k < g.length; k++) this.indexSegment(e, k - 1, g[k - 1], g[k]);
    }
    this.offsets = new Uint32Array(n + 1);
    for (let i = 0; i < n; i++) this.offsets[i + 1] = this.offsets[i] + degree[i];
    this.adjEdge = new Uint32Array(2 * m);
    this.adjNode = new Uint32Array(2 * m);
    const fill = this.offsets.slice(0, n);
    for (let e = 0; e < m; e++) {
      const a = this.edgeA[e], b = this.edgeB[e];
      this.adjEdge[fill[a]] = e;
      this.adjNode[fill[a]++] = b;
      this.adjEdge[fill[b]] = e;
      this.adjNode[fill[b]++] = a;
    }
  }

  node(i: number): LatLng {
    return { lat: this.nodeLat[i], lng: this.nodeLng[i] };
  }

  get edgeCount() {
    return this.edgeA.length;
  }

  contains(p: LatLng, marginDeg = 0): boolean {
    const [w, s, e, n] = this.bbox;
    return p.lng >= w - marginDeg && p.lng <= e + marginDeg && p.lat >= s - marginDeg && p.lat <= n + marginDeg;
  }

  private cellKey(cx: number, cy: number) {
    return (cx + 2000) * 4000 + (cy + 1000);
  }

  private indexSegment(e: number, seg: number, p: LatLng, q: LatLng) {
    const x0 = Math.floor(Math.min(p.lng, q.lng) / this.cellDeg), x1 = Math.floor(Math.max(p.lng, q.lng) / this.cellDeg);
    const y0 = Math.floor(Math.min(p.lat, q.lat) / this.cellDeg), y1 = Math.floor(Math.max(p.lat, q.lat) / this.cellDeg);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = this.cellKey(x, y);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(e, seg);
      }
  }

  /** Nearest point on the network to p (optionally only on edges of the given classes). */
  snap(p: LatLng, maxKm: number, classes?: readonly number[]): Snap | null {
    const kx = Math.cos((p.lat * Math.PI) / 180);
    const cx = Math.floor(p.lng / this.cellDeg), cy = Math.floor(p.lat / this.cellDeg);
    const rings = Math.ceil(maxKm / (this.cellDeg * 111 * Math.max(0.2, kx))) + 1;
    let best = null as Snap | null;
    for (let r = 0; r <= rings; r++) {
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const list = this.cells.get(this.cellKey(cx + dx, cy + dy));
          if (!list) continue;
          for (let i = 0; i < list.length; i += 2) {
            const e = list[i], seg = list[i + 1];
            if (classes && !classes.includes(this.edgeCls[e])) continue;
            const a = this.geom[e][seg], b = this.geom[e][seg + 1];
            // Project in a local equirectangular frame.
            const ax = (a.lng - p.lng) * kx, ay = a.lat - p.lat;
            const bx = (b.lng - p.lng) * kx, by = b.lat - p.lat;
            const vx = bx - ax, vy = by - ay;
            const len2 = vx * vx + vy * vy;
            const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / len2)) : 0;
            const point = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
            const d = haversineKm(p, point);
            if (d <= maxKm && (!best || d < best.distKm)) {
              const segLen = this.cum[e][seg + 1] - this.cum[e][seg];
              best = { edge: e, alongKm: this.cum[e][seg] + segLen * t, distKm: d, point };
            }
          }
        }
      // Anything in ring r+1 is at least r cells away.
      if (best && best.distKm < r * this.cellDeg * 111 * Math.max(0.2, kx)) break;
    }
    return best;
  }

  private cost(e: number, km = this.edgeLen[e]) {
    return (km / this.speeds[this.edgeCls[e] as SegClass]) * 60;
  }

  /** Point at an along-distance on edge e. */
  private pointOnEdge(e: number, alongKm: number): LatLng {
    const g = this.geom[e], c = this.cum[e];
    if (alongKm <= 0) return g[0];
    if (alongKm >= c[c.length - 1]) return g[g.length - 1];
    let k = 1;
    while (c[k] < alongKm) k++;
    const t = (alongKm - c[k - 1]) / (c[k] - c[k - 1] || 1);
    return { lat: g[k - 1].lat + (g[k].lat - g[k - 1].lat) * t, lng: g[k - 1].lng + (g[k].lng - g[k - 1].lng) * t };
  }

  /** Geometry of edge e between two along-distances, in travel order (either direction). */
  private slice(e: number, fromKm: number, toKm: number): LatLng[] {
    const g = this.geom[e], c = this.cum[e];
    const out = [this.pointOnEdge(e, fromKm)];
    if (toKm >= fromKm) {
      for (let k = 0; k < g.length; k++) if (c[k] > fromKm + 1e-9 && c[k] < toKm - 1e-9) out.push(g[k]);
    } else {
      for (let k = g.length - 1; k >= 0; k--) if (c[k] < fromKm - 1e-9 && c[k] > toKm + 1e-9) out.push(g[k]);
    }
    out.push(this.pointOnEdge(e, toKm));
    return out;
  }

  /** Fastest path between two snapped points. */
  private between(s: Snap, t: Snap): { points: LatLng[]; cls: SegClass[] } | null {
    const vmax = Math.max(...this.speeds);
    const h = (i: number) => (haversineKm(this.node(i), t.point) / vmax) * 60;
    const g = new Map<number, number>();
    const prevEdge = new Map<number, number>();
    const closed = new Set<number>();
    const open = new MinHeap();

    // Same edge: travel directly along it.
    let bestCost = Infinity;
    let bestEnd: { node: number; endCost: number } | null = null;
    if (s.edge === t.edge) bestCost = this.cost(s.edge, Math.abs(t.alongKm - s.alongKm));

    const seed = (node: number, c: number) => {
      if (c < (g.get(node) ?? Infinity)) {
        g.set(node, c);
        prevEdge.set(node, -1);
        open.push(node, c + h(node));
      }
    };
    seed(this.edgeA[s.edge], this.cost(s.edge, s.alongKm));
    seed(this.edgeB[s.edge], this.cost(s.edge, this.edgeLen[s.edge] - s.alongKm));
    const tA = this.edgeA[t.edge], tB = this.edgeB[t.edge];
    const tailA = this.cost(t.edge, t.alongKm), tailB = this.cost(t.edge, this.edgeLen[t.edge] - t.alongKm);

    while (open.size && open.peekKey() < bestCost) {
      const u = open.pop();
      if (closed.has(u)) continue;
      closed.add(u);
      const gu = g.get(u)!;
      if (u === tA && gu + tailA < bestCost) (bestCost = gu + tailA), (bestEnd = { node: u, endCost: tailA });
      if (u === tB && gu + tailB < bestCost) (bestCost = gu + tailB), (bestEnd = { node: u, endCost: tailB });
      for (let k = this.offsets[u]; k < this.offsets[u + 1]; k++) {
        const v = this.adjNode[k];
        if (closed.has(v)) continue;
        const e = this.adjEdge[k];
        const c = gu + this.cost(e);
        if (c < (g.get(v) ?? Infinity)) {
          g.set(v, c);
          prevEdge.set(v, e);
          open.push(v, c + h(v));
        }
      }
    }
    if (bestCost === Infinity) return null;

    const points: LatLng[] = [];
    const cls: SegClass[] = [];
    const push = (pts: LatLng[], c: number) => {
      for (const p of pts) {
        if (points.length) {
          if (haversineKm(points[points.length - 1], p) < 1e-6) continue;
          cls.push(c as SegClass);
        }
        points.push(p);
      }
    };

    if (!bestEnd) {
      // Straight along the shared edge.
      push(this.slice(s.edge, s.alongKm, t.alongKm), this.edgeCls[s.edge]);
      return { points, cls };
    }

    // Walk back from the end node to one of the start edge's ends.
    const nodes = [bestEnd.node];
    const edges: number[] = [];
    for (;;) {
      const e = prevEdge.get(nodes[nodes.length - 1])!;
      if (e < 0) break;
      edges.push(e);
      const cur = nodes[nodes.length - 1];
      nodes.push(this.edgeA[e] === cur ? this.edgeB[e] : this.edgeA[e]);
    }
    nodes.reverse();
    edges.reverse();

    // snapped start → first node, along the start edge
    const firstEnd = nodes[0] === this.edgeA[s.edge] ? 0 : this.edgeLen[s.edge];
    push(this.slice(s.edge, s.alongKm, firstEnd), this.edgeCls[s.edge]);
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const forward = this.edgeA[e] === nodes[i];
      push(forward ? this.geom[e] : [...this.geom[e]].reverse(), this.edgeCls[e]);
    }
    // last node → snapped end, along the target edge
    const lastEnd = nodes[nodes.length - 1] === this.edgeA[t.edge] ? 0 : this.edgeLen[t.edge];
    push(this.slice(t.edge, lastEnd, t.alongKm), this.edgeCls[t.edge]);
    return { points, cls };
  }

  /**
   * Path from a to b through optional waypoints. Endpoints get straight access legs to the network;
   * waypoints snap to `viaClasses` edges only (e.g. to force a particular expressway).
   */
  route(
    a: LatLng,
    b: LatLng,
    opts: { via?: LatLng[]; viaClasses?: number[]; maxSnapKm?: number } = {},
  ): TransportPath | { error: 'snap-start' | 'snap-end' | 'no-path' } {
    const maxSnap = opts.maxSnapKm ?? 30;
    const sa = this.snap(a, maxSnap);
    if (!sa) return { error: 'snap-start' };
    const sb = this.snap(b, maxSnap);
    if (!sb) return { error: 'snap-end' };
    const anchors = [sa];
    for (const w of opts.via ?? []) {
      const s = this.snap(w, 20, opts.viaClasses ?? [SegClass.Fast]);
      if (s) anchors.push(s);
    }
    anchors.push(sb);

    const points: LatLng[] = [a];
    const cls: SegClass[] = [];
    if (sa.distKm > 0.01) {
      points.push(sa.point);
      cls.push(SegClass.Access);
    }
    for (let i = 1; i < anchors.length; i++) {
      const part = this.between(anchors[i - 1], anchors[i]);
      if (!part) return { error: 'no-path' };
      for (let k = 1; k < part.points.length; k++) {
        points.push(part.points[k]);
        cls.push(part.cls[k - 1]);
      }
    }
    if (sb.distKm > 0.01) {
      points.push(b);
      cls.push(SegClass.Access);
    } else points[points.length - 1] = b;

    // Drop zero-length segments.
    const P: LatLng[] = [points[0]];
    const C: SegClass[] = [];
    for (let i = 1; i < points.length; i++) {
      if (haversineKm(P[P.length - 1], points[i]) < 1e-6) continue;
      P.push(points[i]);
      C.push(cls[i - 1]);
    }
    if (P.length < 2) {
      P.push(b);
      C.push(SegClass.Access);
    }
    return pathFromPoints(P, C, this.speeds);
  }
}

export function isPath(p: TransportPath | { error: string }): p is TransportPath {
  return (p as TransportPath).points !== undefined;
}
