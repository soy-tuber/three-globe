// Routes drawn with three-globe's paths layer: draped over the terrain for land modes, dashed lanes
// at sea, and raised arcs for flights (the same altitude profile the aircraft fly).
import * as THREE from 'three';
import type ThreeGlobe from 'three-globe';
import { haversineKm, interpolate, type LatLng } from '../sim/geo';
import { airAltitude01, airCruiseAltitude, type Mode } from '../sim/modes';
import type { Terrain } from './terrain';

export interface RouteDrawing {
  id: string;
  color: string;
  mode: Mode;
  /** geometry per leg */
  legs: LatLng[][];
}

type PathPoint = [lat: number, lng: number, alt: number];

interface PathDatum {
  routeId: string;
  points: PathPoint[];
  color: string;
  stroke: number;
  dash: number;
  gap: number;
  initialGap: number;
  animateMs: number;
  order: number;
}

/** Subdivide so no segment is longer than maxKm (keeps the line hugging the terrain). */
function densify(points: LatLng[], maxKm: number): LatLng[] {
  const out: LatLng[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const n = Math.ceil(haversineKm(a, b) / maxKm);
    for (let k = 1; k <= n; k++) out.push(k === n ? b : interpolate(a, b, k / n));
  }
  return out;
}

const withAlpha = (hex: string, a: number) => {
  const c = new THREE.Color(hex);
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
};

export class RouteLayer {
  private routes: RouteDrawing[] = [];
  private preview: RouteDrawing | null = null;
  private selectedId: string | null = null;
  /** densified geometry + base altitudes, cached per route id */
  private cache = new Map<string, { legs: LatLng[][]; ground: number[][] }>();

  constructor(
    private readonly globe: ThreeGlobe,
    private readonly terrain: Terrain,
  ) {
    globe
      .pathPoints((d: object) => (d as PathDatum).points)
      .pathPointLat((p: PathPoint) => p[0])
      .pathPointLng((p: PathPoint) => p[1])
      .pathPointAlt((p: PathPoint) => p[2])
      .pathResolution(0.05)
      .pathTransitionDuration(0)
      .pathColor((d: object) => (d as PathDatum).color)
      .pathStroke((d: object) => (d as PathDatum).stroke)
      .pathDashLength((d: object) => (d as PathDatum).dash)
      .pathDashGap((d: object) => (d as PathDatum).gap)
      .pathDashInitialGap((d: object) => (d as PathDatum).initialGap)
      .pathDashAnimateTime((d: object) => (d as PathDatum).animateMs);
  }

  setRoutes(routes: RouteDrawing[]) {
    this.routes = routes;
    const ids = new Set(routes.map(r => r.id));
    for (const k of this.cache.keys()) if (!ids.has(k) && k !== '__preview') this.cache.delete(k);
    this.rebuild();
  }

  setSelected(id: string | null) {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.rebuild();
  }

  setPreview(route: RouteDrawing | null) {
    this.preview = route;
    this.cache.delete('__preview');
    this.rebuild();
  }

  /** Recompute altitudes (e.g. after changing terrain exaggeration). */
  invalidate() {
    this.cache.clear();
    this.rebuild();
  }

  private geometry(r: RouteDrawing, key = r.id) {
    let g = this.cache.get(key);
    if (!g) {
      const legs = r.legs.map(l => densify(l, r.mode === 'air' ? 40 : r.mode === 'ship' ? 8 : 1.2));
      const ground = legs.map(l => l.map(p => this.terrain.altitudeAt(p.lat, p.lng)));
      g = { legs, ground };
      this.cache.set(key, g);
    }
    return g;
  }

