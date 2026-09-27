// Globe camera: orbit a surface target, tilt toward the horizon as you zoom in (like a map app).
import * as THREE from 'three';
import { polarToCartesian } from './terrain';

export interface CameraView {
  lat: number;
  lng: number;
  /** distance from the target point on the surface, in world units (globe radius = 100) */
  dist: number;
  /** degrees, clockwise from north */
  heading: number;
  /** user tilt offset added to the automatic tilt, degrees */
  tiltOffset: number;
}

const MIN_DIST = 0.18;
const MAX_DIST = 420;
const DEG = Math.PI / 180;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

interface Flight {
  from: CameraView;
  to: CameraView;
  t: number;
  duration: number;
  /** extra zoom-out at mid-flight, proportional to the angular distance */
  arc: number;
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  /** smoothed, rendered state */
  readonly view: CameraView = { lat: 36, lng: 138, dist: 60, heading: 0, tiltOffset: 0 };
  /** where input is steering to */
  readonly goal: CameraView = { ...this.view };

  /** surface height lookup (world units above radius 100) so we never dip under mountains */
  surfaceAltitude: (lat: number, lng: number) => number = () => 0;
  /** when set, the camera target tracks this each frame */
  follow: (() => { lat: number; lng: number } | null) | null = null;
  /** called on any direct camera manipulation */
  onInteract: () => void = () => {};

  private flight: Flight | null = null;
  private pointers = new Map<number, { x: number; y: number; button: number }>();
  private pinchStart: { dist: number; goalDist: number; angle: number; heading: number } | null = null;
  private readonly el: HTMLElement;

  constructor(el: HTMLElement, aspect: number) {
    this.el = el;
    this.camera = new THREE.PerspectiveCamera(40, aspect, 0.01, 1000);
    this.bindInput();
  }

  /** Automatic tilt (degrees) for a given distance: top-down from space, oblique near the ground. */
  static autoTilt(dist: number) {
    return 58 * (1 - smoothstep(1.2, 45, dist));
  }

  tilt(v: CameraView = this.view) {
    return Math.max(0, Math.min(72, CameraRig.autoTilt(v.dist) + v.tiltOffset));
  }

  flyTo(target: Partial<CameraView>, duration = 1.8) {
    const to = { ...this.goal, ...target };
    const angular = Math.acos(
      Math.min(
        1,
        Math.sin(this.view.lat * DEG) * Math.sin(to.lat * DEG) +
          Math.cos(this.view.lat * DEG) * Math.cos(to.lat * DEG) * Math.cos((to.lng - this.view.lng) * DEG),
      ),
    );
    this.flight = { from: { ...this.view }, to, t: 0, duration, arc: Math.min(250, angular * 160) };
    this.follow = null;
  }

  /** Direct manipulation cancels fly-to animations and vehicle following. */
  private cancelAutomation() {
    this.flight = null;
    this.follow = null;
    this.onInteract();
  }

  // ------------------------------------------------------------------ input

  private degPerPixel() {
    const h = this.el.clientHeight || 1;
    const worldPerPx = (2 * this.view.dist * Math.tan((this.camera.fov * DEG) / 2)) / h;
    return Math.min((worldPerPx / 100) / DEG, 0.6);
  }

  private pan(dx: number, dy: number) {
    const k = this.degPerPixel();
    const h = this.goal.heading * DEG;
    const mEast = -dx * Math.cos(h) + dy * Math.sin(h);
    const mNorth = dx * Math.sin(h) + dy * Math.cos(h);
    this.goal.lat = Math.max(-85, Math.min(85, this.goal.lat + mNorth * k));
    this.goal.lng = wrap180(this.goal.lng + (mEast * k) / Math.max(0.1, Math.cos(this.goal.lat * DEG)));
  }

  private zoom(factor: number) {
    this.goal.dist = Math.max(MIN_DIST, Math.min(MAX_DIST, this.goal.dist * factor));
  }

  private bindInput() {
    const el = this.el;
    el.addEventListener('contextmenu', e => e.preventDefault());

    el.addEventListener('pointerdown', e => {
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchStart = {
          dist: Math.hypot(a.x - b.x, a.y - b.y),
          goalDist: this.goal.dist,
          angle: Math.atan2(b.y - a.y, b.x - a.x),
          heading: this.goal.heading,
        };
      }
    });

