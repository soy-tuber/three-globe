// Transport modes and their physical / market characteristics.

export type Mode = 'bus' | 'rail' | 'air' | 'ship';
export const MODES: Mode[] = ['bus', 'rail', 'air', 'ship'];

export interface ModeInfo {
  name: string;
  icon: string;
  /** free-flow speed (km/h) per segment class; class 3 is always the station/port access leg */
  speedKmh: [number, number, number, number];
  /** braking deceleration, km/h² (v² = 2·a·d) */
  decelKmh2: number;
  minSpeedKmh: number;
  /** door-to-door overhead: getting to the station, check-in, security … (hours) */
  accessHours: number;
  /** mode preference (comfort, image) in the choice model, in utility units */
  asc: number;
  /** how costly time aboard feels relative to other modes (overnight ferries with cabins ≪ 1) */
  votFactor: number;
  /** market reference fare = base + perKm · km */
  refFare: { base: number; perKm: number };
  /** routes shorter than this (km, great-circle) make no sense for the mode */
  minDistanceKm: number;
  /** how a leg between stops is found */
  pathing: 'road' | 'rail' | 'great-circle' | 'sea';
}

export const MODE_INFO: Record<Mode, ModeInfo> = {
  bus: {
    name: 'バス',
    icon: '🚌',
    speedKmh: [88, 52, 40, 24],
    decelKmh2: 12_960,
    minSpeedKmh: 6,
    accessHours: 0.4,
    asc: 0,
    votFactor: 1,
    refFare: { base: 700, perKm: 10.5 },
    minDistanceKm: 20,
    pathing: 'road',
  },
  rail: {
    name: '鉄道',
    icon: '🚆',
    speedKmh: [125, 90, 40, 30],
    decelKmh2: 10_000,
    minSpeedKmh: 10,
    accessHours: 0.4,
    asc: 0.3,
    votFactor: 1,
    refFare: { base: 1000, perKm: 16 },
    minDistanceKm: 20,
    pathing: 'rail',
  },
  air: {
    name: '航空',
    icon: '✈️',
    speedKmh: [820, 820, 820, 260],
    decelKmh2: 3_000,
    minSpeedKmh: 240,
    accessHours: 2,
    asc: 0.3,
    votFactor: 1,
    refFare: { base: 6000, perKm: 12 },
    minDistanceKm: 150,
    pathing: 'great-circle',
  },
  ship: {
    name: '船',
    icon: '🚢',
    speedKmh: [38, 38, 38, 12],
    decelKmh2: 600,
    minSpeedKmh: 6,
    accessHours: 0.8,
    asc: -0.1,
    votFactor: 0.35,
    refFare: { base: 1500, perKm: 7 },
    minDistanceKm: 20,
    pathing: 'sea',
  },
};

export function referenceFareFor(mode: Mode, distanceKm: number): number {
  const f = MODE_INFO[mode].refFare;
  return f.base + f.perKm * distanceKm;
}

/**
 * Air legs: fraction (0..1) of cruise altitude at distance d along a leg of length L.
 * Shared by the simulation (pose) and the renderer (drawn arc), so the plane flies on its line.
 */
export function airAltitude01(dKm: number, legKm: number): number {
  const climb = Math.min(220, legKm * 0.3);
  const s = (x: number) => {
    const t = Math.max(0, Math.min(1, x));
    return t * t * (3 - 2 * t);
  };
  return Math.min(s(dKm / climb), s((legKm - dKm) / climb));
}

/** Visual cruise altitude of an air leg, as a fraction of the globe radius (render & sim agree). */
export function airCruiseAltitude(legKm: number): number {
  return Math.max(0.004, Math.min(0.05, (legKm / 6371) * 0.16));
}
