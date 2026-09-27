import { describe, expect, it } from 'vitest';
import {
  HOURLY_PROFILE,
  Polyline,
  SegClass,
  Simulation,
  TransportGraph,
  captureShares,
  createRoute,
  haversineKm,
  isPath,
  marketTripsPerDay,
  pathFromPoints,
  profit,
  MODE_INFO,
  type GraphJson,
  type ServiceOffer,
} from '../src/sim';
import { ALL_CITIES, city, loadNetworks } from './helpers';

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

describe('transport graph', () => {
  // 0 ──fast (via a bend)── 1 ──fast── 2, plus a slow detour 0 ── 3 ── 2
  const json: GraphJson = {
    bbox: [0, -1, 3, 1],
    nodes: [0, 0, 1, 0, 2, 0, 1, 0.6],
    edges: [0, 1, 0, 0, 1, 1, 2, 0, 1, 0, 0, 3, 2, 1, 0, 3, 2, 2, 1, 0],
    points: [0.5, 0.05],
  };
  const g = new TransportGraph(json, MODE_INFO.bus.speedKmh);

  it('snaps to the middle of an edge', () => {
    const s = g.snap({ lat: 0.1, lng: 1.5 }, 30)!;
    expect(s.point.lat).toBeCloseTo(0, 6);
    expect(s.point.lng).toBeCloseTo(1.5, 6);
  });

  it('routes between mid-edge points along the fast line, keeping edge geometry', () => {
    const r = g.route({ lat: 0.05, lng: 0.2 }, { lat: -0.05, lng: 1.8 });
    expect(isPath(r)).toBe(true);
    if (!isPath(r)) return;
    expect(r.points.some(p => p.lng === 0.5 && p.lat === 0.05)).toBe(true); // bend vertex
    expect(r.points.some(p => p.lat > 0.3)).toBe(false); // not the detour
    expect(r.segmentClass[0]).toBe(SegClass.Access);
    expect(r.segmentClass[1]).toBe(SegClass.Fast);
  });

  it('routes along a single edge in either direction', () => {
    const f = g.route({ lat: 0, lng: 1.2 }, { lat: 0, lng: 1.7 });
    const b = g.route({ lat: 0, lng: 1.7 }, { lat: 0, lng: 1.2 });
    expect(isPath(f) && isPath(b)).toBe(true);
    if (isPath(f) && isPath(b)) {
      expect(f.lengthKm).toBeCloseTo(b.lengthKm, 6);
      expect(f.lengthKm).toBeCloseTo(0.5 * 111.19, 0);
    }
  });

  it('reports unreachable snaps', () => {
    expect(g.route({ lat: 10, lng: 10 }, { lat: 0, lng: 1 })).toEqual({ error: 'snap-start' });
  });
});

describe('networks (real data)', () => {
  const nets = loadNetworks();
  const stop = (id: string) => ({ ...city(id), name: city(id).name });

  it('bus Tokyo → Osaka follows the Tōmei/Meishin (~550 km, mostly expressway)', async () => {
    const r = await nets.planLeg('bus', stop('tokyo'), stop('osaka'));
    if (typeof r === 'string') throw new Error(r);
    expect(r.lengthKm).toBeGreaterThan(480);
    expect(r.lengthKm).toBeLessThan(600);
    const near = (id: string) => Math.min(...r.points.map(p => haversineKm(p, city(id))));
    expect(near('shizuoka')).toBeLessThan(12);
    expect(near('kyoto')).toBeLessThan(12);
  });

  it('rail, air and sea routes between Japanese cities', async () => {
    const rail = await nets.planLeg('rail', stop('tokyo'), stop('sendai'));
    if (typeof rail === 'string') throw new Error(rail);
    expect(rail.lengthKm).toBeGreaterThan(300);
    expect(rail.lengthKm).toBeLessThan(450);

    const air = await nets.planLeg('air', stop('tokyo'), stop('Seoul'));
    if (typeof air === 'string') throw new Error(air);
    expect(air.lengthKm).toBeCloseTo(haversineKm(city('tokyo'), city('Seoul')), 0);

    const t0 = Date.now();
    const sea = await nets.planLeg('ship', stop('osaka'), stop('fukuoka'));
    if (typeof sea === 'string') throw new Error(sea);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(sea.lengthKm).toBeGreaterThan(450);
    expect(sea.lengthKm).toBeLessThan(900);
    const grid = await nets.sea();
    // Interior of the path stays at sea.
    const inner = sea.points.slice(2, -2);
    expect(inner.filter(p => !grid.isSeaAt(p)).length).toBe(0);
  });

  it('explains why impossible routes fail', async () => {
    expect(await nets.planLeg('bus', stop('tokyo'), stop('sapporo'))).toMatch(/つながっていません/);
    expect(await nets.planLeg('bus', stop('tokyo'), stop('London'))).toMatch(/別の道路網|データがありません/);
    expect(await nets.planLeg('ship', stop('nagano'), stop('niigata'))).toMatch(/港がありません/);
    expect(await nets.planLeg('air', stop('tokyo'), stop('yokohama'))).toMatch(/近すぎます/);
  });

  it('long-haul sea route across the Pacific', async () => {
    const t0 = Date.now();
    const r = await nets.planLeg('ship', stop('yokohama'), stop('Los Angeles'));
    if (typeof r === 'string') throw new Error(r);
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(r.lengthKm).toBeGreaterThan(8500);
    expect(r.lengthKm).toBeLessThan(11000);
  }, 30000);
});

