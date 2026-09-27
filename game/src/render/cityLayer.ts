// Cities: 3D markers through three-globe's objects layer + a decluttered HTML label overlay.
import * as THREE from 'three';
import type ThreeGlobe from 'three-globe';
import type { City } from '../sim/model';
import type { Terrain } from './terrain';
import { polarToCartesian } from './terrain';

interface CityEntry {
  city: City;
  /** marker group created for three-globe */
  marker: THREE.Group;
  label: HTMLDivElement;
  badge: HTMLSpanElement;
  world: THREE.Vector3;
  screen: { x: number; y: number; visible: boolean };
  priority: number;
  shown: boolean;
  stopColor: string | null;
}

const MARKER_PX = 7;

function formatPopulation(p: number): string {
  if (p >= 1e6) return `${(p / 1e4).toFixed(0)}万`;
  return `${(p / 1e4).toFixed(1)}万`;
}

function makeMarker(isStop: boolean, color: string): THREE.Group {
  const g = new THREE.Group();
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(1, 32),
    new THREE.MeshBasicMaterial({ color: isStop ? color : '#ffffff', depthWrite: false, transparent: true }),
  );
  const outline = new THREE.Mesh(
    new THREE.RingGeometry(1, 1.45, 32),
    new THREE.MeshBasicMaterial({ color: '#0b1726', transparent: true, opacity: 0.85, depthWrite: false }),
  );
  dot.renderOrder = outline.renderOrder = 5;
  g.add(outline, dot);
  if (isStop) {
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(1.9, 2.4, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    halo.renderOrder = 5;
    g.add(halo);
  }
  return g;
}

export class CityLayer {
  readonly entries: CityEntry[];
  private readonly container: HTMLDivElement;
  private readonly tmp = new THREE.Vector3();
  private readonly toCam = new THREE.Vector3();
  onHover: (city: City | null, x: number, y: number) => void = () => {};
  onSelect: (city: City) => void = () => {};
  private hovered: CityEntry | null = null;

  constructor(
    private readonly globe: ThreeGlobe,
    private readonly terrain: Terrain,
    cities: City[],
    stops: Map<string, string>,
    overlay: HTMLElement,
    canvas: HTMLElement,
  ) {
    this.container = document.createElement('div');
    this.container.className = 'city-labels';
    overlay.appendChild(this.container);

    this.entries = cities.map(city => {
      const stopColor = stops.get(city.id) ?? null;
      const label = document.createElement('div');
      label.className = `city-label${stopColor ? ' is-stop' : ''}${city.population >= 1.5e6 ? ' is-major' : ''}`;
      if (stopColor) label.style.setProperty('--route', stopColor);
      label.innerHTML = `<span class="name">${city.name}</span><span class="pop">${formatPopulation(city.population)}</span>`;
      const badge = document.createElement('span');
      badge.className = 'badge';
      if (stopColor) label.appendChild(badge);
      this.container.appendChild(label);
      label.addEventListener('click', () => this.onSelect(city));
      return {
        city,
        marker: makeMarker(!!stopColor, stopColor ?? '#fff'),
        label,
        badge,
        world: new THREE.Vector3(),
        screen: { x: 0, y: 0, visible: false },
        priority: (stopColor ? 1e9 : 0) + city.population,
        shown: false,
        stopColor,
      };
    });
    this.entries.sort((a, b) => b.priority - a.priority);

    globe
      .objectsData(this.entries)
      .objectLat((d: object) => (d as CityEntry).city.lat)
      .objectLng((d: object) => (d as CityEntry).city.lng)
      .objectAltitude((d: object) => this.altitudeFor((d as CityEntry).city))
      .objectFacesSurface(true)
      .objectThreeObject((d: object) => (d as CityEntry).marker);

    canvas.addEventListener('pointermove', e => this.pick(e.clientX, e.clientY));
    canvas.addEventListener('pointerleave', () => this.setHover(null, 0, 0));
    canvas.addEventListener('click', e => {
      const hit = this.hitTest(e.clientX, e.clientY);
      if (hit) this.onSelect(hit.city);
    });
  }

