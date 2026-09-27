// Spherical geometry helpers. Pure math — no rendering dependencies.

export interface LatLng {
  lat: number;
  lng: number;
}

export const EARTH_RADIUS_KM = 6371.0088;
const toRad = Math.PI / 180;
const toDeg = 180 / Math.PI;

export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing from a to b, degrees clockwise from north (0..360). */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const φ1 = a.lat * toRad;
  const φ2 = b.lat * toRad;
  const Δλ = (b.lng - a.lng) * toRad;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * toDeg + 360) % 360;
}

/** Great-circle interpolation (slerp) between a and b, t ∈ [0,1]. */
export function interpolate(a: LatLng, b: LatLng, t: number): LatLng {
  const φ1 = a.lat * toRad, λ1 = a.lng * toRad;
  const φ2 = b.lat * toRad, λ2 = b.lng * toRad;
  const x1 = Math.cos(φ1) * Math.cos(λ1), y1 = Math.cos(φ1) * Math.sin(λ1), z1 = Math.sin(φ1);
  const x2 = Math.cos(φ2) * Math.cos(λ2), y2 = Math.cos(φ2) * Math.sin(λ2), z2 = Math.sin(φ2);
  const dot = Math.max(-1, Math.min(1, x1 * x2 + y1 * y2 + z1 * z2));
  const ω = Math.acos(dot);
  if (ω < 1e-12) return { lat: a.lat, lng: a.lng };
  const s = Math.sin(ω);
  const k1 = Math.sin((1 - t) * ω) / s;
  const k2 = Math.sin(t * ω) / s;
  const x = k1 * x1 + k2 * x2, y = k1 * y1 + k2 * y2, z = k1 * z1 + k2 * z2;
  return { lat: Math.atan2(z, Math.hypot(x, y)) * toDeg, lng: Math.atan2(y, x) * toDeg };
}

/** A polyline with cumulative distances, supporting lookups by distance along it. */
export class Polyline {
  readonly points: readonly LatLng[];
  /** cumulative distance (km) at each vertex */
  readonly cumKm: Float64Array;
  readonly lengthKm: number;

  constructor(points: readonly LatLng[]) {
    if (points.length < 2) throw new Error('Polyline needs at least two points');
    this.points = points;
    this.cumKm = new Float64Array(points.length);
    for (let i = 1; i < points.length; i++) this.cumKm[i] = this.cumKm[i - 1] + haversineKm(points[i - 1], points[i]);
    this.lengthKm = this.cumKm[points.length - 1];
  }

  /** Index i of the segment [i, i+1] containing distance d. */
  segmentAt(dKm: number): number {
    const d = Math.max(0, Math.min(this.lengthKm, dKm));
    let lo = 0, hi = this.points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cumKm[mid] <= d) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Position and heading at distance d along the line. */
  pointAt(dKm: number): { pos: LatLng; headingDeg: number; segment: number } {
    const d = Math.max(0, Math.min(this.lengthKm, dKm));
    const i = this.segmentAt(d);
    const a = this.points[i], b = this.points[i + 1];
    const seg = this.cumKm[i + 1] - this.cumKm[i];
    const t = seg > 0 ? (d - this.cumKm[i]) / seg : 0;
    return { pos: interpolate(a, b, t), headingDeg: bearingDeg(a, b), segment: i };
  }

  /** Smoothed heading: averages the bearing over a window around d (avoids jitter at vertices). */
  headingAt(dKm: number, windowKm = 0.6): number {
    const a = this.pointAt(dKm - windowKm).pos;
    const b = this.pointAt(dKm + windowKm).pos;
    if (haversineKm(a, b) < 1e-6) return this.pointAt(dKm).headingDeg;
    return bearingDeg(a, b);
  }
}
