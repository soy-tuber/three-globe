import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  Polyline,
  RoadClass,
  RoadGraph,
  Simulation,
  captureShare,
  createRoute,
  haversineKm,
  marketTripsPerDay,
  profit,
  referenceFare,
  HOURLY_PROFILE,
  type RoadGraphJson,
} from '../src/sim';
import { CITIES } from '../src/data/cities';

const city = (id: string) => CITIES.find(c => c.id === id)!;

describe('geo', () => {
  it('haversine: Tokyo–Osaka is ~400 km as the crow flies', () => {
    const d = haversineKm(city('tokyo'), city('osaka'));
    expect(d).toBeGreaterThan(395);
    expect(d).toBeLessThan(410);
  });

  it('polyline lookups are monotonic and clamp at the ends', () => {
    const line = new Polyline([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
      { lat: 1, lng: 1 },
    ]);
    expect(line.lengthKm).toBeCloseTo(111.19 * 2, 0);
    expect(line.pointAt(-5).pos).toEqual({ lat: 0, lng: 0 });
    expect(line.pointAt(1e9).pos.lat).toBeCloseTo(1, 6);
    const mid = line.pointAt(line.lengthKm / 4);
    expect(mid.pos.lng).toBeCloseTo(0.5, 3);
    expect(mid.headingDeg).toBeCloseTo(90, 1);
    expect(line.pointAt(line.lengthKm * 0.75).headingDeg).toBeCloseTo(0, 1);
  });
});

describe('road graph', () => {
  // a — b — c   and a slow detour a — d — c
  const json: RoadGraphJson = {
    bbox: [0, 0, 2, 2],
    nodes: [0, 0, 1, 0, 2, 0, 1, 0.5],
    edges: [0, 1, RoadClass.Expressway, 1, 2, RoadClass.Expressway, 0, 3, RoadClass.Minor, 3, 2, RoadClass.Minor],
  };
  const g = new RoadGraph(json);

  it('finds the fastest path', () => {
    expect(g.shortestPath(0, 2)).toEqual([0, 1, 2]);
  });

  it('routes between arbitrary points with access legs', () => {
    const r = g.route({ lat: 0.01, lng: -0.01 }, { lat: -0.01, lng: 2.01 })!;
    expect(r.points.length).toBe(5);
    expect(r.segmentClass[0]).toBe(RoadClass.Access);
    expect(r.segmentClass[1]).toBe(RoadClass.Expressway);
    expect(r.lengthKm).toBeGreaterThan(222);
  });

  it('real network: Tokyo → Osaka is ~500 km, mostly expressway', () => {
    const file = path.resolve(import.meta.dirname, '../public/assets/data/roads-japan.json');
    const real = new RoadGraph(JSON.parse(fs.readFileSync(file, 'utf8')));
    const r = real.route(city('tokyo'), city('osaka'))!;
    expect(r).not.toBeNull();
    expect(r.lengthKm).toBeGreaterThan(480);
    expect(r.lengthKm).toBeLessThan(580);
    const leg = createRoute({ id: 'x', name: 'x', color: '#fff', stops: ['tokyo', 'osaka'], paths: [r] }).legs[0];
    expect(leg.expresswayKm / leg.lengthKm).toBeGreaterThan(0.7);

    // Via-points force the Tōmei/Meishin: the path must pass Shizuoka and Kyoto.
    const tomei = real.routeVia(city('tokyo'), [{ lat: 34.955, lng: 138.38 }, { lat: 34.975, lng: 135.806 }], city('osaka'))!;
    const near = (id: string) => Math.min(...tomei.points.map(p => haversineKm(p, city(id))));
    expect(near('shizuoka')).toBeLessThan(12);
    expect(near('hamamatsu')).toBeLessThan(12);
    expect(near('kyoto')).toBeLessThan(12);
    expect(tomei.lengthKm).toBeLessThan(600);
  });
});

describe('demand', () => {
  it('hourly profile averages to 1', () => {
    expect(HOURLY_PROFILE.reduce((a, b) => a + b, 0) / 24).toBeCloseTo(1, 9);
  });

  it('gravity model is calibrated and symmetric', () => {
    const t = city('tokyo'), o = city('osaka');
    const m = marketTripsPerDay(t.population, o.population, 510);
    expect(m).toBeGreaterThan(6000);
    expect(m).toBeLessThan(10000);
    expect(marketTripsPerDay(o.population, t.population, 510)).toBeCloseTo(m, 6);
  });

  it('share falls as fares rise and grows with frequency', () => {
    const ref = referenceFare(500);
    expect(captureShare(ref * 0.8, 500, 4)).toBeGreaterThan(captureShare(ref, 500, 4));
    expect(captureShare(ref * 1.5, 500, 4)).toBeLessThan(captureShare(ref, 500, 4) / 2);
    expect(captureShare(ref, 500, 12)).toBeGreaterThan(captureShare(ref, 500, 2));
  });
});

