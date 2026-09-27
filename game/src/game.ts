// Game: wires the simulation (src/sim) to the view (src/render) and the HUD (src/ui).
import * as THREE from 'three';
import { CITIES } from './data/cities';
import { SPEEDS, nowMs, type SpeedIndex } from './sim/clock';
import { RoadGraph, type RoadGraphJson } from './sim/roadGraph';
import { VEHICLE_MODELS } from './sim/model';
import { createRoute, routePoints } from './sim/route';
import { Simulation, type SimEvent } from './sim/simulation';
import { GlobeView } from './render/globeView';
import type { TerrainManifest, TerrainRegion } from './render/terrainData';
import { Hud } from './ui/hud';
import { int, yen } from './ui/format';

const ROUTE_COLOR = '#ff8a3d';
const HOME_VIEW = { lat: 35.4, lng: 139.9, dist: 30, heading: 0, tiltOffset: 0 };
/** 2026-04-01 06:00 JST */
const START_MS = Date.UTC(2026, 2, 31, 21, 0);

export async function startGame(
  container: HTMLElement,
  terrain: { manifest: TerrainManifest; regions: TerrainRegion[] },
  roadsJson: RoadGraphJson,
) {
  // ---------------------------------------------------------------- simulation
  const sim = new Simulation({
    startMs: START_MS,
    cities: CITIES,
    companyName: '東海ハイウェイ交通',
    startingCash: 30_000_000,
  });

  const roads = new RoadGraph(roadsJson);
  const city = (id: string) => sim.cities.get(id)!;
  // Tōmei → Meishin, the classic highway-bus corridor (the pure shortest path takes the Chūō/Meihan).
  const TOMEI_SHIZUOKA = { lat: 34.955, lng: 138.38 };
  const MEISHIN_KYOTO = { lat: 34.975, lng: 135.806 };
  const path = roads.routeVia(city('tokyo'), [TOMEI_SHIZUOKA, MEISHIN_KYOTO], city('osaka'));
  if (!path) throw new Error('東京–大阪の道路経路が見つかりません');
  const route = createRoute({
    id: 'tokyo-osaka',
    name: '東京–大阪線',
    color: ROUTE_COLOR,
    stops: ['tokyo', 'osaka'],
    paths: [path],
  });
  sim.addRoute(route);
  // The first departure is at 07:00, giving the morning crowd time to gather.
  const bus = sim.buyVehicle(route.id, 'microbus-28', { free: true, name: 'ひかり号 1', firstDepartureInMin: 60 });

  // ---------------------------------------------------------------- view
  const stopColors = new Map(route.stops.map(s => [s, ROUTE_COLOR]));
  const view = new GlobeView(container, terrain.regions, CITIES, stopColors);
  view.setRoutes([{ id: route.id, color: route.color, points: routePoints(route) }]);
  const modelUrl = import.meta.env.BASE_URL + VEHICLE_MODELS['microbus-28'].modelUrl;
  await view.vehicles.load(modelUrl);
  view.vehicles.add(bus.id, modelUrl, ROUTE_COLOR);
  view.vehicles.selectedId = bus.id;

  Object.assign(view.rig.view, { ...HOME_VIEW, dist: 260, lat: 30, lng: 150 });
  Object.assign(view.rig.goal, view.rig.view);
  view.rig.flyTo(HOME_VIEW, 3.2);

  // ---------------------------------------------------------------- HUD
  let speed: SpeedIndex = 1;
  const follow = (id: string) => {
    view.vehicles.selectedId = id;
    const pose = sim.pose(id);
    if (pose) view.rig.flyTo({ lat: pose.pos.lat, lng: pose.pos.lng, dist: Math.min(view.rig.goal.dist, 3.5) }, 1.4);
    setTimeout(() => (view.rig.follow = () => sim.pose(id)?.pos ?? null), 1450);
  };
  const hud = new Hud(
    container,
    sim,
    {
      setSpeed: i => {
        speed = i;
        hud.setSpeed(i);
      },
      setFare: (id, m) => {
        const r = sim.routes.get(id);
        if (r) r.fare.multiplier = m;
      },
      followVehicle: follow,
      flyHome: () => view.rig.flyTo(HOME_VIEW),
      toggleRealSun: () => (view.realSun = !view.realSun),
      setExaggeration: v => view.setExaggeration(v),
      buyVehicle: routeId => {
        const model = VEHICLE_MODELS['microbus-28'];
        if (sim.company.cash < model.purchasePrice) return;
        const n = [...sim.vehicles.values()].filter(v => v.routeId === routeId).length + 1;
        const v = sim.buyVehicle(routeId, model.id, { name: `ひかり号 ${n}`, startStop: sim.busiestStop(routeId) });
        view.vehicles.add(v.id, modelUrl, ROUTE_COLOR);
        hud.toast(`<b>${v.name}</b> を購入しました <span class="muted">${yen(-model.purchasePrice)}</span>`, 'info');
      },
    },
    terrain.manifest.attribution,
  );
  hud.setSpeed(speed);
  hud.setExaggeration(view.terrain.exaggeration);

  view.cities.onHover = (c, x, y) => hud.showCityTooltip(c, x, y);
  view.cities.onSelect = c => view.rig.flyTo({ lat: c.lat, lng: c.lng, dist: Math.min(view.rig.goal.dist, 8) }, 1.4);

  // ---------------------------------------------------------------- keyboard
  let lastRunning: SpeedIndex = 1;
  window.addEventListener('keydown', e => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      speed = speed === 0 ? lastRunning : 0;
      hud.setSpeed(speed);
    } else if (/^Digit[1-4]$/.test(e.code)) {
      speed = +e.code.slice(5) as SpeedIndex;
      hud.setSpeed(speed);
    } else if (e.code === 'KeyF') follow(view.vehicles.selectedId ?? bus.id);
    else if (e.code === 'KeyH') view.rig.flyTo(HOME_VIEW);
    else if (e.code === 'KeyN') hud.setRealSun((view.realSun = !view.realSun));
  });

  // ---------------------------------------------------------------- events
  const tmp = new THREE.Vector3();
  const handle = (e: SimEvent) => {
    if (e.type === 'departure') {
      const c = city(e.cityId);
      if (e.revenue > 0) {
        const pos = view.vehicles.worldPosition(e.vehicleId, tmp);
        const p = pos && view.project(pos);
        if (p?.visible) hud.floatText(p.x, p.y - 28, `+${yen(e.revenue)}`);
      }
      hud.toast(
        `<b>${sim.vehicles.get(e.vehicleId)!.name}</b> ${c.name}を出発 — ${int(e.boarded)}人乗車 <span class="money">${yen(e.revenue, { sign: true })}</span>`,
        'money',
      );
    } else if (e.type === 'arrival') {
      hud.toast(`<b>${sim.vehicles.get(e.vehicleId)!.name}</b> ${city(e.cityId).name}に到着 — ${int(e.alighted)}人降車`);
    } else if (e.type === 'day') {
      const p = Object.values(e.report.income).reduce((a, b) => a + (b ?? 0), 0) -
        Object.values(e.report.expense).reduce((a, b) => a + (b ?? 0), 0);
      hud.toast(`日次決算: <b>${yen(p, { sign: true })}</b>（乗客 ${int(e.report.passengers)}人）`, p >= 0 ? 'money' : 'warn');
    }
  };

  // ---------------------------------------------------------------- loop
  // Expose for debugging in the console (and for automated screenshots) in dev builds.
  const debug = { frames: 0 };
  if (import.meta.env.DEV) {
    Object.assign(window, { sim, view });
    Object.defineProperty(window, '__frames', { get: () => debug.frames });
  }

  const timer = new THREE.Timer();
  let hudAccum = 0;
  view.renderer.setAnimationLoop(() => {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    const time = timer.getElapsed();
    if (speed !== 0) lastRunning = speed;

    sim.advance(SPEEDS[speed] * dt);
    for (const e of sim.drainEvents()) handle(e);

    view.updateCamera(dt);
    for (const v of sim.vehicles.values()) {
      const pose = sim.pose(v.id);
      if (pose) view.updateVehicle(v.id, pose, dt, time);
    }
    view.render(dt, time, nowMs(sim.clock));

    hudAccum += dt;
    if (hudAccum > 0.15) {
      hudAccum = 0;
      hud.update(speed);
      for (const r of sim.routes.values())
        r.stops.forEach((id, i) => {
          let w = 0;
          for (const q of r.queues[i]) for (const c of q) w += c.count;
          view.cities.setBadge(id, w > 0 ? `${w}人待ち` : '');
        });
    }
    debug.frames++;
  });

}
