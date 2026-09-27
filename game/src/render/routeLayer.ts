// Routes drawn with three-globe's paths layer, draped over the displaced terrain.
import * as THREE from 'three';
import type ThreeGlobe from 'three-globe';
import { interpolate, haversineKm, type LatLng } from '../sim/geo';
import type { Terrain } from './terrain';

export interface RouteDrawing {
  id: string;
  color: string;
  points: LatLng[];
}

type PathPoint = [lat: number, lng: number, alt: number];

interface PathDatum {
  kind: 'casing' | 'line' | 'flow' | 'flow-back';
  route: RouteDrawing;
  points: PathPoint[];
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

const LIFT: Record<PathDatum['kind'], number> = {
  casing: 0.000012,
  line: 0.000016,
  flow: 0.00002,
  'flow-back': 0.00002,
};

export class RouteLayer {
  private routes: RouteDrawing[] = [];
  private dense = new Map<string, LatLng[]>();

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
      .pathColor((d: object) => {
        const { kind, route } = d as PathDatum;
        if (kind === 'casing') return 'rgba(8,16,28,0.75)';
        if (kind === 'line') return route.color;
        return 'rgba(255,255,255,0.95)';
      })
      .pathStroke((d: object) => ({ casing: 7, line: 4, flow: 1.6, 'flow-back': 1.6 })[(d as PathDatum).kind])
      .pathDashLength((d: object) => ((d as PathDatum).kind.startsWith('flow') ? 0.006 : 1))
      .pathDashGap((d: object) => ((d as PathDatum).kind.startsWith('flow') ? 0.024 : 0))
      .pathDashInitialGap((d: object) => ((d as PathDatum).kind === 'flow-back' ? 0.015 : 0))
      .pathDashAnimateTime((d: object) => ((d as PathDatum).kind.startsWith('flow') ? 60_000 : 0));
  }

  setRoutes(routes: RouteDrawing[]) {
    this.routes = routes;
    this.dense = new Map(routes.map(r => [r.id, densify(r.points, 1.2)]));
    this.rebuild();
  }

  /** Recompute altitudes (e.g. after changing terrain exaggeration). */
  rebuild() {
    const data: PathDatum[] = [];
    for (const route of this.routes) {
      const pts = this.dense.get(route.id)!;
      const base = pts.map(p => this.terrain.altitudeAt(p.lat, p.lng));
      const at = (kind: PathDatum['kind'], reverse = false): PathDatum => {
        const list = pts.map((p, i): PathPoint => [p.lat, p.lng, base[i] + LIFT[kind]]);
        return { kind, route, points: reverse ? list.reverse() : list };
      };
      data.push(at('casing'), at('line'), at('flow'), at('flow-back', true));
    }
    this.globe.pathsData(data);
  }

  /**
   * three-globe builds path objects asynchronously; once they exist, draw them as ordered overlays
   * (no depth writes, fixed render order) so casing, line and flow never z-fight each other.
   */
  fixDrawOrder() {
    const order: Record<PathDatum['kind'], number> = { casing: 10, line: 11, flow: 12, 'flow-back': 12 };
    this.globe.traverse(o => {
      const d = (o as unknown as { __data?: PathDatum }).__data;
      if (!d?.kind || !(d.kind in order)) return;
      o.traverse(child => {
        const m = (child as THREE.Mesh).material as THREE.Material | undefined;
        if (!m || child.renderOrder === order[d.kind]) return;
        child.renderOrder = order[d.kind];
        m.transparent = true;
        m.depthWrite = false;
      });
    });
  }

  setResolution(width: number, height: number) {
    this.globe.rendererSize(new THREE.Vector2(width, height));
  }
}
