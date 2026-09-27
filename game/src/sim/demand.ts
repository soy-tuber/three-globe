// Passenger demand.
//
// 1. Market size between two cities: a gravity model on population and great-circle distance.
// 2. Our share: a logit choice between each of our services and an "outside option" (competitors,
//    cars, not travelling) on generalised cost = fare + value of time × (ride + access + waiting).
//    Several of our routes serving the same pair compete with each other, so duplicating a route
//    doesn't duplicate demand.
import { MODE_INFO, referenceFareFor, type Mode } from './modes';

export interface DemandParams {
  /** gravity constant — calibrated so Tokyo⇄Osaka ≈ 10,000 intercity trips/day each way */
  gravity: number;
  popExponent: number;
  distExponent: number;
  /** beyond this distance the market decays more slowly (long-haul travel has few substitutes) */
  longHaulKm: number;
  longHaulExponent: number;
  /** trips shorter than this are mostly local transit */
  minDistanceKm: number;
  /** value of travel time, ¥/hour */
  valueOfTime: number;
  /** logit scale on relative generalised cost */
  costSensitivity: number;
  /** weight of the outside option (competitors etc.) */
  outsideWeight: number;
  /** schedule delay: waiting ≈ maxWait · exp(−departuresPerDay / scale) hours */
  maxWaitHours: number;
  waitScale: number;
  /** passengers give up after waiting this long at a stop (minutes) — see patienceMinutes */
  maxWaitMin: number;
}

export const DEFAULT_DEMAND: DemandParams = {
  gravity: 0.065,
  popExponent: 0.6,
  distExponent: 1.1,
  longHaulKm: 1500,
  longHaulExponent: 0.5,
  minDistanceKm: 40,
  valueOfTime: 2_500,
  costSensitivity: 4,
  outsideWeight: 2.6,
  maxWaitHours: 3,
  waitScale: 5,
  maxWaitMin: 240,
};

/**
 * Relative intensity of passengers arriving at a stop for each local hour.
 * Morning and evening peaks plus a late-evening bump. Mean = 1.
 */
const HOURLY_RAW = [
  0.25, 0.1, 0.05, 0.05, 0.1, 0.4, 1.3, 1.9, 1.7, 1.3, 1.1, 1.0, 1.0, 1.0, 1.1, 1.2, 1.4, 1.7, 1.8, 1.5, 1.2, 1.1, 1.3, 0.7,
];
const HOURLY_MEAN = HOURLY_RAW.reduce((a, b) => a + b, 0) / 24;
export const HOURLY_PROFILE = HOURLY_RAW.map(v => v / HOURLY_MEAN);

export function hourlyFactor(hour: number): number {
  const h0 = Math.floor(hour) % 24;
  const h1 = (h0 + 1) % 24;
  const t = hour - Math.floor(hour);
  return HOURLY_PROFILE[h0] * (1 - t) + HOURLY_PROFILE[h1] * t;
}

/** Total intercity market between two cities, trips per day in one direction. */
export function marketTripsPerDay(popA: number, popB: number, distanceKm: number, p = DEFAULT_DEMAND): number {
  const d = Math.max(distanceKm, p.minDistanceKm);
  const pops = p.gravity * popA ** p.popExponent * popB ** p.popExponent;
  if (d <= p.longHaulKm) return pops / d ** p.distExponent;
  return (pops / p.longHaulKm ** p.distExponent) * (p.longHaulKm / d) ** p.longHaulExponent;
}

export function waitHours(departuresPerDay: number, p = DEFAULT_DEMAND): number {
  return p.maxWaitHours * Math.exp(-departuresPerDay / p.waitScale);
}

export interface ServiceOffer {
  mode: Mode;
  fare: number;
  /** in-vehicle time including intermediate stops, hours */
  rideHours: number;
  departuresPerDay: number;
}

export function generalizedCost(o: ServiceOffer, p = DEFAULT_DEMAND): number {
  const info = MODE_INFO[o.mode];
  return o.fare + p.valueOfTime * (o.rideHours * info.votFactor + info.accessHours + waitHours(o.departuresPerDay, p));
}

/**
 * How long passengers keep waiting at a stop before giving up (minutes): at least `maxWaitMin`,
 * and long enough to catch the next scheduled departure on infrequent (e.g. long-haul) services.
 */
export function patienceMinutes(departuresPerDay: number, p = DEFAULT_DEMAND): number {
  return departuresPerDay > 0 ? Math.max(p.maxWaitMin, (1.25 * 24 * 60) / departuresPerDay) : p.maxWaitMin;
}

/** Typical door-to-door speed of the market's modes (for the outside option), km/h. */
const MARKET_SPEED: Record<Mode, number> = { bus: 70, rail: 150, air: 650, ship: 30 };

/** Generalised cost of the best alternative on the market for a trip of great-circle length d. */
export function outsideCost(greatCircleKm: number, p = DEFAULT_DEMAND): number {
  let best = Infinity;
  for (const mode of ['bus', 'rail', 'air'] as Mode[]) {
    if (greatCircleKm < MODE_INFO[mode].minDistanceKm) continue;
    if (mode !== 'air' && greatCircleKm > 2500) continue;
    const km = mode === 'air' ? greatCircleKm : greatCircleKm * 1.25;
    const c = referenceFareFor(mode, km) + p.valueOfTime * (km / MARKET_SPEED[mode] + MODE_INFO[mode].accessHours + 1);
    best = Math.min(best, c);
  }
  return best;
}

/**
 * Shares of the market captured by each offer (logit against the outside option).
 * Returned array matches `offers`.
 */
export function captureShares(offers: ServiceOffer[], greatCircleKm: number, p = DEFAULT_DEMAND): number[] {
  const ref = outsideCost(greatCircleKm, p);
  const k = p.costSensitivity;
  const u = offers.map(o => Math.exp(-k * (generalizedCost(o, p) / ref - 1) + MODE_INFO[o.mode].asc));
  const denom = p.outsideWeight + u.reduce((a, b) => a + b, 0);
  return u.map(x => x / denom);
}
