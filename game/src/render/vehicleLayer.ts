// Vehicles: Kenney glTF models or procedural ones, placed on the terrain (or in the air) and
// oriented along their path. Trains are drawn as several cars, each posed along the track.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type ThreeGlobe from 'three-globe';
import { airCruiseAltitude } from '../sim/modes';
import type { VehiclePose } from '../sim/vehicle';
import { aircraft, coach, ship, trainCar } from './models';
import type { Terrain } from './terrain';
import { polarToCartesian } from './terrain';

/** All models are ~2.75 units long, front on +Z, left on +X, up on +Y. */
const MODEL_LENGTH = 2.75;
/** On-screen length of a vehicle (one car of a train), in CSS pixels. */
const SCREEN_LENGTH_PX = 40;
const KM_PER_UNIT = 6371.0088 / 100;

interface Car {
  root: THREE.Group;
  model: THREE.Object3D;
  wheels: THREE.Object3D[];
  shadow: THREE.Mesh;
}

interface VehicleVisual {
  kind: string;
  cars: Car[];
  ring: THREE.Mesh;
  wheelAngle: number;
  wake: THREE.Mesh | null;
  props: THREE.Object3D[];
}

const shadowMaterial = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: { uOpacity: { value: 0.45 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform float uOpacity; varying vec2 vUv; void main(){ float d = length(vUv-0.5)*2.0; gl_FragColor = vec4(0.0,0.0,0.0, uOpacity*smoothstep(1.0,0.2,d)); }`,
});

export type PoseFn = (behindKm: number) => VehiclePose | null;

export class VehicleLayer {
  private readonly templates = new Map<string, THREE.Object3D>();
  private readonly visuals = new Map<string, VehicleVisual>();
  private readonly group = new THREE.Group();
  selectedId: string | null = null;

  private readonly up = new THREE.Vector3();
  private readonly east = new THREE.Vector3();
  private readonly north = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly left = new THREE.Vector3();
  private readonly basis = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pitch = new THREE.Quaternion();
  private readonly xAxis = new THREE.Vector3(1, 0, 0);

  constructor(
    globe: ThreeGlobe,
    private readonly terrain: Terrain,
  ) {
    this.group.name = 'vehicles';
    globe.add(this.group);
  }

  /** Preload glTF models referenced by `glb:` visuals. */
  async load(url: string) {
    if (this.templates.has(url)) return;
    const gltf = await new GLTFLoader().loadAsync(url);
    gltf.scene.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        const m = mesh.material as THREE.MeshStandardMaterial;
        m.roughness = 0.55;
        m.metalness = 0.05;
      }
    });
    this.templates.set(url, gltf.scene);
  }

  private buildCars(visual: string, color: string, baseUrl: string): Car[] {
    const makeCar = (model: THREE.Object3D): Car => {
      const wheels: THREE.Object3D[] = [];
      model.traverse(o => o.name.startsWith('wheel') && wheels.push(o));
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(1, 24), shadowMaterial);
      shadow.rotation.x = -Math.PI / 2;
      shadow.scale.set(0.9, 1.6, 1);
      shadow.position.y = 0.02;
      const root = new THREE.Group();
      root.add(shadow, model);
      this.group.add(root);
      return { root, model, wheels, shadow };
    };
    if (visual.startsWith('glb:')) {
      const url = baseUrl + visual.slice(4);
      const t = this.templates.get(url);
      if (!t) throw new Error(`model not loaded: ${url}`);
      return [makeCar(t.clone(true))];
    }
    if (visual.startsWith('train:')) {
      const n = Math.max(2, Number(visual.slice(6)) || 2);
      // Draw at most 4 cars; long trains read fine as lead + middle + tail.
      const shown = Math.min(n, 4);
      return Array.from({ length: shown }, (_, i) => makeCar(trainCar(color, i === 0 ? 'lead' : i === shown - 1 ? 'tail' : 'middle')));
    }
    if (visual.startsWith('plane:')) return [makeCar(aircraft(color, visual.slice(6) as 'prop' | 'jet' | 'wide'))];
    if (visual === 'ship') return [makeCar(ship(color))];
    return [makeCar(coach(color))];
  }

  add(id: string, visual: string, color: string, baseUrl = '') {
    this.remove(id);
    const cars = this.buildCars(visual, color, baseUrl);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.75, 2.0, 64),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    ring.visible = false;
    cars[0].root.add(ring);
    let wake: THREE.Mesh | null = null;
    const props: THREE.Object3D[] = [];
    cars[0].model.traverse(o => {
      if (o.name === 'wake') wake = o as THREE.Mesh;
      if (o.name === 'propeller') props.push(o);
    });
    this.visuals.set(id, { kind: visual, cars, ring, wheelAngle: 0, wake, props });
  }

  remove(id: string) {
    const v = this.visuals.get(id);
    if (!v) return;
    for (const c of v.cars) {
      this.group.remove(c.root);
      c.root.traverse(o => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.geometry) m.geometry.dispose();
      });
    }
    this.visuals.delete(id);
  }

  ids(): string[] {
    return [...this.visuals.keys()];
  }

  /** World position of a vehicle's lead car (for UI overlays), or null. */
  worldPosition(id: string, out = new THREE.Vector3()): THREE.Vector3 | null {
    const v = this.visuals.get(id);
    return v ? v.cars[0].root.getWorldPosition(out) : null;
  }

  private place(car: Car, pose: VehiclePose, len: number, dt: number, snap: boolean) {
    const { lat, lng } = pose.pos;
    const ground = this.terrain.altitudeAt(lat, lng);
    const air = pose.altitude01 > 0 ? pose.altitude01 * airCruiseAltitude(pose.legLengthKm) : 0;
    polarToCartesian(lat, lng, 100 * (1 + ground + air) + 0.0004, car.root.position);

    this.up.copy(car.root.position).normalize();
    this.east.set(0, 1, 0).cross(this.up).normalize();
    this.north.copy(this.up).cross(this.east);
    const h = (pose.headingDeg * Math.PI) / 180;
    this.fwd.copy(this.north).multiplyScalar(Math.cos(h)).addScaledVector(this.east, Math.sin(h));
    this.left.copy(this.up).cross(this.fwd);
    this.basis.makeBasis(this.left, this.up, this.fwd);
    this.q.setFromRotationMatrix(this.basis);
    if (pose.climb) this.q.multiply(this.pitch.setFromAxisAngle(this.xAxis, -pose.climb * 0.22));
    // Smooth heading changes at polyline vertices (snap when jumping, e.g. at a terminal U-turn).
    if (snap || car.root.quaternion.angleTo(this.q) > 1.2) car.root.quaternion.copy(this.q);
    else car.root.quaternion.slerp(this.q, 1 - Math.exp(-dt * 12));

    car.root.scale.setScalar(len / MODEL_LENGTH);
    // Aircraft cast no contact shadow once airborne.
    car.shadow.visible = pose.altitude01 < 0.02;
  }

  update(id: string, poseAt: PoseFn, camera: THREE.PerspectiveCamera, viewportHeight: number, dt: number, time: number) {
    const v = this.visuals.get(id);
    if (!v) return;
    const lead = poseAt(0);
    if (!lead) return;

    // Screen-constant size, slightly smaller from orbit so vehicles don't blanket the map.
    const pos0 = v.cars[0].root.position;
    const dist = camera.position.distanceTo(pos0.lengthSq() > 0 ? pos0 : camera.position.clone().setLength(100));
    const pxToWorld = (2 * Math.tan((camera.fov * Math.PI) / 360)) / viewportHeight;
    const altitude = camera.position.length() - 100;
    const px = SCREEN_LENGTH_PX * (0.65 + 0.35 * Math.min(1, 12 / Math.max(1, altitude)));
    const len = px * pxToWorld * dist;

    const first = !v.cars[0].root.userData.placed;
    this.place(v.cars[0], lead, len, dt, first);
    v.cars[0].root.userData.placed = true;
    for (let i = 1; i < v.cars.length; i++) {
      const p = poseAt(i * len * 1.04 * KM_PER_UNIT);
      if (p) this.place(v.cars[i], p, len, dt, first);
    }

    // Wheels, propellers, suspension bob, wake.
    v.wheelAngle += (lead.speedKmh / 3.6 / 0.45) * dt * 0.08;
    for (const c of v.cars) for (const w of c.wheels) w.rotation.x = v.wheelAngle;
    for (const p of v.props) p.visible = lead.speedKmh > 1 || lead.status === 'dwell';
    if (!v.kind.startsWith('plane') && !v.kind.startsWith('ship') && !v.kind.startsWith('train'))
      v.cars[0].model.position.y = lead.status === 'drive' ? Math.sin(time * 18) * 0.015 : 0;
    if (v.wake) ((v.wake.material as THREE.ShaderMaterial).uniforms.uStrength.value = Math.min(1, lead.speedKmh / 25));

    const selected = this.selectedId === id;
    v.ring.visible = selected && lead.altitude01 < 0.02;
    if (selected) v.ring.scale.setScalar(1 + 0.08 * Math.sin(time * 4));
  }
}
