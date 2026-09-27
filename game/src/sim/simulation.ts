// The simulation: fixed-timestep world update, independent of rendering.
//
// Rendering calls `advance(gameMinutes)` once per frame and then reads state;
// `alpha` gives the fractional progress into the next step for smooth interpolation.
import { type ClockState, localDay, localHour } from './clock';
import {
  DEFAULT_DEMAND,
  captureShares,
  hourlyFactor,
  marketTripsPerDay,
  patienceMinutes,
  type DemandParams,
  type ServiceOffer,
} from './demand';
import { type CompanyState, createCompany, earn, rollDay, spend, type DailyReport } from './economy';
import { haversineKm } from './geo';
import { GOALS, openGoals, type Goal, type GoalState } from './goals';
import type { TransportPath } from './graph';
import { VEHICLE_MODELS, modelsFor, ticketPrice, type City, type FarePolicy, type VehicleModel } from './model';
import { MODE_INFO, type Mode } from './modes';
import { Rng } from './rng';
import { createRoute, legMinutes, stopDistanceKm, waitingAt, type RouteState } from './route';
import {
  ACCEL_KMH_PER_MIN,
  currentLeg,
  onboardCount,
  segClassAt,
  targetSpeedKmh,
  vehiclePose,
  type VehiclePose,
  type VehicleState,
} from './vehicle';

/** Simulation step in game minutes. */
export const STEP_MIN = 0.25;
/** Safety valve so a long frame (tab in background) can't stall the page. */
const MAX_STEPS_PER_ADVANCE = 4000;
/** Demand shares are re-evaluated this often (game minutes) or when the network changes. */
const DEMAND_REFRESH_MIN = 60;
/** Share of the purchase price recovered when a vehicle is sold. */
export const RESALE_RATIO = 0.5;

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
  | { type: 'day'; t: number; report: DailyReport }
  | { type: 'routeOpened'; t: number; routeId: string }
  | { type: 'routeClosed'; t: number; routeId: string; vehicleIds: string[]; refund: number }
  | { type: 'vehicleAdded'; t: number; routeId: string; vehicleId: string }
  | { type: 'goal'; t: number; goal: Goal };

export interface SimOptions {
  seed?: number;
  /** UTC epoch ms of the game start */
  startMs: number;
  cities: City[];
  companyName: string;
  startingCash: number;
  demand?: Partial<DemandParams>;
}

export interface OpenRouteRequest {
  name: string;
  color: string;
  mode: Mode;
  stops: string[];
  paths: TransportPath[];
  modelId: string;
  vehicles?: number;
  fare?: FarePolicy;
  /** skip the purchase (the starting fleet) */
  free?: boolean;
  firstDepartureInMin?: number;
}

export interface RouteEstimate {
  lengthKm: number;
  tripHours: number;
  departuresPerDay: number;
  /** both directions, all stop pairs */
  demandPerDay: number;
  capacityPerDay: number;
  /** end-to-end ticket */
  fare: number;
  revenuePerDay: number;
  costPerDay: number;
  profitPerDay: number;
  price: number;
  maxLegKm: number;
}

export class Simulation {
  readonly clock: ClockState;
  readonly cities: ReadonlyMap<string, City>;
  readonly company: CompanyState;
  readonly routes = new Map<string, RouteState>();
  readonly vehicles = new Map<string, VehicleState>();
  readonly demand: DemandParams;
  readonly goals: GoalState = { completed: [] };

  private rng: Rng;
  private accumulator = 0;
  private events: SimEvent[] = [];
  private day: number;
  private vehicleSeq = 0;
  private routeSeq = 0;
  private demandDirty = true;
  private lastDemandRefresh = -Infinity;
  private lastGoalCheck = 0;

