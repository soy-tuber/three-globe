// Vehicles shuttle back and forth along a route: dwell at a stop, drive a leg, repeat.
import type { LatLng } from './geo';
import { ROAD_SPEED_KMH, RoadClass } from './roadGraph';
import type { RouteState, Leg } from './route';

export type VehicleStatus = 'dwell' | 'drive';

export interface VehicleState {
  id: string;
  name: string;
  modelId: string;
  routeId: string;
  status: VehicleStatus;
  /** stop the vehicle is at (dwell) or departed from (drive) */
  stopIndex: number;
  /** travel direction along the stop list */
  dir: 1 | -1;
  /** progress along the current leg in the direction of travel, km */
  legKm: number;
  /** legKm at the previous step (for render interpolation) */
  prevLegKm: number;
  dwellLeftMin: number;
  speedKmh: number;
  /** onboard passengers keyed by destination stop index */
  onboard: Record<number, number>;
  odometerKm: number;
  /** revenue earned since the last departure from a terminal */
  tripRevenue: number;
}

export function onboardCount(v: VehicleState): number {
  let n = 0;
  for (const k in v.onboard) n += v.onboard[k];
  return n;
}

/** The leg a driving vehicle is on, and whether it traverses it backwards. */
export function currentLeg(v: VehicleState, r: RouteState): { leg: Leg; reversed: boolean } {
  if (v.dir === 1) return { leg: r.legs[v.stopIndex], reversed: false };
  return { leg: r.legs[v.stopIndex - 1], reversed: true };
}

export function nextStopIndex(v: VehicleState): number {
  return v.status === 'dwell' ? v.stopIndex : v.stopIndex + v.dir;
}

/** Road class under the vehicle. */
export function roadClassAt(leg: Leg, reversed: boolean, legKm: number): RoadClass {
  const d = reversed ? leg.lengthKm - legKm : legKm;
  return leg.segmentClass[Math.min(leg.segmentClass.length - 1, leg.line.segmentAt(d))] as RoadClass;
}

/** Target speed given the road and the distance left to the next stop. */
export function targetSpeedKmh(maxSpeedKmh: number, cls: RoadClass, remainingKm: number): number {
  const road = Math.min(maxSpeedKmh, ROAD_SPEED_KMH[cls]);
  // v² = 2·a·d with a ≈ 1 m/s² (12 960 km/h²) — a gentle stop at the terminal.
  const braking = Math.sqrt(2 * 12_960 * Math.max(0, remainingKm));
  return Math.max(6, Math.min(road, braking));
}

/** Acceleration toward the target, km/h per minute. */
export const ACCEL_KMH_PER_MIN = 240;

export interface VehiclePose {
  pos: LatLng;
  /** degrees clockwise from north */
  headingDeg: number;
  speedKmh: number;
  status: VehicleStatus;
}

/** Pose at a fractional step (alpha ∈ [0,1]) between the previous and current state. */
export function vehiclePose(v: VehicleState, r: RouteState, alpha = 1): VehiclePose {
  if (v.status === 'dwell') {
    // Park at the stop facing the leg of the next departure (dir is already turned at terminals).
    const forward = v.dir === 1;
    const leg = forward ? r.legs[v.stopIndex] : r.legs[v.stopIndex - 1];
    const d = forward ? 0 : leg.lengthKm;
    const heading = leg.line.headingAt(d) + (forward ? 0 : 180);
    return { pos: leg.line.pointAt(d).pos, headingDeg: heading % 360, speedKmh: 0, status: 'dwell' };
  }
  const { leg, reversed } = currentLeg(v, r);
  const km = v.prevLegKm + (v.legKm - v.prevLegKm) * alpha;
  const d = reversed ? leg.lengthKm - km : km;
  const p = leg.line.pointAt(d);
  const heading = leg.line.headingAt(d) + (reversed ? 180 : 0);
  return { pos: p.pos, headingDeg: heading % 360, speedKmh: v.speedKmh, status: 'drive' };
}
