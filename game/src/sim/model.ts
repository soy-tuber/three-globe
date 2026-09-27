// Core game data types and tunables. The simulation only deals in plain data:
// no three.js, no DOM — so it can run headless (tests, a worker, a server).
import type { LatLng } from './geo';

export interface City extends LatLng {
  id: string;
  /** display name (Japanese) */
  name: string;
  nameEn: string;
  population: number;
  /** prefecture (Japanese) */
  pref: string;
}

export interface VehicleModel {
  id: string;
  name: string;
  mode: 'bus';
  capacity: number;
  /** top cruising speed; the road's speed limit also applies */
  maxSpeedKmh: number;
  purchasePrice: number;
  /** fuel + wear, ¥ per km */
  costPerKm: number;
  /** driver wages while in service, ¥ per hour */
  crewPerHour: number;
  /** insurance, depot, inspection — ¥ per day regardless of use */
  fixedPerDay: number;
  /** minutes spent at a stop for boarding/alighting */
  dwellMin: number;
  /** Kenney model file under public/assets/models */
  modelUrl: string;
}

export const VEHICLE_MODELS: Record<string, VehicleModel> = {
  'microbus-28': {
    id: 'microbus-28',
    name: 'マイクロバス 28',
    mode: 'bus',
    capacity: 28,
    maxSpeedKmh: 90,
    purchasePrice: 14_000_000,
    costPerKm: 38,
    crewPerHour: 2_600,
    fixedPerDay: 9_000,
    dwellMin: 20,
    modelUrl: 'assets/models/bus.glb',
  },
};

/** Expressway tolls for a medium bus, ¥ per km driven on expressways. */
export const EXPRESSWAY_TOLL_PER_KM = 29;

export interface FarePolicy {
  /** multiplier on the market reference fare (1 = market rate) */
  multiplier: number;
}

/** Typical market fare for a highway-bus trip of the given length (¥). */
export function referenceFare(distanceKm: number): number {
  return 700 + 10.5 * distanceKm;
}

export function ticketPrice(distanceKm: number, policy: FarePolicy): number {
  // Round to ¥10 like real ticket tables.
  return Math.round((referenceFare(distanceKm) * policy.multiplier) / 10) * 10;
}