  constructor(opts: SimOptions) {
    this.clock = { epochMs: opts.startMs, minutes: 0 };
    this.cities = new Map(opts.cities.map(c => [c.id, c]));
    this.rng = new Rng(opts.seed ?? 20260401);
    this.demand = { ...DEFAULT_DEMAND, ...opts.demand };
    this.day = localDay(this.clock);
    this.company = createCompany(opts.companyName, opts.startingCash, this.day);
  }

  // ------------------------------------------------------------------ network changes

  addRoute(route: RouteState) {
    for (const s of route.stops) if (!this.cities.has(s)) throw new Error(`unknown city ${s}`);
    this.routes.set(route.id, route);
    this.demandDirty = true;
  }

  /** Price of opening a route with `count` vehicles of a model. */
  openingCost(modelId: string, count = 1): number {
    return VEHICLE_MODELS[modelId].purchasePrice * count;
  }

  /** Validate and open a new route with its first vehicles. Returns an error message on failure. */
  openRoute(req: OpenRouteRequest): { route: RouteState; vehicles: VehicleState[] } | string {
    const model = VEHICLE_MODELS[req.modelId];
    if (!model) return '車両モデルが不明です';
    if (model.mode !== req.mode) return `${model.name}は${MODE_INFO[req.mode].name}路線には使えません`;
    const count = Math.max(1, req.vehicles ?? 1);
    const tooLong = req.paths.find(p => p.lengthKm > model.rangeKm);
    if (tooLong) return `${model.name}の航続距離（${model.rangeKm.toLocaleString()} km）を超える区間があります`;
    if (!req.free && this.company.cash < this.openingCost(model.id, count)) return '資金が足りません';

    const route = createRoute({
      id: `r${++this.routeSeq}`,
      name: req.name,
      color: req.color,
      mode: req.mode,
      stops: req.stops,
      paths: req.paths,
      fare: req.fare,
      openedAt: this.clock.minutes,
    });
    this.addRoute(route);
    const vehicles: VehicleState[] = [];
    for (let i = 0; i < count; i++) {
      vehicles.push(
        this.buyVehicle(route.id, model.id, {
          free: req.free,
          startStop: i % 2 === 0 ? 0 : route.stops.length - 1,
          firstDepartureInMin: req.firstDepartureInMin,
        }),
      );
    }
    this.events.push({ type: 'routeOpened', t: this.clock.minutes, routeId: route.id });
    return { route, vehicles };
  }

  /** Close a route: its vehicles are sold at RESALE_RATIO and waiting passengers go home. */
  closeRoute(routeId: string): number {
    const route = this.routes.get(routeId);
    if (!route) return 0;
    const ids: string[] = [];
    let refund = 0;
    for (const v of [...this.vehicles.values()]) {
      if (v.routeId !== routeId) continue;
      refund += v.purchasePrice * RESALE_RATIO;
      this.vehicles.delete(v.id);
      ids.push(v.id);
    }
    if (refund > 0) earn(this.company, 'sale', refund);
    this.routes.delete(routeId);
    this.demandDirty = true;
    this.events.push({ type: 'routeClosed', t: this.clock.minutes, routeId, vehicleIds: ids, refund });
    return refund;
  }