    el.addEventListener('pointermove', e => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (dx === 0 && dy === 0) return;
      this.cancelAutomation();

      if (this.pointers.size >= 2 && this.pinchStart) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.goal.dist = Math.max(MIN_DIST, Math.min(MAX_DIST, this.pinchStart.goalDist * (this.pinchStart.dist / d)));
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        this.goal.heading = this.pinchStart.heading - (ang - this.pinchStart.angle) / DEG;
        return;
      }
      const rotate = p.button === 2 || p.button === 1 || e.shiftKey || e.ctrlKey;
      if (rotate) {
        this.goal.heading = (this.goal.heading + dx * 0.25 + 360) % 360;
        this.goal.tiltOffset = Math.max(-60, Math.min(60, this.goal.tiltOffset + dy * 0.2));
      } else {
        this.pan(dx, dy);
      }
    });

    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchStart = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    el.addEventListener(
      'wheel',
      e => {
        e.preventDefault();
        const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        // Zooming keeps following a vehicle; panning does not.
        this.flight = null;
        this.onInteract();
        this.zoom(Math.exp(delta * 0.0014));
      },
      { passive: false },
    );
  }

  // ------------------------------------------------------------------ per frame

  update(dt: number) {
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.duration);
      const k = easeInOut(f.t);
      const lngDelta = wrap180(f.to.lng - f.from.lng);
      this.goal.lat = f.from.lat + (f.to.lat - f.from.lat) * k;
      this.goal.lng = wrap180(f.from.lng + lngDelta * k);
      const logD = Math.log(f.from.dist) + (Math.log(f.to.dist) - Math.log(f.from.dist)) * k;
      this.goal.dist = Math.exp(logD) + f.arc * Math.sin(Math.PI * k);
      this.goal.heading = f.from.heading + wrap180(f.to.heading - f.from.heading) * k;
      this.goal.tiltOffset = f.from.tiltOffset + (f.to.tiltOffset - f.from.tiltOffset) * k;
      if (f.t >= 1) this.flight = null;
      Object.assign(this.view, this.goal);
    } else {
      const target = this.follow?.();
      if (target) {
        this.goal.lat = target.lat;
        this.goal.lng = target.lng;
      }
      const a = 1 - Math.exp(-dt * (target ? 6 : 10));
      const v = this.view, g = this.goal;
      v.lat += (g.lat - v.lat) * a;
      v.lng = wrap180(v.lng + wrap180(g.lng - v.lng) * a);
      v.dist = Math.exp(Math.log(v.dist) + (Math.log(g.dist) - Math.log(v.dist)) * a);
      v.heading = (v.heading + wrap180(g.heading - v.heading) * a + 360) % 360;
      v.tiltOffset += (g.tiltOffset - v.tiltOffset) * a;
    }
    this.applyToCamera();
  }

  private readonly tmp = {
    target: new THREE.Vector3(),
    up: new THREE.Vector3(),
    east: new THREE.Vector3(),
    north: new THREE.Vector3(),
    fwd: new THREE.Vector3(),
    dir: new THREE.Vector3(),
  };

  applyToCamera() {
    const { target, up, east, north, fwd, dir } = this.tmp;
    const v = this.view;
    const ground = this.surfaceAltitude(v.lat, v.lng);
    polarToCartesian(v.lat, v.lng, 100 + ground, target);
    up.copy(target).normalize();
    east.set(0, 1, 0).cross(up).normalize();
    north.copy(up).cross(east);
    const h = v.heading * DEG;
    fwd.copy(north).multiplyScalar(Math.cos(h)).addScaledVector(east, Math.sin(h));
    const t = this.tilt() * DEG;
    dir.copy(up).multiplyScalar(Math.cos(t)).addScaledVector(fwd, -Math.sin(t));

    this.camera.position.copy(target).addScaledVector(dir, v.dist);
    // Never below the terrain right under the camera.
    const camR = this.camera.position.length();
    const minR = 100 + ground + Math.max(0.03, v.dist * 0.15) * Math.cos(t);
    if (camR < minR) this.camera.position.multiplyScalar(minR / camR);

    this.camera.up.copy(fwd).multiplyScalar(Math.cos(t)).addScaledVector(up, Math.sin(t));
    this.camera.lookAt(target);

    // Keep depth precision where it matters.
    const altitude = this.camera.position.length() - 100;
    this.camera.near = Math.max(0.004, Math.min(altitude, v.dist) * 0.05);
    this.camera.far = v.dist + 260;
    this.camera.updateProjectionMatrix();
    // Overlays project with this frame's matrices, before the renderer would update them.
    this.camera.updateMatrixWorld();
  }

  setAspect(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
