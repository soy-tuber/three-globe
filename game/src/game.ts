// Game: wires the simulation (src/sim) to the view (src/render) and the UI (src/ui).
import * as THREE from 'three';
import { SPEEDS, nowMs, type SpeedIndex } from './sim/clock';
import type { TransportPath } from './sim/graph';
import { VEHICLE_MODELS, type City } from './sim/model';
import { MODE_INFO, type Mode } from './sim/modes';
import type { Networks } from './sim/networks';
import { Simulation, type SimEvent } from './sim/simulation';
import { GlobeView } from './render/globeView';
import type { TerrainManifest, TerrainRegion } from './render/terrainData';
import { RouteBuilder } from './ui/builder';
import { int, yen } from './ui/format';
import { GoalsPanel } from './ui/goals';
import { Hud } from './ui/hud';
import { RoutePanel } from './ui/routePanel';
import { Tutorial } from './ui/tutorial';

const PALETTE = ['#ff8a3d', '#3ec5ff', '#ff5fa2', '#8be04e', '#ffd23f', '#b18cff', '#2ee6c5', '#ff6b6b', '#6f9bff', '#f7a8ff'];
const HOME_VIEW = { lat: 35.4, lng: 139.9, dist: 30, heading: 0, tiltOffset: 0 };
const WORLD_VIEW = { dist: 280, heading: 0, tiltOffset: 0 };
/** 2026-04-01 06:00 JST */
const START_MS = Date.UTC(2026, 2, 31, 21, 0);