  /** Buy a vehicle and put it into service at one of the route's stops. */
  buyVehicle(
    routeId: string,
    modelId: string,
    opts: { name?: string; free?: boolean; firstDepartureInMin?: number; startStop?: number } = {},
  ): VehicleState {
    const route = this.routes.get(routeId);
    const model = VEHICLE_MODELS[modelId];
    if (!route || !model) throw new Error('unknown route or model');
    if (model.mode !== route.mode) throw new Error(`${model.id} cannot run on a ${route.mode} route`);
    if (!opts.free) spend(this.company, 'purchase', model.purchasePrice);
    const id = `v${++this.vehicleSeq}`;
    const n = [...this.vehicles.values()].filter(v => v.routeId === routeId).length + 1;
    const startStop = opts.startStop ?? 0;
    const v: VehicleState = {
      id,
      name: opts.name ?? `${route.name} ${n}号`,
      modelId,
      routeId,
      status: 'dwell',
      stopIndex: startStop,
      dir: startStop === route.stops.length - 1 ? -1 : 1,
      legKm: 0,
      prevLegKm: 0,
      dwellLeftMin: opts.firstDepartureInMin ?? model.dwellMin,
      speedKmh: 0,
      onboard: {},
      odometerKm: 0,
      tripRevenue: 0,
      purchasePrice: opts.free ? model.purchasePrice : model.purchasePrice,
    };
    this.vehicles.set(id, v);
    this.demandDirty = true;
    this.events.push({ type: 'vehicleAdded', t: this.clock.minutes, routeId, vehicleId: id });
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

    if (this.demandDirty || this.clock.minutes - this.lastDemandRefresh >= DEMAND_REFRESH_MIN) this.refreshDemand();
    for (const route of this.routes.values()) this.generatePassengers(route, hour, dt);
    for (const v of this.vehicles.values()) this.updateVehicle(v, dt);

    const day = localDay(this.clock);
    if (day !== this.day) {
      this.day = day;
      const report = rollDay(this.company, day);
      this.events.push({ type: 'day', t: this.clock.minutes, report });
    }
    if (this.clock.minutes - this.lastGoalCheck >= 30) {
      this.lastGoalCheck = this.clock.minutes;
      this.checkGoals();
    }
  }

  // ------------------------------------------------------------------ goals

  checkGoals() {
    for (const goal of openGoals(this.goals)) {
      const [cur, target] = goal.progress(this);
      if (cur < target) continue;
      this.goals.completed.push(goal.id);
      if (goal.reward > 0) earn(this.company, 'reward', goal.reward);
      this.events.push({ type: 'goal', t: this.clock.minutes, goal });
    }
  }

  get allGoals() {
    return GOALS;
  }

  // ------------------------------------------------------------------ demand

  private routeModel(route: RouteState): VehicleModel {
    const v = [...this.vehicles.values()].find(x => x.routeId === route.id);
    return v ? VEHICLE_MODELS[v.modelId] : modelsFor(route.mode)[0];
  }

  /** Round-trip cycle time of a vehicle on the route (minutes). */
  cycleMinutes(route: RouteState, model = this.routeModel(route)): number {
    const run = route.legs.reduce((t, leg) => t + legMinutes(leg, route.mode, model.maxSpeedKmh), 0);
    return 2 * (run + model.dwellMin * (route.stops.length - 1));
  }

  /** Scheduled departures per day in each direction, from the fleet size and cycle time. */
  scheduledDeparturesPerDay(route: RouteState): number {
    const n = [...this.vehicles.values()].filter(v => v.routeId === route.id).length;
    return n === 0 ? 0 : (n * 24 * 60) / this.cycleMinutes(route);
  }

  /** The offer a route makes for the trip between two of its stops. */
  offer(route: RouteState, a: number, b: number): ServiceOffer {
    const model = this.routeModel(route);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    let ride = 0;
    for (let i = lo; i < hi; i++) ride += legMinutes(route.legs[i], route.mode, model.maxSpeedKmh);
    ride += model.dwellMin * Math.max(0, hi - lo - 1);
    return {
      mode: route.mode,
      fare: ticketPrice(stopDistanceKm(route, a, b), route.fare, route.mode),
      rideHours: ride / 60,
      departuresPerDay: this.scheduledDeparturesPerDay(route),
    };
  }

