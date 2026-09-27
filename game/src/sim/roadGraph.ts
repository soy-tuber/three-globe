// Routable road network (built from Natural Earth 10m roads by scripts/build-assets.mjs).
import { haversineKm, type LatLng } from './geo';

export const RoadClass = {
  Expressway: 0,
  Major: 1,
  Minor: 2,
  /** straight-line connector between a city centre and the network */
  Access: 3,
} as const;
export type RoadClass = (typeof RoadClass)[keyof typeof RoadClass];

/** Free-flow speeds (km/h) used both for routing and for vehicle movement. */
export const ROAD_SPEED_KMH: Record<RoadClass, number> = {
  [RoadClass.Expressway]: 88,
  [RoadClass.Major]: 52,
  [RoadClass.Minor]: 40,
  [RoadClass.Access]: 24,
};

export interface RoadGraphJson {
  bbox: [number, number, number, number];
  /** flat [lng, lat, lng, lat, …] */
  nodes: number[];
  /** flat [a, b, cls, a, b, cls, …] */
  edges: number[];
}

export interface RoadPath {
  points: LatLng[];
  /** road class of segment i (points[i] → points[i+1]) */
  segmentClass: Uint8Array;
  lengthKm: number;
  /** free-flow driving time in minutes */
  durationMin: number;
}

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];

  get size() {
    return this.ids.length;
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
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
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

export class RoadGraph {
  readonly nodeCount: number;
  private readonly lng: Float64Array;
  private readonly lat: Float64Array;
  // CSR adjacency
  private readonly offsets: Uint32Array;
  private readonly targets: Uint32Array;
  private readonly lengths: Float32Array;
  private readonly classes: Uint8Array;
  // spatial hash for nearest-node lookups
  private readonly cellDeg = 0.1;
  private readonly cells = new Map<string, number[]>();

  constructor(json: RoadGraphJson) {
    const n = (this.nodeCount = json.nodes.length / 2);
    this.lng = new Float64Array(n);
    this.lat = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.lng[i] = json.nodes[2 * i];
      this.lat[i] = json.nodes[2 * i + 1];
    }

    const m = json.edges.length / 3;
    const degree = new Uint32Array(n);
    for (let e = 0; e < m; e++) {
      degree[json.edges[3 * e]]++;
      degree[json.edges[3 * e + 1]]++;
    }
    this.offsets = new Uint32Array(n + 1);
    for (let i = 0; i < n; i++) this.offsets[i + 1] = this.offsets[i] + degree[i];
    this.targets = new Uint32Array(2 * m);
    this.lengths = new Float32Array(2 * m);
    this.classes = new Uint8Array(2 * m);
    const fill = this.offsets.slice(0, n);
    for (let e = 0; e < m; e++) {
      const a = json.edges[3 * e], b = json.edges[3 * e + 1], c = json.edges[3 * e + 2];
      const len = haversineKm(this.node(a), this.node(b));
      for (const [u, v] of [
        [a, b],
        [b, a],
      ]) {
        const k = fill[u]++;
        this.targets[k] = v;
        this.lengths[k] = len;
        this.classes[k] = c;
      }
    }

    for (let i = 0; i < n; i++) {
      const key = this.cellKey(this.lng[i], this.lat[i]);
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, (list = []));
      list.push(i);
    }
  }

  node(i: number): LatLng {
    return { lat: this.lat[i], lng: this.lng[i] };
  }

  private cellKey(lng: number, lat: number) {
    return `${Math.floor(lng / this.cellDeg)},${Math.floor(lat / this.cellDeg)}`;
  }

  private touchesExpressway(i: number): boolean {
    for (let k = this.offsets[i]; k < this.offsets[i + 1]; k++) if (this.classes[k] === RoadClass.Expressway) return true;
    return false;
  }

  /** Nearest graph node to p (searching outward ring by ring). */
  nearestNode(p: LatLng, maxRings = 30, expresswayOnly = false): { id: number; distKm: number } | null {
    const cx = Math.floor(p.lng / this.cellDeg), cy = Math.floor(p.lat / this.cellDeg);
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= maxRings; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          for (const i of this.cells.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (expresswayOnly && !this.touchesExpressway(i)) continue;
            const d = haversineKm(p, this.node(i));
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      // Anything in ring r+1 is at least r cells away.
      if (best >= 0 && bestD < r * this.cellDeg * 111 * Math.cos((p.lat * Math.PI) / 180)) break;
    }
    return best >= 0 ? { id: best, distKm: bestD } : null;
  }

  /** Fastest path between two nodes (A*, time-weighted). */
  shortestPath(from: number, to: number): number[] | null {
    const n = this.nodeCount;
    const g = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const vmax = ROAD_SPEED_KMH[RoadClass.Expressway];
    const target = this.node(to);
    const h = (i: number) => (haversineKm(this.node(i), target) / vmax) * 60;

    const open = new MinHeap();
    g[from] = 0;
    open.push(from, h(from));
    while (open.size) {
      const u = open.pop();
      if (u === to) break;
      if (closed[u]) continue;
      closed[u] = 1;
      for (let k = this.offsets[u]; k < this.offsets[u + 1]; k++) {
        const v = this.targets[k];
        if (closed[v]) continue;
        const cost = g[u] + (this.lengths[k] / ROAD_SPEED_KMH[this.classes[k] as RoadClass]) * 60;
        if (cost < g[v]) {
          g[v] = cost;
          prev[v] = u;
          open.push(v, cost + h(v));
        }
      }
    }
    if (from !== to && prev[to] < 0) return null;
    const path = [to];
    while (path[path.length - 1] !== from) path.push(prev[path[path.length - 1]]);
    return path.reverse();
  }

  private edgeClass(a: number, b: number): RoadClass {
    for (let k = this.offsets[a]; k < this.offsets[a + 1]; k++) if (this.targets[k] === b) return this.classes[k] as RoadClass;
    return RoadClass.Access;
  }

  /** Road path between two arbitrary points, including access legs to/from the network. */
  route(a: LatLng, b: LatLng): RoadPath | null {
    return this.routeVia(a, [], b);
  }

  /**
   * Road path from a to b passing through expressway waypoints (e.g. to pick the Tōmei over the Chūō).
   * Waypoints snap to the nearest expressway node; the endpoints get straight access legs.
   */
  routeVia(a: LatLng, via: LatLng[], b: LatLng): RoadPath | null {
    const na = this.nearestNode(a);
    const nb = this.nearestNode(b);
    if (!na || !nb) return null;
    const anchors = [na.id];
    for (const w of via) {
      const n = this.nearestNode(w, 30, true);
      if (!n) return null;
      anchors.push(n.id);
    }
    anchors.push(nb.id);
    const nodes: number[] = [];
    for (let i = 1; i < anchors.length; i++) {
      const part = this.shortestPath(anchors[i - 1], anchors[i]);
      if (!part) return null;
      nodes.push(...(i === 1 ? part : part.slice(1)));
    }

    const points: LatLng[] = [a];
    const cls: RoadClass[] = [];
    if (na.distKm > 0.01) {
      points.push(this.node(nodes[0]));
      cls.push(RoadClass.Access);
    }
    for (let i = 1; i < nodes.length; i++) {
      points.push(this.node(nodes[i]));
      cls.push(this.edgeClass(nodes[i - 1], nodes[i]));
    }
    if (nb.distKm > 0.01) {
      points.push(b);
      cls.push(RoadClass.Access);
    } else {
      points[points.length - 1] = b;
    }
    if (points.length < 2) points.push(b), cls.push(RoadClass.Access);

    let lengthKm = 0, durationMin = 0;
    for (let i = 0; i < cls.length; i++) {
      const d = haversineKm(points[i], points[i + 1]);
      lengthKm += d;
      durationMin += (d / ROAD_SPEED_KMH[cls[i]]) * 60;
    }
    return { points, segmentClass: Uint8Array.from(cls), lengthKm, durationMin };
  }
}
