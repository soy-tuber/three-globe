// Ship routing over a global navigability grid (see scripts/lib/sea.mjs).
import { haversineKm, interpolate, type LatLng } from './geo';
import { SegClass, pathFromPoints, type Speeds, type TransportPath } from './graph';

export class SeaGrid {
  constructor(
    private readonly bits: Uint8Array,
    readonly width: number,
    readonly height: number,
  ) {}

  private get degX() {
    return 360 / this.width;
  }
  private get degY() {
    return 180 / this.height;
  }

  isSea(x: number, y: number): boolean {
    if (y < 0 || y >= this.height) return false;
    x = ((x % this.width) + this.width) % this.width;
    const i = y * this.width + x;
    return (this.bits[i >> 3] & (1 << (i & 7))) !== 0;
  }

  cellOf(p: LatLng): [number, number] {
    const x = Math.floor(((p.lng + 180) / 360) * this.width);
    const y = Math.floor(((90 - p.lat) / 180) * this.height);
    return [((x % this.width) + this.width) % this.width, Math.max(0, Math.min(this.height - 1, y))];
  }

  center(x: number, y: number): LatLng {
    return { lng: -180 + (x + 0.5) * this.degX, lat: 90 - (y + 0.5) * this.degY };
  }

  isSeaAt(p: LatLng): boolean {
    const [x, y] = this.cellOf(p);
    return this.isSea(x, y);
  }

  /** Nearest navigable cell within maxKm of p (a port's harbour entrance). */
  nearestSea(p: LatLng, maxKm = 40): { x: number; y: number; distKm: number } | null {
    const [cx, cy] = this.cellOf(p);
    const ry = Math.ceil(maxKm / (this.degY * 111)) + 1;
    const rx = Math.min(this.width / 2, Math.ceil(ry / Math.max(0.05, Math.cos((p.lat * Math.PI) / 180))));
    let best: { x: number; y: number; distKm: number } | null = null;
    for (let dy = -ry; dy <= ry; dy++)
      for (let dx = -rx; dx <= rx; dx++) {
        const x = (cx + dx + this.width) % this.width, y = cy + dy;
        if (!this.isSea(x, y)) continue;
        const d = haversineKm(p, this.center(x, y));
        if (d <= maxKm && (!best || d < best.distKm)) best = { x, y, distKm: d };
      }
    return best;
  }

  /** Is the great-circle segment a→b entirely over sea (sampled every ~4 km)? */
  lineOfSight(a: LatLng, b: LatLng): boolean {
    const d = haversineKm(a, b);
    const n = Math.max(2, Math.ceil(d / 4));
    for (let i = 1; i < n; i++) if (!this.isSeaAt(interpolate(a, b, i / n))) return false;
    return true;
  }

  /** Weighted A* over the 8-connected grid (wraps at the antimeridian). */
  private search(sx: number, sy: number, tx: number, ty: number, weight = 1.35): number[] | null {
    const W = this.width;
    const key = (x: number, y: number) => y * W + x;
    const goal = this.center(tx, ty);
    const kmY = this.degY * 111.2;
    const g = new Map<number, number>();
    const parent = new Map<number, number>();
    const closed = new Set<number>();
    // Binary heap on (f, key)
    const hk: number[] = [], hf: number[] = [];
    const push = (k: number, f: number) => {
      let i = hk.length;
      hk.push(k);
      hf.push(f);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hf[p] <= f) break;
        hk[i] = hk[p];
        hf[i] = hf[p];
        i = p;
      }
      hk[i] = k;
      hf[i] = f;
    };
    const pop = () => {
      const top = hk[0];
      const lk = hk.pop()!, lf = hf.pop()!;
      const n = hk.length;
      if (n) {
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          if (l >= n) break;
          const r = l + 1;
          const c = r < n && hf[r] < hf[l] ? r : l;
          if (hf[c] >= lf) break;
          hk[i] = hk[c];
          hf[i] = hf[c];
          i = c;
        }
        hk[i] = lk;
        hf[i] = lf;
      }
      return top;
    };

    const start = key(sx, sy), target = key(tx, ty);
    g.set(start, 0);
    push(start, 0);
    let expanded = 0;
    while (hk.length) {
      const u = pop();
      if (u === target) break;
      if (closed.has(u)) continue;
      closed.add(u);
      if (++expanded > 2_500_000) return null;
      const ux = u % W, uy = (u - ux) / W;
      const gu = g.get(u)!;
      const kmX = kmY * Math.cos(((90 - (uy + 0.5) * this.degY) * Math.PI) / 180);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const vx = (ux + dx + W) % W, vy = uy + dy;
          if (!this.isSea(vx, vy)) continue;
          // No corner cutting through land.
          if (dx && dy && (!this.isSea(ux + dx, uy) || !this.isSea(ux, uy + dy))) continue;
          const v = key(vx, vy);
          if (closed.has(v)) continue;
          const c = gu + Math.hypot(dx * kmX, dy * kmY);
          if (c < (g.get(v) ?? Infinity)) {
            g.set(v, c);
            parent.set(v, u);
            push(v, c + weight * haversineKm(this.center(vx, vy), goal));
          }
        }
    }
    if (!parent.has(target) && start !== target) return null;
    const cells = [target];
    while (cells[cells.length - 1] !== start) cells.push(parent.get(cells[cells.length - 1])!);
    return cells.reverse();
  }

  /** Sea route between two ports, or an error if either is inland or no passage exists. */
  route(a: LatLng, b: LatLng, speeds: Speeds): TransportPath | { error: 'no-port-start' | 'no-port-end' | 'no-path' } {
    const pa = this.nearestSea(a);
    if (!pa) return { error: 'no-port-start' };
    const pb = this.nearestSea(b);
    if (!pb) return { error: 'no-port-end' };
    const cells = this.search(pa.x, pa.y, pb.x, pb.y);
    if (!cells) return { error: 'no-path' };
    const W = this.width;
    const raw = cells.map(k => this.center(k % W, Math.floor(k / W)));

    // String-pulling: keep only the waypoints needed for line of sight (segments ≤ 600 km).
    const smooth: LatLng[] = [raw[0]];
    let i = 0;
    while (i < raw.length - 1) {
      let j = i + 1;
      let lo = i + 1, hi = raw.length - 1;
      // Binary-search the farthest visible waypoint (visibility is near-monotonic on these paths).
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (haversineKm(raw[i], raw[mid]) <= 600 && this.lineOfSight(raw[i], raw[mid])) {
          j = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      smooth.push(raw[j]);
      i = j;
    }

    const points = [a, ...smooth, b];
    const cls: SegClass[] = points.slice(1).map((_, k) => (k === 0 || k === points.length - 2 ? SegClass.Access : SegClass.Fast));
    return pathFromPoints(points, cls, speeds);
  }
}

/** Great-circle air route, densified so it renders as a smooth arc. */
export function airRoute(a: LatLng, b: LatLng, speeds: Speeds): TransportPath {
  const d = haversineKm(a, b);
  const n = Math.max(2, Math.ceil(d / 80));
  const points = Array.from({ length: n + 1 }, (_, i) => interpolate(a, b, i / n));
  return pathFromPoints(points, new Array(n).fill(SegClass.Fast), speeds);
}