  /** Recompute expected daily demand for every O/D pair of every route (logit over our offers). */
  refreshDemand() {
    this.demandDirty = false;
    this.lastDemandRefresh = this.clock.minutes;
    const byPair = new Map<string, { route: RouteState; a: number; b: number; offer: ServiceOffer }[]>();
    for (const route of this.routes.values()) {
      route.patienceMin = patienceMinutes(this.scheduledDeparturesPerDay(route), this.demand);
      const n = route.stops.length;
      for (let a = 0; a < n; a++)
        for (let b = 0; b < n; b++) {
          if (a === b) continue;
          const key = `${route.stops[a]}>${route.stops[b]}`;
          let list = byPair.get(key);
          if (!list) byPair.set(key, (list = []));
          list.push({ route, a, b, offer: this.offer(route, a, b) });
        }
    }
    for (const [key, list] of byPair) {
      const [ia, ib] = key.split('>');
      const ca = this.cities.get(ia)!, cb = this.cities.get(ib)!;
      const gc = haversineKm(ca, cb);
      const market = marketTripsPerDay(ca.population, cb.population, gc, this.demand);
      const shares = captureShares(
        list.map(x => x.offer),
        gc,
        this.demand,
      );
      list.forEach((x, i) => (x.route.demand[x.a][x.b] = market * shares[i]));
    }
  }

