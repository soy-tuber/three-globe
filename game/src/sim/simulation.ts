// The simulation: fixed-timestep world update, independent of rendering.
//
// Rendering calls `advance(gameMinutes)` once per frame and then reads state;
// `alpha` gives the fractional progress into the next step for smooth interpolation.
import { type ClockState, localDay, localHour } from './clock';
import { DEFAULT_DEMAND, captureShare, hourlyFactor, marketTripsPerDay, type DemandParams } from './demand';
import { type CompanyState, createCompany, earn, rollDay, spend, type DailyReport } from './economy';
import { EXPRESSWAY_TOLL_PER_KM, VEHICLE_MODELS, ticketPrice, type City, type VehicleModel } from './model';
import { Rng } from './rng';
import { departuresPerDay, stopDistanceKm, waitingAt, type RouteState } from './route';
import { RoadClass } from './roadGraph';
import {
  ACCEL_KMH_PER_MIN,
  currentLeg,
  roadClassAt,
  targetSpeedKmh,
  vehiclePose,
  type VehiclePose,
  type VehicleState,
} from './vehicle';

/** Simulation step in game minutes. */
export const STEP_MIN = 0.25;
/** Safety valve so a long frame (tab in background) can't stall the page. */
const MAX_STEPS_PER_ADVANCE = 4000;

export type SimEvent =
  | { type: 'arrival'; t: number; vehicleId: string; routeId: string; cityId: string; alighted: number }
  | {
      type: 'departure';
      t: number;
      vehicleId: string;
      routeId: string;
      cityId: string;
      boarded: number;
      onboard: number;
      revenue: number;
    }
  | { type: 'day'; t: number; report: DailyReport };

export interface SimOptions {
  seed?: number;
  /** UTC epoch ms of the game start */
  startMs: number;
  cities: City[];
  companyName: string;
  startingCash: number;
  demand?: Partial<DemandParams>;
}

export class Simulation {
  readonly clock: ClockState;
  readonly cities: ReadonlyMap<string, City>;
  readonly company: CompanyState;
  readonly routes = new Map<string, RouteState>();
  readonly vehicles = new Map<string, VehicleState>();
  readonly demand: DemandParams;

  private rng: Rng;
  private accumulator = 0;
  private events: SimEvent[] = [];
  private day: number;
  private vehicleSeq = 0;

  constructor(opts: SimOptions) {
    this.clock = { epochMs: opts.startMs, minutes: 0 };
    this.cities = new Map(opts.cities.map(c => [c.id, c]));
    this.rng = new Rng(opts.seed ?? 20260401);
    this.demand = { ...DEFAULT_DEMAND, ...opts.demand };
    this.day = localDay(this.clock);
    this.company = createCompany(opts.companyName, opts.startingCash, this.day);
  }

  // ------------------------------------------------------------------ setup

  addRoute(route: RouteState) {
    for (const s of route.stops) if (!this.cities.has(s)) throw new Error(`unknown city ${s}`);
    this.routes.set(route.id, route);
  }

  /** Buy a vehicle and put it into service at the route's first stop. */
  buyVehicle(
    routeId: string,
    modelId: string,
    opts: { name?: string; free?: boolean; firstDepartureInMin?: number; startStop?: number } = {},
  ): VehicleState {
    const route = this.routes.get(routeId);
    const model = VEHICLE_MODELS[modelId];
    if (!route || !model) throw new Error('unknown route or model');
    if (!opts.free) spend(this.company, 'purchase', model.purchasePrice);
    const id = `v${++this.vehicleSeq}`;
    const v: VehicleState = {
      id,
      name: opts.name ?? `${route.name} ${this.vehicleSeq}号車`,
      modelId,
      routeId,
      status: 'dwell',
      stopIndex: opts.startStop ?? 0,
      dir: (opts.startStop ?? 0) === route.stops.length - 1 ? -1 : 1,
      legKm: 0,
      prevLegKm: 0,
      dwellLeftMin: opts.firstDepartureInMin ?? model.dwellMin,
      speedKmh: 0,
      onboard: {},
      odometerKm: 0,
      tripRevenue: 0,
    };
    this.vehicles.set(id, v);
    return v;
  }