describe('demand', () => {
  it('hourly profile averages to 1', () => {
    expect(HOURLY_PROFILE.reduce((a, b) => a + b, 0) / 24).toBeCloseTo(1, 9);
  });

  it('gravity market is symmetric', () => {
    const t = city('tokyo'), o = city('osaka');
    const m = marketTripsPerDay(t.population, o.population, 400);
    expect(m).toBeGreaterThan(8000);
    expect(m).toBeLessThan(13000);
    expect(marketTripsPerDay(o.population, t.population, 400)).toBeCloseTo(m, 6);
  });

  it('shares react to fare, frequency and competition between our own routes', () => {
    const base: ServiceOffer = { mode: 'bus', fare: 6500, rideHours: 6.5, departuresPerDay: 3 };
    const [s] = captureShares([base], 400);
    expect(captureShares([{ ...base, fare: 9000 }], 400)[0]).toBeLessThan(s);
    expect(captureShares([{ ...base, departuresPerDay: 12 }], 400)[0]).toBeGreaterThan(s);
    const pair = captureShares([base, base], 400);
    expect(pair[0] + pair[1]).toBeLessThan(2 * s);
    expect(pair[0] + pair[1]).toBeGreaterThan(s);
    // Air beats a slow bus over 1,000 km.
    const [bus, air] = captureShares(
      [
        { mode: 'bus', fare: 11000, rideHours: 13, departuresPerDay: 3 },
        { mode: 'air', fare: 18000, rideHours: 1.6, departuresPerDay: 3 },
      ],
      1000,
    );
    expect(air).toBeGreaterThan(bus * 3);
  });
});