describe('simulation', () => {
  function straightRoute() {
    // A straight 100 km expressway between Tokyo and a fake stop east of it keeps timing predictable.
    const a = city('tokyo'), b = city('chiba');
    const points = [a, { lat: a.lat, lng: a.lng + 0.55 }, { lat: b.lat, lng: b.lng }];
    const lengthKm = haversineKm(points[0], points[1]) + haversineKm(points[1], points[2]);
    return createRoute({
      id: 'r1',
      name: '東京–千葉',
      color: '#f80',
      stops: ['tokyo', 'chiba'],
      paths: [{ points, segmentClass: Uint8Array.from([0, 0]), lengthKm, durationMin: 0 }],
    });
  }

  function makeSim(seed = 1) {
    const sim = new Simulation({
      seed,
      startMs: Date.UTC(2026, 3, 1, 21, 0), // 06:00 JST
      cities: CITIES,
      companyName: 'Test',
      startingCash: 1_000_000,
    });
    sim.addRoute(straightRoute());
    sim.buyVehicle('r1', 'microbus-28', { free: true });
    return sim;
  }

  it('vehicle shuttles between stops, earning fares and paying costs', () => {
    const sim = makeSim();
    const events = [] as ReturnType<typeof sim.drainEvents>;
    for (let i = 0; i < 12; i++) {
      sim.advance(60);
      events.push(...sim.drainEvents());
    }
    const arrivals = events.filter(e => e.type === 'arrival');
    expect(arrivals.map(e => e.type === 'arrival' && e.cityId).slice(0, 3)).toEqual(['chiba', 'tokyo', 'chiba']);
    expect(sim.company.totals.passengers).toBeGreaterThan(0);
    expect(sim.company.today.income.fare).toBeGreaterThan(0);
    expect(sim.company.today.expense.fuel).toBeGreaterThan(0);
    expect(sim.company.today.expense.toll).toBeGreaterThan(0);
    const v = [...sim.vehicles.values()][0];
    expect(v.odometerKm).toBeGreaterThan(100);
  });

  it('a single bus on Tokyo–Osaka fills up and turns a daily profit', () => {
    const sim = new Simulation({ startMs: Date.UTC(2026, 2, 31, 21, 0), cities: CITIES, companyName: 'T', startingCash: 0 });
    const file = path.resolve(import.meta.dirname, '../public/assets/data/roads-japan.json');
    const roads = new RoadGraph(JSON.parse(fs.readFileSync(file, 'utf8')));
    const p = roads.routeVia(city('tokyo'), [{ lat: 34.955, lng: 138.38 }, { lat: 34.975, lng: 135.806 }], city('osaka'))!;
    sim.addRoute(createRoute({ id: 'r', name: 'r', color: '#f80', stops: ['tokyo', 'osaka'], paths: [p] }));
    sim.buyVehicle('r', 'microbus-28', { free: true, firstDepartureInMin: 60 });
    const loads: number[] = [];
    for (let i = 0; i < 24 * 5; i++) {
      sim.advance(60);
      for (const e of sim.drainEvents()) if (e.type === 'departure') loads.push(e.onboard);
    }
    const avgLoad = loads.slice(1).reduce((a, b) => a + b, 0) / (loads.length - 1);
    expect(avgLoad).toBeGreaterThan(20);
    const days = sim.company.history.slice(1).map(profit);
    expect(Math.min(...days)).toBeGreaterThan(0);
  });

  it('cash equals starting cash plus income minus expenses', () => {
    const sim = makeSim();
    for (let i = 0; i < 72; i++) sim.advance(60);
    const net = sim.company.totals.revenue - sim.company.totals.expense;
    expect(sim.company.cash).toBeCloseTo(1_000_000 + net, 3);
    expect(sim.company.history.length).toBeGreaterThanOrEqual(2);
    const days = sim.company.history.map(profit);
    expect(days.every(Number.isFinite)).toBe(true);
  });

  it('is deterministic for a given seed', () => {
    const a = makeSim(42), b = makeSim(42);
    a.advance(2000);
    b.advance(2000);
    expect(a.company.cash).toBe(b.company.cash);
    expect(a.company.totals.passengers).toBe(b.company.totals.passengers);
  });

  it('capacity is never exceeded', () => {
    const sim = makeSim(7);
    for (let i = 0; i < 400; i++) {
      sim.advance(7);
      for (const v of sim.vehicles.values()) {
        const n = Object.values(v.onboard).reduce((x, y) => x + y, 0);
        expect(n).toBeLessThanOrEqual(28);
      }
    }
  });

  it('pose interpolates smoothly along the road', () => {
    const sim = makeSim();
    sim.advance(25); // past the 20-minute dwell
    const p1 = sim.pose('v1')!;
    sim.advance(0.1);
    const p2 = sim.pose('v1')!;
    expect(p1.status).toBe('drive');
    expect(haversineKm(p1.pos, p2.pos)).toBeLessThan(0.5);
    expect(p1.headingDeg).toBeGreaterThan(45);
    expect(p1.headingDeg).toBeLessThan(135);
  });
});

describe('fleet', () => {
  it('a vehicle bought at the far terminal heads back toward the start', () => {
    const a = CITIES.find(c => c.id === 'tokyo')!, b = CITIES.find(c => c.id === 'chiba')!;
    const sim = new Simulation({ startMs: 0, cities: CITIES, companyName: 'T', startingCash: 1e8 });
    sim.addRoute(
      createRoute({
        id: 'r',
        name: 'r',
        color: '#fff',
        stops: ['tokyo', 'chiba'],
        paths: [{ points: [a, b], segmentClass: Uint8Array.from([0]), lengthKm: haversineKm(a, b), durationMin: 0 }],
      }),
    );
    const v = sim.buyVehicle('r', 'microbus-28', { startStop: 1 });
    expect(v.dir).toBe(-1);
    expect(sim.company.cash).toBe(1e8 - 14_000_000);
    const arrivals: string[] = [];
    for (let i = 0; i < 6; i++) {
      sim.advance(30);
      for (const e of sim.drainEvents()) if (e.type === 'arrival') arrivals.push(e.cityId);
    }
    expect(arrivals[0]).toBe('tokyo');
  });
});
