// Passenger demand: a gravity model for the size of the market between two cities,
// and a logit-style share for how much of it chooses our service.
import { referenceFare } from './model';

export interface DemandParams {
  /** gravity constant — calibrated so Tokyo⇄Osaka ≈ 8,000 highway-bus trips/day each way */
  gravity: number;
  popExponent: number;
  distExponent: number;
  /** trips shorter than this are mostly taken by local transit, not intercity buses */
  minDistanceKm: number;
  /** maximum share we can capture with a perfect product */
  maxShare: number;
  /** fare sensitivity: share halves roughly every (1/sensitivity) of relative over-pricing */
  fareSensitivity: number;
  /** how many daily departures (per direction) it takes to be "a real option" */
  frequencyScale: number;
  /** share multiplier with almost no departures; frequency lifts it toward 1 */
  frequencyFloor: number;
  /** passengers give up after waiting this long */
  maxWaitMin: number;
}

export const DEFAULT_DEMAND: DemandParams = {
  gravity: 0.065,
  popExponent: 0.6,
  distExponent: 1.1,
  minDistanceKm: 40,
  maxShare: 0.05,
  fareSensitivity: 4.5,
  frequencyScale: 4,
  frequencyFloor: 0.6,
  maxWaitMin: 240,
};

/**
 * Relative intensity of intercity-bus passengers arriving at a stop for each local hour.
 * Morning and evening peaks plus a late-evening night-bus bump. Mean = 1.
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

/** Total intercity-bus market between two cities, trips per day in one direction. */
export function marketTripsPerDay(popA: number, popB: number, distanceKm: number, p = DEFAULT_DEMAND): number {
  const d = Math.max(distanceKm, p.minDistanceKm);
  return (p.gravity * popA ** p.popExponent * popB ** p.popExponent) / d ** p.distExponent;
}

/**
 * Share of the market captured by our service.
 * @param fare our ticket price
 * @param distanceKm trip length
 * @param departuresPerDay our departures per day in this direction
 */
export function captureShare(fare: number, distanceKm: number, departuresPerDay: number, p = DEFAULT_DEMAND): number {
  const rel = fare / referenceFare(distanceKm);
  const price = 1 / (1 + Math.exp(p.fareSensitivity * (rel - 1)));
  const frequency = p.frequencyFloor + (1 - p.frequencyFloor) * (1 - Math.exp(-departuresPerDay / p.frequencyScale));
  return p.maxShare * 2 * price * frequency;
}
