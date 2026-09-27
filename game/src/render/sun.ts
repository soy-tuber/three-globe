// Sun direction: either the real subsolar point for the game time, or a "studio" key light
// that follows the camera so relief always reads well.
import * as THREE from 'three';
import { polarToCartesian } from './terrain';

/** Approximate subsolar point (good to ~1°) for a UTC timestamp. */
export function subsolarPoint(ms: number): { lat: number; lng: number } {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const dayOfYear = (ms - start) / 86_400_000;
  const g = ((2 * Math.PI) / 365.25) * (dayOfYear - 1);
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g);
  const eqTimeMin =
    229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const lng = -((utcMin + eqTimeMin) / 4 - 180);
  return { lat: (decl * 180) / Math.PI, lng: ((((lng + 180) % 360) + 360) % 360) - 180 };
}

export function realSunDirection(ms: number, out = new THREE.Vector3()) {
  const { lat, lng } = subsolarPoint(ms);
  return polarToCartesian(lat, lng, 1, out).normalize();
}

const right = new THREE.Vector3();
/** Key light from the upper-left of the view, slightly toward the camera. */
export function studioSunDirection(camera: THREE.Camera, out = new THREE.Vector3()) {
  right.setFromMatrixColumn(camera.matrixWorld, 0);
  return out
    .copy(camera.position)
    .normalize()
    .multiplyScalar(0.75)
    .addScaledVector(camera.up, 0.6)
    .addScaledVector(right, -0.5)
    .normalize();
}
