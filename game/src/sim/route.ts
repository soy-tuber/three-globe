// Routes: an ordered list of stops connected by legs, with passenger queues per O/D pair.
import { Polyline, type LatLng } from './geo';
import { SegClass, type TransportPath } from './graph';
import type { FarePolicy } from './model';
import { MODE_INFO, type Mode } from './modes';

export interface Leg {
  /** stop indices */
  from: number;
  to: number;
  line: Polyline;
  segmentClass: Uint8Array;
  lengthKm: number;
  /** km on the network's fast class (expressway / main line / open sea / cruise) */
  fastKm: number;
}

export interface Cohort {
  count: number;
  /** sim minute the passengers arrived at the stop */
  since: number;
}

export interface RouteState {
  id: string;
  name: string;
  color: string;
  mode: Mode;
  /** city ids, in order */
  stops: string[];
  legs: Leg[];
  fare: FarePolicy;
  /** queues[from][to] — waiting passengers from stop `from` to stop `to` */
  queues: Cohort[][][];
  /** expected passengers/day for each O/D pair, refreshed by the simulation */
  demand: number[][];
  /** how long passengers wait before giving up (minutes), refreshed with demand */
  patienceMin: number;
  /** departure times (sim minutes) during the last 24h, per direction (+1 → index 0, −1 → index 1) */
  departures: [number[], number[]];
  stats: { passengers: number; revenue: number; lost: number };
  /** sim minute the route opened */
  openedAt: number;
}

export function makeLeg(from: number, to: number, path: TransportPath): Leg {
  const line = new Polyline(path.points);
  let fastKm = 0;
  for (let i = 0; i < path.segmentClass.length; i++) {
    if (path.segmentClass[i] === SegClass.Fast) fastKm += line.cumKm[i + 1] - line.cumKm[i];
  }
  return { from, to, line, segmentClass: path.segmentClass, lengthKm: line.lengthKm, fastKm };
}

export function createRoute(opts: {
  id: string;
  name: string;
  color: string;
  mode?: Mode;
  stops: string[];
  paths: TransportPath[];
  fare?: FarePolicy;
  openedAt?: number;
}): RouteState {
  if (opts.paths.length !== opts.stops.length - 1) throw new Error('need one path per consecutive stop pair');
  const n = opts.stops.length;
  return {
    id: opts.id,
    name: opts.name,
    color: opts.color,
    mode: opts.mode ?? 'bus',
    stops: opts.stops,
    legs: opts.paths.map((p, i) => makeLeg(i, i + 1, p)),
    fare: opts.fare ?? { multiplier: 1 },
    queues: Array.from({ length: n }, () => Array.from({ length: n }, () => [] as Cohort[])),
    demand: Array.from({ length: n }, () => new Array(n).fill(0)),
    patienceMin: 240,
    departures: [[], []],
    stats: { passengers: 0, revenue: 0, lost: 0 },
    openedAt: opts.openedAt ?? 0,
  };
}

/** Network distance between two stops along the route. */
export function stopDistanceKm(r: RouteState, a: number, b: number): number {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  let d = 0;
  for (let i = lo; i < hi; i++) d += r.legs[i].lengthKm;
  return d;
}

export function waitingAt(r: RouteState, stop: number): number {
  let n = 0;
  for (const q of r.queues[stop]) for (const c of q) n += c.count;
  return n;
}

export function waitingTotal(r: RouteState): number {
  let n = 0;
  for (let s = 0; s < r.stops.length; s++) n += waitingAt(r, s);
  return n;
}

/** Full route geometry (all legs concatenated) — handy for drawing. */
export function routePoints(r: RouteState): LatLng[] {
  const pts: LatLng[] = [];
  r.legs.forEach((leg, i) => pts.push(...(i === 0 ? leg.line.points : leg.line.points.slice(1))));
  return pts;
}

export function departuresPerDay(r: RouteState, dir: 1 | -1, now: number): number {
  const list = r.departures[dir === 1 ? 0 : 1];
  while (list.length && list[0] < now - 24 * 60) list.shift();
  return list.length;
}

/** Free-flow driving time of one leg for a vehicle with the given top speed (minutes). */
export function legMinutes(leg: Leg, mode: Mode, maxSpeedKmh: number): number {
  const speeds = MODE_INFO[mode].speedKmh;
  let t = 0;
  for (let i = 0; i < leg.segmentClass.length; i++) {
    const d = leg.line.cumKm[i + 1] - leg.line.cumKm[i];
    t += (d / Math.min(maxSpeedKmh, speeds[leg.segmentClass[i] as SegClass])) * 60;
  }
  return t;
}

/** End-to-end travel time at free-flow speeds, excluding dwell (minutes). */
export function freeFlowMinutes(r: RouteState, maxSpeedKmh: number): number {
  return r.legs.reduce((t, leg) => t + legMinutes(leg, r.mode, maxSpeedKmh), 0);
}