  private altitudeFor(city: City) {
    return this.terrain.altitudeAt(city.lat, city.lng) + 0.00004;
  }

  /** Re-place markers after the terrain exaggeration changes. */
  refreshAltitudes() {
    this.globe.objectsData([...this.entries]);
  }

  setBadge(cityId: string, text: string) {
    const e = this.entries.find(x => x.city.id === cityId);
    if (e && e.badge.textContent !== text) {
      e.badge.textContent = text;
      e.badge.classList.toggle('empty', text === '');
    }
  }

  private hitTest(x: number, y: number): CityEntry | null {
    let best: CityEntry | null = null, bestD = 16;
    for (const e of this.entries) {
      if (!e.screen.visible) continue;
      const d = Math.hypot(e.screen.x - x, e.screen.y - y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  private pick(x: number, y: number) {
    this.setHover(this.hitTest(x, y), x, y);
  }

  private setHover(e: CityEntry | null, x: number, y: number) {
    if (this.hovered !== e) {
      this.hovered?.label.classList.remove('hover');
      e?.label.classList.add('hover');
      this.hovered = e;
    }
    this.onHover(e?.city ?? null, x, y);
  }

  update(camera: THREE.PerspectiveCamera, width: number, height: number) {
    const camDist = camera.position.length() - 100;
    const pxToWorld = (2 * Math.tan((camera.fov * Math.PI) / 360)) / height;
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];

    for (const e of this.entries) {
      const alt = this.altitudeFor(e.city);
      polarToCartesian(e.city.lat, e.city.lng, 100 * (1 + alt), e.world);

      // Constant on-screen marker size.
      const dist = camera.position.distanceTo(e.world);
      const px = e.stopColor ? MARKER_PX * 1.15 : e.city.population > 1e6 ? MARKER_PX : MARKER_PX * 0.75;
      e.marker.scale.setScalar(px * pxToWorld * dist * 0.5);

      // Visibility: in front of the camera and on the near side of the globe.
      this.toCam.copy(camera.position).sub(e.world).normalize();
      const facing = this.tmp.copy(e.world).normalize().dot(this.toCam);
      const inFront = this.tmp.copy(e.world).applyMatrix4(camera.matrixWorldInverse).z < 0;
      this.tmp.copy(e.world).project(camera);
      const onScreen = inFront && Math.abs(this.tmp.x) < 1.1 && Math.abs(this.tmp.y) < 1.1;
      e.screen.visible = facing > 0.02 && onScreen;
      e.screen.x = (this.tmp.x * 0.5 + 0.5) * width;
      e.screen.y = (-this.tmp.y * 0.5 + 0.5) * height;
      e.marker.visible = facing > -0.05;

      // Zoom-dependent tiers, then greedy decluttering in priority order.
      const tierOk =
        !!e.stopColor || e.city.population >= 1.5e6 || (e.city.population >= 5e5 ? camDist < 90 : camDist < 40);
      let show = e.screen.visible && tierOk;
      if (show) {
        const w = e.label.offsetWidth || 60;
        const h = e.label.offsetHeight || 22;
        const box = { x0: e.screen.x - w / 2, y0: e.screen.y - h - 10, x1: e.screen.x + w / 2, y1: e.screen.y - 6 };
        show = !placed.some(p => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0);
        if (show) placed.push(box);
      }
      if (show !== e.shown) {
        e.shown = show;
        e.label.classList.toggle('shown', show);
      }
      // Off-screen labels vanish at once (fading out at a stale position looks wrong).
      e.label.style.visibility = e.screen.visible ? '' : 'hidden';
      if (e.screen.visible) {
        e.label.style.transform = `translate3d(${e.screen.x.toFixed(1)}px, ${e.screen.y.toFixed(1)}px, 0)`;
        // Fade labels near the limb.
        e.label.style.setProperty('--limb', Math.min(1, facing * 6).toFixed(2));
      }
    }
  }
}