  // ------------------------------------------------------------------ time

  /** Advance by a number of game minutes (may be fractional). Returns steps executed. */
  advance(minutes: number): number {
    this.accumulator += Math.max(0, minutes);
    let steps = 0;
    while (this.accumulator >= STEP_MIN && steps < MAX_STEPS_PER_ADVANCE) {
      this.step(STEP_MIN);
      this.accumulator -= STEP_MIN;
      steps++;
    }
    if (steps === MAX_STEPS_PER_ADVANCE) this.accumulator = 0;
    return steps;
  }

  /** Fraction of the next step already elapsed (for render interpolation). */
  get alpha(): number {
    return this.accumulator / STEP_MIN;
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  step(dt: number) {
    this.clock.minutes += dt;
    const hour = localHour(this.clock);

    for (const route of this.routes.values()) this.generatePassengers(route, hour, dt);
    for (const v of this.vehicles.values()) this.updateVehicle(v, dt);

    const day = localDay(this.clock);
    if (day !== this.day) {
      this.day = day;
      const report = rollDay(this.company, day);
      this.events.push({ type: 'day', t: this.clock.minutes, report });
    }
  }

  // ------------------------------------------------------------------ demand

  /** Expected passengers per day wanting to travel a→b on this route with our service. */
  expectedDailyDemand(route: RouteState, a: number, b: number): number {
    const ca = this.cities.get(route.stops[a])!;
    const cb = this.cities.get(route.stops[b])!;
    const km = stopDistanceKm(route, a, b);
    const market = marketTripsPerDay(ca.population, cb.population, km, this.demand);
    const fare = ticketPrice(km, route.fare);
    const deps = departuresPerDay(route, b > a ? 1 : -1, this.clock.minutes);
    return market * captureShare(fare, km, deps, this.demand);
  }

  private generatePassengers(route: RouteState, hour: number, dt: number) {
    const n = route.stops.length;
    const now = this.clock.minutes;
    const hf = hourlyFactor(hour);
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        if (a === b) continue;
        const q = route.queues[a][b];
        // Expire passengers who gave up.
        while (q.length && q[0].since < now - this.demand.maxWaitMin) {
          const lost = q.shift()!.count;
          route.stats.lost += lost;
          this.company.today.lostPassengers += lost;
        }
        const perMin = (this.expectedDailyDemand(route, a, b) * hf) / (24 * 60);
        const k = this.rng.poisson(perMin * dt);
        if (k > 0) {
          const last = q[q.length - 1];
          // Merge into the latest cohort if it is recent, to keep queues short.
          if (last && now - last.since < 10) last.count += k;
          else q.push({ count: k, since: now });
        }
      }
    }
  }

  // ------------------------------------------------------------------ vehicles

  private updateVehicle(v: VehicleState, dt: number) {
    const route = this.routes.get(v.routeId)!;
    const model = VEHICLE_MODELS[v.modelId];
    v.prevLegKm = v.legKm;

    // Running costs: crew and fixed costs accrue continuously.
    spend(this.company, 'crew', (model.crewPerHour * dt) / 60);
    spend(this.company, 'fixed', (model.fixedPerDay * dt) / (24 * 60));

    if (v.status === 'dwell') {
      v.dwellLeftMin -= dt;
      if (v.dwellLeftMin <= 0) this.depart(v, route, model);
      return;
    }

    const { leg, reversed } = currentLeg(v, route);
    const remaining = leg.lengthKm - v.legKm;
    const cls = roadClassAt(leg, reversed, v.legKm);
    const target = targetSpeedKmh(model.maxSpeedKmh, cls, remaining);
    const dv = ACCEL_KMH_PER_MIN * dt;
    v.speedKmh = v.speedKmh < target ? Math.min(target, v.speedKmh + dv) : Math.max(target, v.speedKmh - dv * 2);

    const km = Math.min(remaining, (v.speedKmh * dt) / 60);
    v.legKm += km;
    v.odometerKm += km;
    this.company.today.vehicleKm += km;
    spend(this.company, 'fuel', km * model.costPerKm);
    if (cls === RoadClass.Expressway) spend(this.company, 'toll', km * EXPRESSWAY_TOLL_PER_KM);

    if (v.legKm >= leg.lengthKm - 1e-9) this.arrive(v, route, model);
  }

  private arrive(v: VehicleState, route: RouteState, model: VehicleModel) {
    const stop = v.stopIndex + v.dir;
    v.stopIndex = stop;
    v.status = 'dwell';
    v.dwellLeftMin = model.dwellMin;
    v.speedKmh = 0;
    v.legKm = v.prevLegKm = 0;

    const alighted = v.onboard[stop] ?? 0;
    delete v.onboard[stop];
    if (stop === 0 || stop === route.stops.length - 1) v.dir = stop === 0 ? 1 : -1;

    this.events.push({
      type: 'arrival',
      t: this.clock.minutes,
      vehicleId: v.id,
      routeId: route.id,
      cityId: route.stops[stop],
      alighted,
    });
  }

  private depart(v: VehicleState, route: RouteState, model: VehicleModel) {
    const from = v.stopIndex;
    let boarded = 0;
    let revenue = 0;
    let free = model.capacity - Object.values(v.onboard).reduce((a, b) => a + b, 0);

    // Board passengers for stops ahead, nearest destinations first (FIFO within a queue).
    for (let to = from + v.dir; to >= 0 && to < route.stops.length && free > 0; to += v.dir) {
      const q = route.queues[from][to];
      const fare = ticketPrice(stopDistanceKm(route, from, to), route.fare);
      while (q.length && free > 0) {
        const take = Math.min(free, q[0].count);
        q[0].count -= take;
        if (q[0].count === 0) q.shift();
        free -= take;
        boarded += take;
        revenue += take * fare;
        v.onboard[to] = (v.onboard[to] ?? 0) + take;
      }
    }

    if (revenue > 0) earn(this.company, 'fare', revenue);
    this.company.today.passengers += boarded;
    this.company.totals.passengers += boarded;
    route.stats.passengers += boarded;
    route.stats.revenue += revenue;
    v.tripRevenue = revenue;

    route.departures[v.dir === 1 ? 0 : 1].push(this.clock.minutes);
    v.status = 'drive';
    v.legKm = v.prevLegKm = 0;

    this.events.push({
      type: 'departure',
      t: this.clock.minutes,
      vehicleId: v.id,
      routeId: route.id,
      cityId: route.stops[from],
      boarded,
      onboard: model.capacity - free,
      revenue,
    });
  }

  // ------------------------------------------------------------------ queries

  /** The stop with the most waiting passengers — a sensible place to put a new vehicle. */
  busiestStop(routeId: string): number {
    const r = this.routes.get(routeId)!;
    let best = 0, bestN = -1;
    r.stops.forEach((_, i) => {
      const n = waitingAt(r, i);
      if (n > bestN) {
        bestN = n;
        best = i;
      }
    });
    return best;
  }

  pose(vehicleId: string): VehiclePose | null {
    const v = this.vehicles.get(vehicleId);
    if (!v) return null;
    return vehiclePose(v, this.routes.get(v.routeId)!, v.status === 'drive' ? this.alpha : 1);
  }

  /** Minutes until the vehicle reaches its next stop (driving) or departs (dwelling). */
  etaMinutes(vehicleId: string): number {
    const v = this.vehicles.get(vehicleId);
    if (!v) return 0;
    if (v.status === 'dwell') return v.dwellLeftMin;
    const route = this.routes.get(v.routeId)!;
    const { leg, reversed } = currentLeg(v, route);
    // Integrate remaining time over the leg at free-flow speeds (coarse, 2 km slices).
    const model = VEHICLE_MODELS[v.modelId];
    let t = 0;
    for (let km = v.legKm; km < leg.lengthKm; km += 2) {
      const slice = Math.min(2, leg.lengthKm - km);
      const speed = targetSpeedKmh(model.maxSpeedKmh, roadClassAt(leg, reversed, km), leg.lengthKm - km);
      t += (slice / Math.max(speed, 20)) * 60;
    }
    return t;
  }
}