export async function startGame(
  container: HTMLElement,
  terrain: { manifest: TerrainManifest; regions: TerrainRegion[] },
  networks: Networks,
  cities: City[],
) {
  const base = import.meta.env.BASE_URL;

  // ---------------------------------------------------------------- simulation
  const sim = new Simulation({ startMs: START_MS, cities, companyName: '東海ハイウェイ交通', startingCash: 30_000_000 });
  const city = (id: string) => sim.cities.get(id)!;
  const usedColors = () => new Set([...sim.routes.values()].map(r => r.color));
  const nextColor = () => PALETTE.find(c => !usedColors().has(c)) ?? `hsl(${Math.round(Math.random() * 360)} 80% 60%)`;

  const plan = await networks.plan('bus', [city('tokyo'), city('osaka')]);
  if (!plan.ok) throw new Error(plan.error);
  const first = sim.openRoute({
    name: '東京–大阪線',
    color: PALETTE[0],
    mode: 'bus',
    stops: ['tokyo', 'osaka'],
    paths: plan.legs,
    modelId: 'microbus-28',
    free: true,
    // The first departure is at 07:00, giving the morning crowd time to gather.
    firstDepartureInMin: 60,
  });
  if (typeof first === 'string') throw new Error(first);
  first.vehicles[0].name = 'ひかり号 1';
  sim.drainEvents();

  // ---------------------------------------------------------------- view
  const view = new GlobeView(container, terrain.regions, cities);
  await view.vehicles.load(base + 'assets/models/bus.glb');

  const syncRoutes = () => {
    view.setRoutes(
      [...sim.routes.values()].map(r => ({ id: r.id, color: r.color, mode: r.mode, legs: r.legs.map(l => [...l.line.points]) })),
    );
    const stops = new Map<string, string>();
    for (const r of sim.routes.values()) for (const s of r.stops) if (!stops.has(s)) stops.set(s, r.color);
    view.cities.setStops(stops);
    const live = new Set(sim.vehicles.keys());
    for (const id of view.vehicles.ids()) if (!live.has(id)) view.vehicles.remove(id);
    for (const v of sim.vehicles.values())
      if (!view.vehicles.ids().includes(v.id))
        view.vehicles.add(v.id, VEHICLE_MODELS[v.modelId].visual, sim.routes.get(v.routeId)!.color, base);
  };
  syncRoutes();
  view.vehicles.selectedId = first.vehicles[0].id;

  Object.assign(view.rig.view, { ...HOME_VIEW, dist: 260, lat: 30, lng: 150 });
  Object.assign(view.rig.goal, view.rig.view);
  view.rig.flyTo(HOME_VIEW, 3.2);

  /** Fly so the whole route is in view. */
  const focusRoute = (routeId: string) => {
    const r = sim.routes.get(routeId);
    if (!r) return;
    const pts = r.stops.map(city);
    const lat = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
    // Average longitudes around the first stop to survive the antimeridian.
    const lng0 = pts[0].lng;
    const lng = lng0 + pts.reduce((a, p) => a + ((((p.lng - lng0 + 540) % 360) - 180)), 0) / pts.length;
    const spanKm = Math.max(...pts.flatMap(a => pts.map(b => Math.hypot(a.lat - b.lat, (a.lng - b.lng) * Math.cos((lat * Math.PI) / 180)) * 111)));
    view.rig.flyTo({ lat, lng: ((lng + 540) % 360) - 180, dist: Math.max(6, Math.min(260, spanKm / 38)) }, 1.6);
  };

  // ---------------------------------------------------------------- UI
  let speed: SpeedIndex = 1;
  let lastRunning: SpeedIndex = 1;
  const tutorial = new Tutorial(container);
  const setSpeed = (i: SpeedIndex) => {
    if (i !== speed) tutorial.notify('speed');
    speed = i;
    hud.setSpeed(i);
  };
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
      setSpeed,
      flyHome: () => view.rig.flyTo(HOME_VIEW),
      flyWorld: () => view.rig.flyTo({ ...WORLD_VIEW, lat: view.rig.view.lat, lng: view.rig.view.lng }),
      toggleRealSun: () => (view.realSun = !view.realSun),
      setExaggeration: v => view.setExaggeration(v),
      showTutorial: () => tutorial.start(),
    },
    terrain.manifest.attribution,
  );
  hud.setSpeed(speed);
  hud.setExaggeration(view.terrain.exaggeration);
  const goals = new GoalsPanel(hud.root, sim);

  const panel = new RoutePanel(hud.root, sim, {
    select: id => {
      panel.select(id);
      view.routes.setSelected(id);
    },
    newRoute: () => openBuilder(),
    setFare: (id, m) => {
      const r = sim.routes.get(id);
      if (r) r.fare.multiplier = m;
      sim.refreshDemand();
    },
    buyVehicle: (routeId, modelId) => {
      const model = VEHICLE_MODELS[modelId];
      if (sim.company.cash < model.purchasePrice) return;
      const v = sim.buyVehicle(routeId, modelId, { startStop: sim.busiestStop(routeId) });
      hud.toast(`<b>${v.name}</b>（${model.name}）を購入 <span class="muted">${yen(-model.purchasePrice)}</span>`);
      syncRoutes();
    },
    closeRoute: id => {
      const r = sim.routes.get(id)!;
      const refund = sim.closeRoute(id);
      hud.toast(`<b>${r.name}</b> を廃止しました（車両売却 ${yen(refund, { sign: true })}）`, 'warn');
      panel.select(sim.routes.keys().next().value ?? null);
      view.routes.setSelected(panel.selected);
      syncRoutes();
    },
    followVehicle: follow,
    focusRoute,
  });
  panel.select(first.route.id);
  view.routes.setSelected(first.route.id);

  // Which cities can the builder's current mode serve? (computed async, cached per mode)
  const servable = new Map<Mode, Set<string>>();
  const computeServable = async (mode: Mode) => {
    if (servable.has(mode)) return servable.get(mode)!;
    const ok = new Set<string>();
    for (const c of cities) if (await networks.serves(mode, c)) ok.add(c.id);
    servable.set(mode, ok);
    return ok;
  };

  const builder = new RouteBuilder(hud.root, {
    plan: (mode, stops) => networks.plan(mode, stops),
    estimate: (mode, stops, legs, modelId, count) =>
      sim.estimateRoute({ mode, stops: stops.map(s => s.id), paths: legs, modelId, vehicles: count }),
    open: (mode, stops, legs, modelId, count, name) => openRoute(mode, stops, legs, modelId, count, name),
    preview: (mode, legs) =>
      view.routes.setPreview(legs ? { id: '__preview', color: '#fff', mode, legs: legs.map(l => l.points) } : null),
    modeChanged: async mode => {
      view.cities.setBuilding(true);
      const ok = await computeServable(mode);
      if (builder.isOpen) view.cities.setBuilding(true, c => ok.has(c.id));
    },
    stopsChanged: ids => view.cities.setPicked(ids),
    closed: () => {
      view.cities.setBuilding(false);
      view.cities.setPicked([]);
      panel.setVisible(true);
    },
    cash: () => sim.company.cash,
  });

  const openBuilder = (mode?: Mode) => {
    panel.setVisible(false);
    builder.open(mode);
    tutorial.notify('builder');
  };

  const openRoute = (mode: Mode, stops: City[], legs: TransportPath[], modelId: string, count: number, name: string) => {
    const res = sim.openRoute({ name, color: nextColor(), mode, stops: stops.map(s => s.id), paths: legs, modelId, vehicles: count });
    if (typeof res === 'string') return res;
    res.vehicles.forEach((v, i) => (v.name = `${name.replace(/(線|便|航路)$/, '')} ${i + 1}号`));
    syncRoutes();
    panel.select(res.route.id);
    view.routes.setSelected(res.route.id);
    view.vehicles.selectedId = res.vehicles[0].id;
    focusRoute(res.route.id);
    hud.toast(`${MODE_INFO[mode].icon} <b>${name}</b> を開設しました！ <span class="muted">${yen(-VEHICLE_MODELS[modelId].purchasePrice * count)}</span>`, 'money');
    tutorial.notify('route-opened');
    return null;
  };

  view.cities.onHover = (c, x, y) => {
    let note = '';
    if (c && builder.isOpen) {
      const ok = servable.get(builderMode())?.has(c.id);
      note = ok === false ? `この都市は${MODE_INFO[builderMode()].name}で利用できません` : 'クリックして停車地に追加';
    }
    hud.showCityTooltip(c, x, y, note);
  };
  const builderMode = () => builder.currentMode;
  view.cities.onSelect = c => {
    if (builder.isOpen) {
      const ok = servable.get(builderMode());
      if (ok && !ok.has(c.id)) {
        hud.toast(`${c.name}は${MODE_INFO[builderMode()].name}で利用できません`, 'warn', 2200);
        return;
      }
      builder.addCity(c);
      return;
    }
    view.rig.flyTo({ lat: c.lat, lng: c.lng, dist: Math.min(view.rig.goal.dist, 8) }, 1.4);
  };
  view.rig.onInteract = () => tutorial.notify('camera');

  // ---------------------------------------------------------------- keyboard
  window.addEventListener('keydown', e => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      setSpeed(speed === 0 ? lastRunning : 0);
    } else if (/^Digit[1-4]$/.test(e.code)) setSpeed(+e.code.slice(5) as SpeedIndex);
    else if (e.code === 'KeyF' && view.vehicles.selectedId) follow(view.vehicles.selectedId);
    else if (e.code === 'KeyH') view.rig.flyTo(HOME_VIEW);
    else if (e.code === 'KeyG') view.rig.flyTo({ ...WORLD_VIEW, lat: view.rig.view.lat, lng: view.rig.view.lng });
    else if (e.code === 'KeyN') hud.setRealSun((view.realSun = !view.realSun));
    else if (e.code === 'Escape') builder.close();
  });

  // ---------------------------------------------------------------- events
  const tmp = new THREE.Vector3();
  let needSync = false;
  const handle = (e: SimEvent) => {
    switch (e.type) {
      case 'routeOpened':
      case 'routeClosed':
      case 'vehicleAdded':
        needSync = true;
        break;
      case 'departure': {
        const v = sim.vehicles.get(e.vehicleId);
        if (!v) return;
        if (e.revenue > 0) {
          const pos = view.vehicles.worldPosition(e.vehicleId, tmp);
          const p = pos && view.project(pos);
          if (p?.visible) hud.floatText(p.x, p.y - 28, `+${yen(e.revenue, { compact: true })}`);
        }
        if (e.routeId === panel.selected)
          hud.toast(
            `<b>${v.name}</b> ${city(e.cityId).name}を出発 — ${int(e.boarded)}人乗車 <span class="money">${yen(e.revenue, { sign: true, compact: true })}</span>`,
            'money',
          );
        break;
      }
      case 'day': {
        const p =
          Object.values(e.report.income).reduce((a, b) => a + (b ?? 0), 0) - Object.values(e.report.expense).reduce((a, b) => a + (b ?? 0), 0);
        hud.toast(`日次決算: <b>${yen(p, { sign: true })}</b>（乗客 ${int(e.report.passengers)}人）`, p >= 0 ? 'money' : 'warn');
        break;
      }
      case 'goal':
        hud.toast(`🏆 目標達成「<b>${e.goal.title}</b>」${e.goal.reward ? ` <span class="money">+${yen(e.goal.reward, { compact: true })}</span>` : ''}`, 'goal', 6000);
        break;
    }
  };

  // ---------------------------------------------------------------- loop
  // Expose for debugging in the console (and for automated screenshots) in dev builds.
  const debug = { frames: 0 };
  if (import.meta.env.DEV) {
    Object.assign(window, { sim, view, builder, networks });
    Object.defineProperty(window, '__frames', { get: () => debug.frames });
  }

  const timer = new THREE.Timer();
  let uiAccum = 0;
  view.renderer.setAnimationLoop(() => {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    const time = timer.getElapsed();
    if (speed !== 0) lastRunning = speed;

    sim.advance(SPEEDS[speed] * dt);
    for (const e of sim.drainEvents()) handle(e);
    if (needSync) {
      needSync = false;
      syncRoutes();
    }

    view.updateCamera(dt);
    for (const v of sim.vehicles.values()) view.updateVehicle(v.id, behind => sim.pose(v.id, behind), dt, time);
    view.render(dt, time, nowMs(sim.clock));

    uiAccum += dt;
    if (uiAccum > 0.2) {
      uiAccum = 0;
      hud.update(speed);
      panel.update();
      goals.update();
      const waiting = new Map<string, number>();
      for (const r of sim.routes.values())
        r.stops.forEach((id, i) => {
          let w = waiting.get(id) ?? 0;
          for (const q of r.queues[i]) for (const c of q) w += c.count;
          waiting.set(id, w);
        });
      for (const [id, w] of waiting) view.cities.setBadge(id, w > 0 ? `${w}人待ち` : '');
    }
    debug.frames++;
  });

  if (Tutorial.shouldAutoStart()) setTimeout(() => tutorial.start(), 3600);
}