describe('simulation', () => {
  const straight = () => {
    const a = city('tokyo'), b = city('chiba');
    const points = [a, { lat: a.lat, lng: a.lng + 0.2 }, { lat: b.lat, lng: b.lng }];
    return pathFromPoints(points, [SegClass.Fast, SegClass.Fast], MODE_INFO.bus.speedKmh);
  };

  function makeSim(seed = 1, cash = 1_000_000_000) {
    const sim = new Simulation({ seed, startMs: Date.UTC(2026, 2, 31, 21, 0), cities: ALL_CITIES, companyName: 'T', startingCash: cash });
    const res = sim.openRoute({ name: '東京–千葉', color: '#f80', mode: 'bus', stops: ['tokyo', 'chiba'], paths: [straight()], modelId: 'microbus-28', free: true });
    if (typeof res === 'string') throw new Error(res);
    return { sim, route: res.route, bus: res.vehicles[0] };
  }

  it('vehicle shuttles between stops, earning fares and paying costs', () => {
    const { sim, bus } = makeSim();
    const events = [] as ReturnType<typeof sim.drainEvents>;
    for (let i = 0; i < 12; i++) {
      sim.advance(60);
      events.push(...sim.drainEvents());
    }
    const arrivals = events.flatMap(e => (e.type === 'arrival' ? [e.cityId] : []));
    expect(arrivals.slice(0, 3)).toEqual(['chiba', 'tokyo', 'chiba']);
    expect(sim.company.totals.passengers).toBeGreaterThan(0);
    expect(sim.company.today.income.fare).toBeGreaterThan(0);
    expect(sim.company.today.expense.fuel).toBeGreaterThan(0);
    expect(sim.company.today.expense.toll).toBeGreaterThan(0);
    expect(bus.odometerKm).toBeGreaterThan(100);
  });

  it('cash equals starting cash plus income minus expenses', () => {
    const { sim } = makeSim(1, 1_000_000);
    for (let i = 0; i < 72; i++) sim.advance(60);
    const net = sim.company.totals.revenue - sim.company.totals.expense;
    expect(sim.company.cash).toBeCloseTo(1_000_000 + net, 3);
    expect(sim.company.history.length).toBeGreaterThanOrEqual(2);
    expect(sim.company.history.map(profit).every(Number.isFinite)).toBe(true);
  });

  it('is deterministic for a given seed', () => {
    const a = makeSim(42).sim, b = makeSim(42).sim;
    for (let i = 0; i < 20; i++) a.advance(100), b.advance(100);
    expect(a.company.cash).toBe(b.company.cash);
    expect(a.company.totals.passengers).toBe(b.company.totals.passengers);
  });

  it('capacity is never exceeded', () => {
    const { sim } = makeSim(7);
    for (let i = 0; i < 400; i++) {
      sim.advance(7);
      for (const v of sim.vehicles.values()) expect(Object.values(v.onboard).reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(28);
    }
  });

  it('pose interpolates smoothly along the road; trailing cars sit behind', () => {
    const { sim, bus } = makeSim();
    sim.advance(25);
    const p1 = sim.pose(bus.id)!;
    sim.advance(0.1);
    const p2 = sim.pose(bus.id)!;
    expect(p1.status).toBe('drive');
    expect(haversineKm(p1.pos, p2.pos)).toBeLessThan(0.5);
    expect(p1.headingDeg).toBeGreaterThan(45);
    expect(p1.headingDeg).toBeLessThan(135);
    const behind = sim.pose(bus.id, 1)!;
    expect(haversineKm(behind.pos, p2.pos)).toBeCloseTo(1, 0);
  });

  it('openRoute validates mode, range and cash; closeRoute refunds half', () => {
    const { sim, route } = makeSim(1, 20_000_000);
    const air = { lat: 0, lng: 0 };
    const long = pathFromPoints([air, { lat: 0, lng: 30 }], [SegClass.Fast], MODE_INFO.air.speedKmh);
    const base = { name: 'x', color: '#fff', stops: ['tokyo', 'naha'], paths: [long] };
    expect(sim.openRoute({ ...base, mode: 'air', modelId: 'microbus-28' })).toMatch(/使えません/);
    expect(sim.openRoute({ ...base, mode: 'air', modelId: 'turboprop-70', free: true })).toMatch(/航続距離/);
    expect(sim.openRoute({ ...base, mode: 'air', modelId: 'jet-180' })).toMatch(/資金/);

    sim.buyVehicle(route.id, 'microbus-28');
    const cash = sim.company.cash;
    const refund = sim.closeRoute(route.id);
    expect(refund).toBe(14_000_000); // 2 buses × ¥14M × 50%
    expect(sim.company.cash).toBe(cash + refund);
    expect(sim.routes.size).toBe(0);
    expect(sim.vehicles.size).toBe(0);
    expect(sim.drainEvents().some(e => e.type === 'routeClosed')).toBe(true);
  });

  it('a vehicle bought at the far terminal heads back toward the start', () => {
    const { sim, route } = makeSim();
    const v = sim.buyVehicle(route.id, 'microbus-28', { startStop: 1 });
    expect(v.dir).toBe(-1);
    const arrivals: string[] = [];
    for (let i = 0; i < 6; i++) {
      sim.advance(30);
      for (const e of sim.drainEvents()) if (e.type === 'arrival' && e.vehicleId === v.id) arrivals.push(e.cityId);
    }
    expect(arrivals[0]).toBe('tokyo');
  });

  it('goals complete and pay their reward once', () => {
    const { sim } = makeSim(3, 0);
    for (let i = 0; i < 24 * 4; i++) sim.advance(60);
    expect(sim.goals.completed).toContain('first-profit');
    const rewards = sim.company.history.reduce((a, d) => a + (d.income.reward ?? 0), 0) + (sim.company.today.income.reward ?? 0);
    expect(rewards).toBe(5_000_000);
  });

  it('new routes have demand immediately (scheduled frequency, not past departures)', () => {
    const { sim, route } = makeSim();
    expect(sim.expectedDailyDemand(route, 0, 1)).toBeGreaterThan(10);
  });

  it('createRoute builds legs from paths', () => {
    const r = createRoute({ id: 'q', name: 'q', color: '#fff', stops: ['tokyo', 'chiba'], paths: [straight()] });
    expect(r.legs[0].fastKm).toBeCloseTo(r.legs[0].lengthKm, 6);
  });
});

describe('route estimate', () => {
  it('predicts the balance scenario within a reasonable margin', async () => {
    const nets = loadNetworks();
    const plan = await nets.plan('bus', [
      { ...city('tokyo'), name: '東京' },
      { ...city('osaka'), name: '大阪' },
    ]);
    if (!plan.ok) throw new Error(plan.error);
    const sim = new Simulation({ startMs: Date.UTC(2026, 2, 31, 15, 0), cities: ALL_CITIES, companyName: 'T', startingCash: 0 });
    const req = { mode: 'bus' as const, stops: ['tokyo', 'osaka'], paths: plan.legs, modelId: 'microbus-28', vehicles: 1 };
    const est = sim.estimateRoute(req);
    expect(est.lengthKm).toBeGreaterThan(500);
    expect(est.demandPerDay).toBeGreaterThan(est.capacityPerDay);
    // Balance run: ~¥430k/day for this route.
    expect(est.profitPerDay).toBeGreaterThan(250_000);
    expect(est.profitPerDay).toBeLessThan(650_000);
  });
});
