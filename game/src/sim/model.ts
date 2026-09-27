// Core game data types and tunables. The simulation only deals in plain data:
// no three.js, no DOM — so it can run headless (tests, a worker, a server, the balance tool).
import type { LatLng } from './geo';
import { referenceFareFor, type Mode } from './modes';

export interface City extends LatLng {
  id: string;
  /** display name (Japanese) */
  name: string;
  nameEn: string;
  population: number;
  /** prefecture (Japan) or country (world), in Japanese */
  pref: string;
  capital?: boolean;
}

export interface VehicleModel {
  id: string;
  name: string;
  mode: Mode;
  capacity: number;
  /** top cruising speed; the network's speed for the segment also applies */
  maxSpeedKmh: number;
  /** maximum leg length (air) */
  rangeKm: number;
  purchasePrice: number;
  /** fuel, energy and wear, ¥ per km */
  costPerKm: number;
  /** crew wages while in service, ¥ per hour */
  crewPerHour: number;
  /** insurance, depot, inspection — ¥ per day regardless of use */
  fixedPerDay: number;
  /** landing / port / station charges per departure */
  feePerDeparture: number;
  /** expressway tolls (bus) or track access charges (rail), ¥ per km on the classes below */
  tollPerKm: number;
  tollClasses: number[];
  /** minutes at a stop for boarding/alighting (turnaround) */
  dwellMin: number;
  /** visual: glTF under public/assets/models, or a procedural model name */
  visual: string;
}

const m = (x: VehicleModel) => x;

export const VEHICLE_MODELS: Record<string, VehicleModel> = {
  // ---------------------------------------------------------------- bus
  'microbus-28': m({
    id: 'microbus-28',
    name: 'マイクロバス 28',
    mode: 'bus',
    capacity: 28,
    maxSpeedKmh: 90,
    rangeKm: Infinity,
    purchasePrice: 14_000_000,
    costPerKm: 38,
    crewPerHour: 2_600,
    fixedPerDay: 9_000,
    feePerDeparture: 0,
    tollPerKm: 29,
    tollClasses: [0],
    dwellMin: 20,
    visual: 'glb:assets/models/bus.glb',
  }),
  'coach-50': m({
    id: 'coach-50',
    name: '大型高速バス 50',
    mode: 'bus',
    capacity: 50,
    maxSpeedKmh: 100,
    rangeKm: Infinity,
    purchasePrice: 38_000_000,
    costPerKm: 55,
    crewPerHour: 3_000,
    fixedPerDay: 16_000,
    feePerDeparture: 0,
    tollPerKm: 36,
    tollClasses: [0],
    dwellMin: 25,
    visual: 'coach',
  }),
  // ---------------------------------------------------------------- rail
  'dmu-2': m({
    id: 'dmu-2',
    name: '気動車 2両 (120席)',
    mode: 'rail',
    capacity: 120,
    maxSpeedKmh: 110,
    rangeKm: Infinity,
    purchasePrice: 110_000_000,
    costPerKm: 170,
    crewPerHour: 5_500,
    fixedPerDay: 40_000,
    feePerDeparture: 3_000,
    tollPerKm: 150,
    tollClasses: [0, 1, 2],
    dwellMin: 12,
    visual: 'train:2',
  }),
  'emu-6': m({
    id: 'emu-6',
    name: '特急電車 6両 (380席)',
    mode: 'rail',
    capacity: 380,
    maxSpeedKmh: 130,
    rangeKm: Infinity,
    purchasePrice: 320_000_000,
    costPerKm: 380,
    crewPerHour: 8_000,
    fixedPerDay: 110_000,
    feePerDeparture: 8_000,
    tollPerKm: 340,
    tollClasses: [0, 1, 2],
    dwellMin: 12,
    visual: 'train:6',
  }),
  // ---------------------------------------------------------------- air
  'turboprop-70': m({
    id: 'turboprop-70',
    name: 'ターボプロップ機 (70席)',
    mode: 'air',
    capacity: 70,
    maxSpeedKmh: 510,
    rangeKm: 1_600,
    purchasePrice: 230_000_000,
    costPerKm: 330,
    crewPerHour: 22_000,
    fixedPerDay: 140_000,
    feePerDeparture: 80_000,
    tollPerKm: 0,
    tollClasses: [],
    dwellMin: 40,
    visual: 'plane:prop',
  }),
  'jet-180': m({
    id: 'jet-180',
    name: 'ナローボディ機 (180席)',
    mode: 'air',
    capacity: 180,
    maxSpeedKmh: 830,
    rangeKm: 6_000,
    purchasePrice: 680_000_000,
    costPerKm: 820,
    crewPerHour: 42_000,
    fixedPerDay: 360_000,
    feePerDeparture: 220_000,
    tollPerKm: 0,
    tollClasses: [],
    dwellMin: 50,
    visual: 'plane:jet',
  }),
  'widebody-300': m({
    id: 'widebody-300',
    name: 'ワイドボディ機 (300席)',
    mode: 'air',
    capacity: 300,
    maxSpeedKmh: 900,
    rangeKm: 13_500,
    purchasePrice: 1_600_000_000,
    costPerKm: 1_500,
    crewPerHour: 80_000,
    fixedPerDay: 780_000,
    feePerDeparture: 480_000,
    tollPerKm: 0,
    tollClasses: [],
    dwellMin: 75,
    visual: 'plane:wide',
  }),
  // ---------------------------------------------------------------- ship
  'ferry-400': m({
    id: 'ferry-400',
    name: 'フェリー (400人)',
    mode: 'ship',
    capacity: 400,
    maxSpeedKmh: 40,
    rangeKm: Infinity,
    purchasePrice: 130_000_000,
    costPerKm: 520,
    crewPerHour: 16_000,
    fixedPerDay: 90_000,
    feePerDeparture: 45_000,
    tollPerKm: 0,
    tollClasses: [],
    dwellMin: 60,
    visual: 'ship',
  }),
};

export function modelsFor(mode: Mode): VehicleModel[] {
  return Object.values(VEHICLE_MODELS).filter(v => v.mode === mode);
}

export interface FarePolicy {
  /** multiplier on the market reference fare (1 = market rate) */
  multiplier: number;
}

/** Typical market fare for a highway-bus trip of the given length (¥). */
export function referenceFare(distanceKm: number): number {
  return referenceFareFor('bus', distanceKm);
}

export function ticketPrice(distanceKm: number, policy: FarePolicy, mode: Mode = 'bus'): number {
  // Round to ¥10 like real ticket tables.
  return Math.round((referenceFareFor(mode, distanceKm) * policy.multiplier) / 10) * 10;
}
