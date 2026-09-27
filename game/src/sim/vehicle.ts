// Vehicles shuttle back and forth along a route: dwell at a stop, travel a leg, repeat.
import type { LatLng } from './geo';
import type { SegClass } from './graph';
import { MODE_INFO, airAltitude01, type Mode } from './modes';
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
  /** revenue earned at the last departure */
  tripRevenue: number;
  purchasePrice: number;
}

export function onboardCount(v: VehicleState): number {
  let n = 0;
  for (const k in v.onboard) n += v.onboard[k];
  return n;
}

/** The leg a moving vehicle is on, and whether it traverses it backwards. */
export function currentLeg(v: VehicleState, r: RouteState): { leg: Leg; reversed: boolean } {
  if (v.dir === 1) return { leg: r.legs[v.stopIndex], reversed: false };
  return { leg: r.legs[v.stopIndex - 1], reversed: true };
}

/** Segment class under the vehicle. */
export function segClassAt(leg: Leg, reversed: boolean, legKm: number): SegClass {
  const d = reversed ? leg.lengthKm - legKm : legKm;
  return leg.segmentClass[Math.min(leg.segmentClass.length - 1, leg.line.segmentAt(d))] as SegClass;
}

/** Target speed given the network, the vehicle and the distance left to the next stop. */
export function targetSpeedKmh(mode: Mode, maxSpeedKmh: number, cls: SegClass, remainingKm: number): number {
  const info = MODE_INFO[mode];
  const cruise = Math.min(maxSpeedKmh, info.speedKmh[cls]);
  const braking = Math.sqrt(2 * info.decelKmh2 * Math.max(0, remainingKm));
  return Math.max(Math.min(info.minSpeedKmh, cruise), Math.min(cruise, braking));
}

/** Acceleration toward the target, km/h per minute. */
export const ACCEL_KMH_PER_MIN: Record<Mode, number> = { bus: 240, rail: 200, air: 900, ship: 60 };

export interface VehiclePose {
  pos: LatLng;
  /** degrees clockwise from north */
  headingDeg: number;
  speedKmh: number;
  status: VehicleStatus;
  /** 0..1 of cruise altitude (air only; 0 on the ground) */
  altitude01: number;
  /** climb (+) / descent (−) indicator for pitching aircraft, −1..1 */
  climb: number;
  /** length of the current (or next) leg, km — the air arc height depends on it */
  legLengthKm: number;
}

/**
 * Pose at a fractional step (alpha ∈ [0,1]), optionally `behindKm` further back along the path
 * (used for the cars of a train). Positions behind the start of the leg clamp to the stop.
 */
export function vehiclePose(v: VehicleState, r: RouteState, alpha = 1, behindKm = 0): VehiclePose {
  if (v.status === 'dwell') {
    // Parked at the stop, facing the leg of the next departure (dir is already turned at terminals);
    // trailing cars line up behind along the same leg.
    const forward = v.dir === 1;
    const leg = forward ? r.legs[v.stopIndex] : r.legs[v.stopIndex - 1];
    const d = forward ? Math.min(leg.lengthKm, behindKm) : Math.max(0, leg.lengthKm - behindKm);
    const heading = leg.line.headingAt(d) + (forward ? 0 : 180);
    return {
      pos: leg.line.pointAt(d).pos,
      headingDeg: heading % 360,
      speedKmh: 0,
      status: 'dwell',
      altitude01: 0,
      climb: 0,
      legLengthKm: leg.lengthKm,
    };
  }
  const { leg, reversed } = currentLeg(v, r);
  const km = Math.max(0, v.prevLegKm + (v.legKm - v.prevLegKm) * alpha - behindKm);
  const d = reversed ? leg.lengthKm - km : km;
  const heading = leg.line.headingAt(d) + (reversed ? 180 : 0);
  let altitude01 = 0, climb = 0;
  if (r.mode === 'air') {
    altitude01 = airAltitude01(km, leg.lengthKm);
    climb = airAltitude01(km + 5, leg.lengthKm) - airAltitude01(km - 5, leg.lengthKm);
  }
  return {
    pos: leg.line.pointAt(d).pos,
    headingDeg: heading % 360,
    speedKmh: v.speedKmh,
    status: 'drive',
    altitude01,
    climb: Math.max(-1, Math.min(1, climb * 8)),
    legLengthKm: leg.lengthKm,
  };
}
