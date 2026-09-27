// Network registry and route planner: turns (mode, stops) into physical paths, lazily loading the
// road/rail graph of the right region. I/O is injected so this runs in the browser and in Node tests.
import { haversineKm, type LatLng } from './geo';
import { TransportGraph, isPath, type GraphJson, type TransportPath } from './graph';
import { MODE_INFO, type Mode } from './modes';
import { SeaGrid, airRoute } from './sea';

export interface NetworkRegion {
  id: string;
  name: string;
  bbox: [number, number, number, number];
  road: string;
  rail: string;
}

export interface NetworksManifest {
  regions: NetworkRegion[];
  sea: { url: string; width: number; height: number };
}

export interface NetworkLoader {
  json<T>(url: string): Promise<T>;
  /** raw bytes, already gunzipped */
  bytes(url: string): Promise<Uint8Array>;
}

export interface PlanStop extends LatLng {
  name: string;
}

export type PlanResult = { ok: true; legs: TransportPath[] } | { ok: false; error: string; leg?: number };

/** Hand-picked expressway waypoints for well-known corridors (the pure fastest path differs). */
const CORRIDORS: { a: LatLng; b: LatLng; via: LatLng[] }[] = [
  // Tōmei → Meishin between Tokyo and Osaka (otherwise A* takes the Chūō / Meihan).
  {
    a: { lat: 35.68, lng: 139.77 },
    b: { lat: 34.7, lng: 135.5 },
    via: [
      { lat: 34.955, lng: 138.38 },
      { lat: 34.975, lng: 135.806 },
    ],
  },
];

function corridorVia(a: LatLng, b: LatLng): LatLng[] | undefined {
  const near = (p: LatLng, q: LatLng) => haversineKm(p, q) < 40;
  for (const c of CORRIDORS) {
    if (near(a, c.a) && near(b, c.b)) return c.via;
    if (near(a, c.b) && near(b, c.a)) return [...c.via].reverse();
  }
  return undefined;
}

export class Networks {
  private graphs = new Map<string, Promise<TransportGraph>>();
  private seaGrid: Promise<SeaGrid> | null = null;

  constructor(
    readonly manifest: NetworksManifest,
    private readonly loader: NetworkLoader,
  ) {}

  regionOf(p: LatLng): NetworkRegion | null {
    return (
      this.manifest.regions.find(r => p.lng >= r.bbox[0] && p.lng <= r.bbox[2] && p.lat >= r.bbox[1] && p.lat <= r.bbox[3]) ??
      null
    );
  }

  graph(kind: 'road' | 'rail', region: NetworkRegion): Promise<TransportGraph> {
    const key = `${kind}:${region.id}`;
    let g = this.graphs.get(key);
    if (!g) {
      const speeds = MODE_INFO[kind === 'road' ? 'bus' : 'rail'].speedKmh;
      g = this.loader.json<GraphJson>(region[kind]).then(json => new TransportGraph(json, speeds));
      this.graphs.set(key, g);
    }
    return g;
  }

  sea(): Promise<SeaGrid> {
    if (!this.seaGrid) {
      const { url, width, height } = this.manifest.sea;
      this.seaGrid = this.loader.bytes(url).then(bits => new SeaGrid(bits, width, height));
    }
    return this.seaGrid;
  }

  /** Can this mode serve this city at all? (for greying out cities in the route builder) */
  async serves(mode: Mode, p: LatLng): Promise<boolean> {
    if (mode === 'air') return true;
    if (mode === 'ship') return !!(await this.sea()).nearestSea(p);
    const region = this.regionOf(p);
    if (!region) return false;
    const g = await this.graph(mode === 'bus' ? 'road' : 'rail', region);
    return !!g.snap(p, mode === 'bus' ? 30 : 40);
  }

  async planLeg(mode: Mode, a: PlanStop, b: PlanStop): Promise<TransportPath | string> {
    const info = MODE_INFO[mode];
    const gc = haversineKm(a, b);
    if (gc < info.minDistanceKm) return `${a.name}–${b.name} は${info.name}には近すぎます（${Math.round(gc)} km）`;

    if (mode === 'air') return airRoute(a, b, info.speedKmh);

    if (mode === 'ship') {
      const r = (await this.sea()).route(a, b, info.speedKmh);
      if (isPath(r)) return r;
      if (r.error === 'no-port-start') return `${a.name}は港がありません（海から遠い）`;
      if (r.error === 'no-port-end') return `${b.name}は港がありません（海から遠い）`;
      return `${a.name}–${b.name} の航路が見つかりません`;
    }

    const ra = this.regionOf(a), rb = this.regionOf(b);
    const what = mode === 'bus' ? '道路網' : '鉄道網';
    if (!ra) return `${a.name}周辺には${what}データがありません（日本・東アジア／ヨーロッパ／北米のみ）`;
    if (!rb) return `${b.name}周辺には${what}データがありません（日本・東アジア／ヨーロッパ／北米のみ）`;
    if (ra.id !== rb.id) return `${a.name}と${b.name}は別の${what}にあります`;
    const g = await this.graph(mode === 'bus' ? 'road' : 'rail', ra);
    const via = mode === 'bus' ? corridorVia(a, b) : undefined;
    const r = g.route(a, b, { via, maxSnapKm: mode === 'bus' ? 30 : 40 });
    if (isPath(r)) return r;
    if (r.error === 'snap-start') return `${a.name}の近くに${mode === 'bus' ? '道路' : '線路'}がありません`;
    if (r.error === 'snap-end') return `${b.name}の近くに${mode === 'bus' ? '道路' : '線路'}がありません`;
    return `${a.name}–${b.name} は${what}でつながっていません（海を越える区間など）`;
  }

  async plan(mode: Mode, stops: PlanStop[]): Promise<PlanResult> {
    if (stops.length < 2) return { ok: false, error: '停留所を2つ以上選んでください' };
    const legs: TransportPath[] = [];
    for (let i = 1; i < stops.length; i++) {
      const r = await this.planLeg(mode, stops[i - 1], stops[i]);
      if (typeof r === 'string') return { ok: false, error: r, leg: i - 1 };
      legs.push(r);
    }
    return { ok: true, legs };
  }
}
