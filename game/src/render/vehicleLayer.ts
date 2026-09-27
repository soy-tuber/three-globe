// Vehicles: Kenney glTF models placed on the terrain and oriented along the road.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type ThreeGlobe from 'three-globe';
import type { VehiclePose } from '../sim/vehicle';
import type { Terrain } from './terrain';
import { polarToCartesian } from './terrain';

/** Kenney car-kit models are ~2.75 units long, front on +Z, left on +X, up on +Y. */
const MODEL_LENGTH = 2.75;
/** On-screen length of a vehicle, in CSS pixels (clamped by real-world scale when very close). */
const SCREEN_LENGTH_PX = 40;

interface VehicleVisual {
  root: THREE.Group;
  model: THREE.Object3D;
  wheels: THREE.Object3D[];
  shadow: THREE.Mesh;
  ring: THREE.Mesh;
  wheelAngle: number;
}

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

  constructor(
    globe: ThreeGlobe,
    private readonly terrain: Terrain,
  ) {
    this.group.name = 'vehicles';
    globe.add(this.group);
  }

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

  add(id: string, modelUrl: string, color: string) {
    const template = this.templates.get(modelUrl);
    if (!template) throw new Error(`model not loaded: ${modelUrl}`);
    const model = template.clone(true);
    const wheels: THREE.Object3D[] = [];
    model.traverse(o => o.name.startsWith('wheel') && wheels.push(o));

    // Soft contact shadow + selection ring, in the model's ground plane.
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(1, 32),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `varying vec2 vUv; void main(){ float d = length(vUv-0.5)*2.0; gl_FragColor = vec4(0.0,0.0,0.0, 0.45*smoothstep(1.0,0.2,d)); }`,
      }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.scale.set(1.1, 1.8, 1);
    shadow.position.y = 0.02;

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.75, 2.0, 64),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    ring.visible = false;

    const root = new THREE.Group();
    root.add(shadow, ring, model);
    this.group.add(root);
    this.visuals.set(id, { root, model, wheels, shadow, ring, wheelAngle: 0 });
  }

  /** World position of a vehicle (for UI overlays), or null. */
  worldPosition(id: string, out = new THREE.Vector3()): THREE.Vector3 | null {
    const v = this.visuals.get(id);
    return v ? v.root.getWorldPosition(out) : null;
  }

  update(id: string, pose: VehiclePose, camera: THREE.PerspectiveCamera, viewportHeight: number, dt: number, time: number) {
    const v = this.visuals.get(id);
    if (!v) return;
    const { lat, lng } = pose.pos;
    const alt = this.terrain.altitudeAt(lat, lng);

    polarToCartesian(lat, lng, 100 * (1 + alt) + 0.0004, v.root.position);

    // Local frame → model basis (left, up, forward).
    this.up.copy(v.root.position).normalize();
    this.east.set(0, 1, 0).cross(this.up).normalize();
    this.north.copy(this.up).cross(this.east);
    const h = (pose.headingDeg * Math.PI) / 180;
    this.fwd.copy(this.north).multiplyScalar(Math.cos(h)).addScaledVector(this.east, Math.sin(h));
    this.left.copy(this.up).cross(this.fwd);
    this.basis.makeBasis(this.left, this.up, this.fwd);
    const target = new THREE.Quaternion().setFromRotationMatrix(this.basis);
    // Smooth out heading changes at polyline vertices.
    v.root.quaternion.slerp(target, 1 - Math.exp(-dt * 12));
    if (v.root.quaternion.angleTo(target) > 1.2) v.root.quaternion.copy(target);

    // Screen-constant size.
    const dist = camera.position.distanceTo(v.root.position);
    const pxToWorld = (2 * Math.tan((camera.fov * Math.PI) / 360)) / viewportHeight;
    // Slightly smaller from orbit so the vehicle doesn't blanket the map.
    const px = SCREEN_LENGTH_PX * (0.65 + 0.35 * Math.min(1, 12 / Math.max(1, camera.position.length() - 100)));
    const len = px * pxToWorld * dist;
    v.root.scale.setScalar(len / MODEL_LENGTH);

    // Wheels spin with speed; a little suspension bob while driving.
    v.wheelAngle += (pose.speedKmh / 3.6 / 0.45) * dt * 0.08;
    for (const w of v.wheels) w.rotation.x = v.wheelAngle;
    v.model.position.y = pose.status === 'drive' ? Math.sin(time * 18) * 0.015 : 0;

    const selected = this.selectedId === id;
    v.ring.visible = selected;
    if (selected) {
      const s = 1 + 0.08 * Math.sin(time * 4);
      v.ring.scale.set(s, s, s);
    }
  }
}