  /** Expected passengers per day wanting to travel a→b on this route. */
  expectedDailyDemand(route: RouteState, a: number, b: number): number {
    if (this.demandDirty) this.refreshDemand();
    return route.demand[a]?.[b] ?? 0;
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
        while (q.length && q[0].since < now - route.patienceMin) {
          const lost = q.shift()!.count;
          route.stats.lost += lost;
          this.company.today.lostPassengers += lost;
        }
        const perMin = (route.demand[a][b] * hf) / (24 * 60);
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
    const cls = segClassAt(leg, reversed, v.legKm);
    const target = targetSpeedKmh(route.mode, model.maxSpeedKmh, cls, remaining);
    const dv = ACCEL_KMH_PER_MIN[route.mode] * dt;
    v.speedKmh = v.speedKmh < target ? Math.min(target, v.speedKmh + dv) : Math.max(target, v.speedKmh - dv * 2);

    const km = Math.min(remaining, (Math.max(v.speedKmh, 1) * dt) / 60);
    v.legKm += km;
    v.odometerKm += km;
    this.company.today.vehicleKm += km;
    spend(this.company, 'fuel', km * model.costPerKm);
    if (model.tollClasses.includes(cls)) spend(this.company, 'toll', km * model.tollPerKm);

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
    let free = model.capacity - onboardCount(v);

    // Board passengers for stops ahead, nearest destinations first (FIFO within a queue).
    for (let to = from + v.dir; to >= 0 && to < route.stops.length && free > 0; to += v.dir) {
      const q = route.queues[from][to];
      const fare = ticketPrice(stopDistanceKm(route, from, to), route.fare, route.mode);
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
    if (model.feePerDeparture > 0) spend(this.company, 'fee', model.feePerDeparture);
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

  pose(vehicleId: string, behindKm = 0): VehiclePose | null {
    const v = this.vehicles.get(vehicleId);
    if (!v) return null;
    return vehiclePose(v, this.routes.get(v.routeId)!, v.status === 'drive' ? this.alpha : 1, behindKm);
  }

  /** Minutes until the vehicle reaches its next stop (moving) or departs (dwelling). */
  etaMinutes(vehicleId: string): number {
    const v = this.vehicles.get(vehicleId);
    if (!v) return 0;
    if (v.status === 'dwell') return v.dwellLeftMin;
    const route = this.routes.get(v.routeId)!;
    const { leg, reversed } = currentLeg(v, route);
    const model = VEHICLE_MODELS[v.modelId];
    const slice = Math.max(2, leg.lengthKm / 200);
    let t = 0;
    for (let km = v.legKm; km < leg.lengthKm; km += slice) {
      const d = Math.min(slice, leg.lengthKm - km);
      const speed = targetSpeedKmh(route.mode, model.maxSpeedKmh, segClassAt(leg, reversed, km), leg.lengthKm - km);
      t += (d / Math.max(speed, 5)) * 60;
    }
    return t;
  }

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
    return best === 0 || best === r.stops.length - 1 ? best : 0;
  }

  /**
   * Projected economics of a route that doesn't exist yet (for the route builder): demand from the
   * same choice model (competing with our existing routes), capacity from the schedule, and a
   * rough daily operating profit.
   */
  estimateRoute(req: Omit<OpenRouteRequest, 'name' | 'color'>): RouteEstimate {
    const model = VEHICLE_MODELS[req.modelId];
    const count = Math.max(1, req.vehicles ?? 1);
    const route = createRoute({ id: '__estimate', name: '', color: '', mode: req.mode, stops: req.stops, paths: req.paths, fare: req.fare });
    const run = route.legs.reduce((t, leg) => t + legMinutes(leg, route.mode, model.maxSpeedKmh), 0);
    const cycle = 2 * (run + model.dwellMin * (route.stops.length - 1));
    const deps = (count * 24 * 60) / cycle;
    const n = route.stops.length;

    let demand = 0, fareSum = 0;
    for (let a = 0; a < n; a++)
      for (let b = 0; b < n; b++) {
        if (a === b) continue;
        const ca = this.cities.get(route.stops[a])!, cb = this.cities.get(route.stops[b])!;
        const gc = haversineKm(ca, cb);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        let ride = 0;
        for (let i = lo; i < hi; i++) ride += legMinutes(route.legs[i], route.mode, model.maxSpeedKmh);
        ride += model.dwellMin * Math.max(0, hi - lo - 1);
        const fare = ticketPrice(stopDistanceKm(route, a, b), route.fare, route.mode);
        const mine: ServiceOffer = { mode: route.mode, fare, rideHours: ride / 60, departuresPerDay: deps };
        const others: ServiceOffer[] = [];
        for (const r of this.routes.values()) {
          const ia = r.stops.indexOf(route.stops[a]), ib = r.stops.indexOf(route.stops[b]);
          if (ia >= 0 && ib >= 0) others.push(this.offer(r, ia, ib));
        }
        const d = marketTripsPerDay(ca.population, cb.population, gc, this.demand) * captureShares([mine, ...others], gc, this.demand)[0];
        demand += d;
        fareSum += d * fare;
      }
    const avgFare = demand > 0 ? fareSum / demand : 0;
    // Each seat is used on every leg; multi-stop routes can resell seats, so this is conservative.
    const capacity = deps * 2 * model.capacity;
    const carried = Math.min(demand, capacity * 0.95);
    const kmPerDay = (count * 24 * 60 * 2 * route.legs.reduce((a, l) => a + l.lengthKm, 0)) / cycle;
    const tollKmShare =
      route.legs.reduce(
        (a, l) => a + l.segmentClass.reduce((s, c, i) => s + (model.tollClasses.includes(c) ? l.line.cumKm[i + 1] - l.line.cumKm[i] : 0), 0),
        0,
      ) / Math.max(1e-9, route.legs.reduce((a, l) => a + l.lengthKm, 0));
    const cost =
      count * (model.fixedPerDay + model.crewPerHour * 24) +
      kmPerDay * (model.costPerKm + model.tollPerKm * tollKmShare) +
      deps * 2 * model.feePerDeparture;
    const revenue = carried * avgFare;
    return {
      lengthKm: route.legs.reduce((a, l) => a + l.lengthKm, 0),
      tripHours: run / 60,
      departuresPerDay: deps,
      demandPerDay: demand,
      capacityPerDay: capacity,
      fare: ticketPrice(stopDistanceKm(route, 0, n - 1), route.fare, route.mode),
      revenuePerDay: revenue,
      costPerDay: cost,
      profitPerDay: revenue - cost,
      price: model.purchasePrice * count,
      maxLegKm: Math.max(...route.legs.map(l => l.lengthKm)),
    };
  }

  vehiclesOn(routeId: string): VehicleState[] {
    return [...this.vehicles.values()].filter(v => v.routeId === routeId);
  }
}
