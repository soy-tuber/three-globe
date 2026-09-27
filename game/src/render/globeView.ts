// Owns the renderer, scene and all visual layers. Knows nothing about game rules:
// the game feeds it poses and state each frame.
import * as THREE from 'three';
import ThreeGlobe from 'three-globe';
import type { City } from '../sim/model';
import type { PoseFn } from './vehicleLayer';
import { CameraRig } from './cameraRig';
import { CityLayer } from './cityLayer';
import { RouteLayer, type RouteDrawing } from './routeLayer';
import { Sky } from './sky';
import { createStarfield } from './stars';
import { realSunDirection, studioSunDirection } from './sun';
import { Terrain } from './terrain';
import type { TerrainRegion } from './terrainData';
import { VehicleLayer } from './vehicleLayer';

export class GlobeView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly globe: ThreeGlobe;
  readonly terrain: Terrain;
  readonly cities: CityLayer;
  readonly routes: RouteLayer;
  readonly vehicles: VehicleLayer;
  readonly overlay: HTMLDivElement;

  /** real day/night lighting instead of the camera-following studio light */
  realSun = false;

  private readonly sky = new Sky();
  private readonly stars = createStarfield();
  private readonly sunDir = new THREE.Vector3();
  private readonly keyLight = new THREE.DirectionalLight(0xfff4e6, 2.4);
  private readonly hemiLight = new THREE.HemisphereLight(0xcfe3ff, 0x40506a, 1.1);
  private frameCount = 0;
  private width = 1;
  private height = 1;

  constructor(
    private readonly container: HTMLElement,
    regions: TerrainRegion[],
    cities: City[],
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = 'globe-canvas';
    container.appendChild(this.renderer.domElement);

    this.overlay = document.createElement('div');
    this.overlay.className = 'globe-overlay';
    container.appendChild(this.overlay);

    this.scene.background = new THREE.Color('#02040a');
    this.scene.add(this.stars, this.sky.mesh, this.keyLight, this.keyLight.target, this.hemiLight);

    this.rig = new CameraRig(this.renderer.domElement, 1);

    this.terrain = new Terrain(regions);
    this.globe = new ThreeGlobe({ animateIn: false })
      .showAtmosphere(true)
      .atmosphereColor('#86c3ff')
      .atmosphereAltitude(0.14);
    this.terrain.attach(this.globe);
    this.scene.add(this.globe);
    this.rig.surfaceAltitude = (lat, lng) => this.terrain.altitudeAt(lat, lng) * 100;

    this.routes = new RouteLayer(this.globe, this.terrain);
    this.cities = new CityLayer(this.globe, this.terrain, cities, this.overlay, this.renderer.domElement);
    this.vehicles = new VehicleLayer(this.globe, this.terrain);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  setRoutes(routes: RouteDrawing[]) {
    this.routes.setRoutes(routes);
  }

  setExaggeration(v: number) {
    this.terrain.exaggeration = v;
    this.routes.invalidate();
    this.cities.refreshAltitudes();
  }

  resize() {
    this.width = this.container.clientWidth || window.innerWidth;
    this.height = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(this.width, this.height);
    this.rig.setAspect(this.width / this.height);
    this.routes.setResolution(this.width, this.height);
  }

  get viewportHeight() {
    return this.height;
  }

  private readonly projTmp = new THREE.Vector3();
  /** Screen position (CSS px) of a world point, and whether it is on the visible hemisphere. */
  project(world: THREE.Vector3): { x: number; y: number; visible: boolean } {
    const cam = this.rig.camera;
    const facing = this.projTmp.copy(world).normalize().dot(cam.position.clone().sub(world).normalize());
    const inFront = this.projTmp.copy(world).applyMatrix4(cam.matrixWorldInverse).z < 0;
    this.projTmp.copy(world).project(cam);
    return {
      x: (this.projTmp.x * 0.5 + 0.5) * this.width,
      y: (-this.projTmp.y * 0.5 + 0.5) * this.height,
      visible: inFront && facing > 0,
    };
  }

  updateVehicle(id: string, poseAt: PoseFn, dt: number, time: number) {
    this.vehicles.update(id, poseAt, this.rig.camera, this.height, dt, time);
  }

  updateCamera(dt: number) {
    this.rig.update(dt);
  }

  /** Render one frame (call updateCamera first). `simMs` drives the real sun position. */
  render(dt: number, time: number, simMs: number) {
    const cam = this.rig.camera;

    if (this.realSun) realSunDirection(simMs, this.sunDir);
    else studioSunDirection(cam, this.sunDir);
    const altitude = cam.position.length() - 100;
    this.terrain.update(time, this.sunDir, this.realSun, dt, altitude);

    // Daylight at the camera's target, for the sky dome and model lighting.
    const day = this.realSun
      ? THREE.MathUtils.smoothstep(this.sunDir.dot(cam.position.clone().normalize()), -0.15, 0.2)
      : 1;
    this.sky.update(cam, day);
    (this.stars.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 1 - this.sky.alpha;
    this.stars.position.copy(cam.position);

    this.keyLight.position.copy(this.sunDir).multiplyScalar(300);
    this.keyLight.intensity = 0.4 + 2.2 * day;
    this.hemiLight.intensity = 0.5 + 0.7 * day;

    this.cities.update(cam, this.width, this.height);
    if ((this.frameCount++ & 15) === 0) this.routes.fixDrawOrder();
    this.globe.setPointOfView(cam);
    this.renderer.render(this.scene, cam);
  }
}
