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
  altitude: number;
  screen: { x: number; y: number; visible: boolean };
  /** cached label size (measured once, re-measured when the text changes) */
  size: { w: number; h: number } | null;
  shown: boolean;
  stopColor: string | null;
  disabled: boolean;
  picked: number;
}

const MARKER_PX = 7;

function formatPopulation(p: number): string {
  if (p >= 1e6) return `${(p / 1e4).toFixed(0)}万`;
  return `${(p / 1e4).toFixed(1)}万`;
}

function makeMarker(stopColor: string | null): THREE.Group {
  const g = new THREE.Group();
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(1, 32),
    new THREE.MeshBasicMaterial({ color: stopColor ?? '#ffffff', depthWrite: false, transparent: true }),
  );
  const outline = new THREE.Mesh(
    new THREE.RingGeometry(1, 1.45, 32),
    new THREE.MeshBasicMaterial({ color: '#0b1726', transparent: true, opacity: 0.85, depthWrite: false }),
  );
  dot.renderOrder = outline.renderOrder = 5;
  g.add(outline, dot);
  if (stopColor) {
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(1.9, 2.4, 48),
      new THREE.MeshBasicMaterial({ color: stopColor, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    halo.renderOrder = 5;
    g.add(halo);
  }
  return g;
}

/** Zoom tier: at which camera altitude (world units) a city's label may appear. */
function maxAltitudeFor(c: City): number {
  if (c.population >= 8e6) return Infinity;
  if (c.population >= 3e6) return 150;
  if (c.population >= 1e6) return 70;
  if (c.population >= 5e5) return 40;
  return 22;
}

export class CityLayer {
  readonly entries: CityEntry[];
  private readonly byId = new Map<string, CityEntry>();
  private readonly container: HTMLDivElement;
  private readonly tmp = new THREE.Vector3();
  private readonly toCam = new THREE.Vector3();
  onHover: (city: City | null, x: number, y: number) => void = () => {};
  onSelect: (city: City) => void = () => {};
  private hovered: CityEntry | null = null;
  /** route-builder mode: all cities shown, some greyed out */
  private building = false;

  constructor(
    private readonly globe: ThreeGlobe,
    private readonly terrain: Terrain,
    cities: City[],
    overlay: HTMLElement,
    canvas: HTMLElement,
  ) {
    this.container = document.createElement('div');
    this.container.className = 'city-labels';
    overlay.appendChild(this.container);

    this.entries = cities.map(city => {
      const label = document.createElement('div');
      label.className = `city-label${city.population >= 1.5e6 ? ' is-major' : ''}`;
      label.innerHTML = `<span class="name">${city.name}</span><span class="pop">${formatPopulation(city.population)}</span>`;
      const badge = document.createElement('span');
      badge.className = 'badge empty';
      label.appendChild(badge);
      this.container.appendChild(label);
      label.addEventListener('click', () => this.onSelect(city));
      const e: CityEntry = {
        city,
        marker: makeMarker(null),
        label,
        badge,
        world: new THREE.Vector3(),
        altitude: 0,
        screen: { x: 0, y: 0, visible: false },
        size: null,
        shown: false,
        stopColor: null,
        disabled: false,
        picked: 0,
      };
      this.byId.set(city.id, e);
      return e;
    });
    this.refreshAltitudes(false);
    this.sort();

    type Datum = { e: CityEntry };
    globe
      .objectLat((d: object) => (d as Datum).e.city.lat)
      .objectLng((d: object) => (d as Datum).e.city.lng)
      .objectAltitude((d: object) => (d as Datum).e.altitude)
      .objectFacesSurface(true)
      .objectThreeObject((d: object) => (d as Datum).e.marker);
    this.pushObjects();

    canvas.addEventListener('pointermove', e => this.pick(e.clientX, e.clientY));
    canvas.addEventListener('pointerleave', () => this.setHover(null, 0, 0));
    canvas.addEventListener('click', e => {
      const hit = this.hitTest(e.clientX, e.clientY);
      if (hit) this.onSelect(hit.city);
    });
  }

  private sort() {
    const prio = (e: CityEntry) => (e.picked ? 3e9 : 0) + (e.stopColor ? 1e9 : 0) + e.city.population;
    this.entries.sort((a, b) => prio(b) - prio(a));
  }

  private pushObjects() {
    // three-globe keys objects by datum identity: fresh wrappers make it rebuild every marker
    // (cheap for a few hundred, and only done when stops or the terrain change).
    this.globe.objectsData(this.entries.map(e => ({ e })));
  }

  /** Re-place markers after the terrain exaggeration changes. */
  refreshAltitudes(push = true) {
    for (const e of this.entries) e.altitude = this.terrain.altitudeAt(e.city.lat, e.city.lng) + 0.00004;
    if (push) this.pushObjects();
  }

  /** Highlight cities that are stops of routes (cityId → colour of one of its routes). */
  setStops(stops: Map<string, string>) {
    let changed = false;
    for (const e of this.entries) {
      const color = stops.get(e.city.id) ?? null;
      if (color === e.stopColor) continue;
      changed = true;
      e.stopColor = color;
      e.marker = makeMarker(color);
      e.label.classList.toggle('is-stop', !!color);
      if (color) e.label.style.setProperty('--route', color);
      if (!color) this.setBadge(e.city.id, '');
      e.size = null;
    }
    if (changed) {
      this.sort();
      this.pushObjects();
    }
  }

  /** Route builder: show every city, grey out those the chosen mode cannot serve. */
  setBuilding(on: boolean, servable?: (c: City) => boolean) {
    this.building = on;
    for (const e of this.entries) {
      e.disabled = on && !!servable && !servable(e.city);
      e.label.classList.toggle('disabled', e.disabled);
    }
  }

  /** Builder: number the chosen stops (1-based order), 0 to clear. */
  setPicked(ids: string[]) {
    for (const e of this.entries) {
      const n = ids.indexOf(e.city.id) + 1;
      if (n === e.picked) continue;
      e.picked = n;
      e.label.classList.toggle('picked', n > 0);
      e.label.dataset.order = n ? String(n) : '';
      e.size = null;
    }
    this.sort();
  }

  setBadge(cityId: string, text: string) {
    const e = this.byId.get(cityId);
    if (e && e.badge.textContent !== text) {
      e.badge.textContent = text;
      e.badge.classList.toggle('empty', text === '');
      e.size = null;
    }
  }

  private hitTest(x: number, y: number): CityEntry | null {
    let best: CityEntry | null = null, bestD = 16;
    for (const e of this.entries) {
      if (!e.screen.visible || !(e.shown || e.marker.visible)) continue;
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
    const altitude = camera.position.length() - 100;
    const pxToWorld = (2 * Math.tan((camera.fov * Math.PI) / 360)) / height;
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const view = camera.matrixWorldInverse;

    for (const e of this.entries) {
      polarToCartesian(e.city.lat, e.city.lng, 100 * (1 + e.altitude), e.world);

      // Visibility: in front of the camera and on the near side of the globe.
      this.toCam.copy(camera.position).sub(e.world).normalize();
      const facing = this.tmp.copy(e.world).normalize().dot(this.toCam);
      const inFront = this.tmp.copy(e.world).applyMatrix4(view).z < 0;
      this.tmp.copy(e.world).project(camera);
      const onScreen = inFront && Math.abs(this.tmp.x) < 1.1 && Math.abs(this.tmp.y) < 1.1;
      e.screen.visible = facing > 0.02 && onScreen;
      e.screen.x = (this.tmp.x * 0.5 + 0.5) * width;
      e.screen.y = (-this.tmp.y * 0.5 + 0.5) * height;

      const important = !!e.stopColor || e.picked > 0;
      const tierOk = important || altitude < maxAltitudeFor(e.city) * (this.building ? 1.6 : 1);

      // Constant on-screen marker size; minor cities only get a dot once zoomed in enough.
      const dist = camera.position.distanceTo(e.world);
      const px = e.stopColor ? MARKER_PX * 1.15 : e.city.population > 1e6 ? MARKER_PX : MARKER_PX * 0.75;
      e.marker.scale.setScalar(px * pxToWorld * dist * 0.5);
      e.marker.visible = facing > -0.05 && tierOk && !e.disabled;

      // Greedy decluttering in priority order.
      let show = e.screen.visible && tierOk;
      if (show) {
        if (!e.size) e.size = { w: e.label.offsetWidth || 60, h: e.label.offsetHeight || 22 };
        const { w, h } = e.size;
        const box = { x0: e.screen.x - w / 2, y0: e.screen.y - h - 10, x1: e.screen.x + w / 2, y1: e.screen.y - 6 };
        show = important || !placed.some(p => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0);
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
        e.label.style.setProperty('--limb', Math.min(1, facing * 6).toFixed(2));
      }
    }
  }
}