  private build(r: RouteDrawing, key: string, preview: boolean): PathDatum[] {
    const { legs, ground } = this.geometry(r, key);
    const selected = r.id === this.selectedId;
    const out: PathDatum[] = [];
    const add = (lift: number, style: Omit<PathDatum, 'routeId' | 'points'>, reverse = false) => {
      for (let li = 0; li < legs.length; li++) {
        const pts = legs[li];
        let along = 0;
        const L = r.mode === 'air' ? pts.reduce((a, p, i) => (i ? a + haversineKm(pts[i - 1], p) : 0), 0) : 0;
        const list: PathPoint[] = pts.map((p, i) => {
          if (i) along += haversineKm(pts[i - 1], p);
          const air = r.mode === 'air' ? airAltitude01(along, L) * airCruiseAltitude(L) : 0;
          return [p.lat, p.lng, ground[li][i] + air + lift];
        });
        out.push({ routeId: r.id, points: reverse ? list.reverse() : list, ...style });
      }
    };

    if (preview) {
      add(0.000014, { color: 'rgba(8,16,28,0.7)', stroke: 6, dash: 1, gap: 0, initialGap: 0, animateMs: 0, order: 20 });
      add(0.00002, { color: '#ffffff', stroke: 3, dash: 0.01, gap: 0.008, initialGap: 0, animateMs: 30_000, order: 21 });
      return out;
    }

    const w = selected ? 1.5 : 1;
    const base = selected ? 14 : 10;
    const flow = { color: 'rgba(255,255,255,0.9)', stroke: 1.5 * w, dash: 0.006, gap: 0.024, initialGap: 0, animateMs: 60_000, order: base + 2 };
    if (r.mode === 'air') {
      add(0.00001, { color: withAlpha(r.color, selected ? 0.95 : 0.7), stroke: 2.2 * w, dash: 1, gap: 0, initialGap: 0, animateMs: 0, order: base + 1 });
      add(0.000012, { ...flow, dash: 0.01, gap: 0.03 });
    } else if (r.mode === 'ship') {
      add(0.000008, { color: withAlpha(r.color, 0.9), stroke: 3 * w, dash: 0.012, gap: 0.008, initialGap: 0, animateMs: 0, order: base + 1 });
      add(0.00001, { ...flow, dash: 0.004, gap: 0.03 });
    } else {
      add(0.000012, { color: 'rgba(8,16,28,0.75)', stroke: (r.mode === 'rail' ? 6 : 7) * w, dash: 1, gap: 0, initialGap: 0, animateMs: 0, order: base });
      add(0.000016, { color: r.color, stroke: (r.mode === 'rail' ? 3 : 4) * w, dash: 1, gap: 0, initialGap: 0, animateMs: 0, order: base + 1 });
      if (r.mode === 'rail')
        // Railway "ties": short white ticks over the coloured line.
        add(0.00002, { color: 'rgba(255,255,255,0.85)', stroke: 1.4 * w, dash: 0.002, gap: 0.004, initialGap: 0, animateMs: 0, order: base + 2 });
      else {
        add(0.00002, flow);
        add(0.00002, { ...flow, initialGap: 0.015 }, true);
      }
    }
    return out;
  }

  private rebuild() {
    const data: PathDatum[] = [];
    for (const r of this.routes) data.push(...this.build(r, r.id, false));
    if (this.preview) data.push(...this.build(this.preview, '__preview', true));
    this.globe.pathsData(data);
    // three-globe digests data on its next tick; fix the draw order as soon as objects exist.
    for (const ms of [0, 50, 250]) setTimeout(() => this.fixDrawOrder(), ms);
  }

  /**
   * three-globe builds path objects asynchronously; once they exist, draw them as ordered overlays
   * (no depth writes, fixed render order) so casing, line and flow never z-fight each other.
   */
  fixDrawOrder() {
    this.globe.traverse(o => {
      const d = (o as unknown as { __data?: PathDatum }).__data;
      if (d?.order === undefined || d.points === undefined) return;
      o.traverse(child => {
        const m = (child as THREE.Mesh).material as THREE.Material | undefined;
        if (!m || child.renderOrder === d.order) return;
        child.renderOrder = d.order;
        m.transparent = true;
        m.depthWrite = false;
      });
    });
  }

  setResolution(width: number, height: number) {
    this.globe.rendererSize(new THREE.Vector2(width, height));
  }
}
