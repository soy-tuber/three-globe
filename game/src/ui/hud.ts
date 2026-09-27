// Heads-up display. Reads simulation state; sends player intents back through callbacks.
import { SPEEDS, formatJst, nowMs, type SpeedIndex } from '../sim/clock';
import { CATEGORY_LABEL, operatingProfit, profit, sum, type DailyReport, type LedgerCategory } from '../sim/economy';
import { VEHICLE_MODELS, ticketPrice, type City } from '../sim/model';
import { departuresPerDay, freeFlowMinutes, stopDistanceKm, waitingAt, type RouteState } from '../sim/route';
import type { Simulation } from '../sim/simulation';
import { onboardCount, type VehicleState } from '../sim/vehicle';
import { duration, int, km, yen } from './format';

export interface HudCallbacks {
  setSpeed(i: SpeedIndex): void;
  setFare(routeId: string, multiplier: number): void;
  followVehicle(id: string): void;
  flyHome(): void;
  toggleRealSun(): boolean;
  setExaggeration(v: number): void;
  buyVehicle(routeId: string): void;
}

const SPEED_LABELS = ['⏸', '▶', '▶▶', '▶▶▶', '⏩'];
const SPEED_TITLES = ['一時停止 (Space)', '1倍速 (1)', '4倍速 (2)', '15倍速 (3)', '60倍速 (4)'];

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

export class Hud {
  readonly root: HTMLDivElement;
  private readonly els: Record<string, HTMLElement> = {};
  private speedButtons: HTMLButtonElement[] = [];
  private tooltip: HTMLDivElement;
  private toasts: HTMLDivElement;
  private floaters: HTMLDivElement;
  private chart: HTMLCanvasElement;
  private lastChartKey = '';

  constructor(
    parent: HTMLElement,
    private readonly sim: Simulation,
    cb: HudCallbacks,
    attribution: string[],
  ) {
    this.root = h('div', 'hud');
    parent.appendChild(this.root);

    // ---- top bar
    const top = h('header', 'topbar');
    top.innerHTML = `
      <div class="brand">
        <div class="logo"><svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M5 16h22M16 3c4 4 6 8.5 6 13s-2 9-6 13c-4-4-6-8.5-6-13s2-9 6-13z" fill="none" stroke="currentColor" stroke-width="2"/></svg></div>
        <div><div class="company" data-el="company"></div><div class="sub">Globe Rush</div></div>
      </div>
      <div class="stat money"><div class="label">資金</div><div class="value" data-el="cash"></div><div class="delta" data-el="today"></div></div>
      <div class="stat clock"><div class="label" data-el="date"></div><div class="value time" data-el="time"></div></div>
      <div class="speed" data-el="speed"></div>`;
    this.root.appendChild(top);

    // ---- route panel
    const panel = h('aside', 'panel route-panel');
    panel.innerHTML = `
      <div class="panel-head"><span class="chip" data-el="routeChip"></span><div><div class="title" data-el="routeName"></div><div class="subtitle" data-el="routeSub"></div></div></div>
      <div class="grid">
        <div><div class="k">営業距離</div><div class="v" data-el="dist"></div></div>
        <div><div class="k">所要時間</div><div class="v" data-el="dur"></div></div>
        <div><div class="k">運賃</div><div class="v" data-el="fare"></div></div>
        <div><div class="k">需要（片道/日）</div><div class="v" data-el="demand"></div></div>
      </div>
      <label class="slider"><span>運賃設定</span><input type="range" min="0.6" max="1.6" step="0.05" value="1" data-el="fareSlider"/><span class="slider-val" data-el="fareMult"></span></label>
      <div class="stops" data-el="stops"></div>
      <div class="section-title">運行中の車両</div>
      <div class="vehicles" data-el="vehicles"></div>
      <button class="btn buy" data-el="buy"></button>
      <div class="totals" data-el="totals"></div>`;
    this.root.appendChild(panel);

    // ---- finance panel
    const fin = h('section', 'panel finance-panel');
    fin.innerHTML = `
      <div class="section-title">営業損益 <span class="muted">（直近14日・車両購入を除く）</span></div>
      <canvas class="chart" width="560" height="150" data-el="chart"></canvas>
      <div class="ledger" data-el="ledger"></div>`;
    this.root.appendChild(fin);

    // ---- view controls
    const view = h('div', 'view-controls');
    view.innerHTML = `
      <button class="icon-btn" data-el="home" title="日本全体を表示 (H)">⌂</button>
      <button class="icon-btn" data-el="sun" title="実時間の昼夜表示 (N)">☀</button>
      <label class="exag" title="起伏の強調"><span>起伏</span><input type="range" min="1" max="25" step="1" value="6" data-el="exag"/></label>`;
    this.root.appendChild(view);

    const help = h('div', 'help');
    help.innerHTML = `ドラッグ: 移動 ・ ホイール: ズーム ・ 右ドラッグ/Shift: 回転・傾き ・ <kbd>Space</kbd> 停止 ・ <kbd>1</kbd>–<kbd>4</kbd> 速度 ・ <kbd>F</kbd> 追従`;
    this.root.appendChild(help);

    const credits = [...attribution, '3D models: Kenney (CC0)'];
    const credit = h('div', 'credit', 'データ: Natural Earth · Terrain Tiles · Kenney <span class="i">ⓘ</span>');
    credit.title = credits.join('\n');
    this.root.appendChild(credit);

    this.tooltip = h('div', 'tooltip');
    this.toasts = h('div', 'toasts');
    this.floaters = h('div', 'floaters');
    this.root.append(this.tooltip, this.toasts, this.floaters);

    this.root.querySelectorAll<HTMLElement>('[data-el]').forEach(el => (this.els[el.dataset.el!] = el));
    this.chart = this.els.chart as HTMLCanvasElement;

    // speed buttons
    SPEEDS.forEach((_, i) => {
      const b = h('button', 'speed-btn', SPEED_LABELS[i]);
      b.title = SPEED_TITLES[i];
      b.addEventListener('click', () => cb.setSpeed(i as SpeedIndex));
      this.els.speed.appendChild(b);
      this.speedButtons.push(b);
    });

    const route = this.primaryRoute();
    (this.els.fareSlider as HTMLInputElement).value = String(route.fare.multiplier);
    this.els.fareSlider.addEventListener('input', e => {
      cb.setFare(route.id, +(e.target as HTMLInputElement).value);
      this.update(-1);
    });
    this.els.exag.addEventListener('input', e => cb.setExaggeration(+(e.target as HTMLInputElement).value));
    this.els.home.addEventListener('click', () => cb.flyHome());
    this.els.sun.addEventListener('click', () => this.els.sun.classList.toggle('active', cb.toggleRealSun()));
    this.els.buy.addEventListener('click', () => cb.buyVehicle(route.id));
    this.els.vehicles.addEventListener('click', e => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-follow]');
      if (btn) cb.followVehicle(btn.dataset.follow!);
    });
  }

  private primaryRoute(): RouteState {
    return this.sim.routes.values().next().value!;
  }

  setSpeed(i: SpeedIndex) {
    this.speedButtons.forEach((b, j) => b.classList.toggle('active', i === j));
  }

  setExaggeration(v: number) {
    (this.els.exag as HTMLInputElement).value = String(v);
  }

  setRealSun(on: boolean) {
    this.els.sun.classList.toggle('active', on);
  }

  // ------------------------------------------------------------------ transient UI

  toast(html: string, kind: 'info' | 'money' | 'warn' = 'info') {
    const t = h('div', `toast ${kind}`, html);
    this.toasts.prepend(t);
    while (this.toasts.children.length > 4) this.toasts.lastElementChild!.remove();
    setTimeout(() => t.classList.add('out'), 4200);
    setTimeout(() => t.remove(), 4800);
  }

  floatText(x: number, y: number, text: string, kind: 'money' | 'info' = 'money') {
    const f = h('div', `floater ${kind}`, text);
    f.style.left = `${x}px`;
    f.style.top = `${y}px`;
    this.floaters.appendChild(f);
    setTimeout(() => f.remove(), 2000);
  }

  showCityTooltip(city: City | null, x: number, y: number) {
    if (!city) {
      this.tooltip.classList.remove('shown');
      return;
    }
    let extra = '';
    for (const r of this.sim.routes.values()) {
      const i = r.stops.indexOf(city.id);
      if (i >= 0) extra += `<div class="row"><span>${r.name} 待ち客</span><b>${int(waitingAt(r, i))}人</b></div>`;
    }
    this.tooltip.innerHTML = `
      <div class="tt-title">${city.name}<span>${city.pref}</span></div>
      <div class="row"><span>人口</span><b>${int(city.population)}人</b></div>${extra}`;
    this.tooltip.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
    this.tooltip.classList.add('shown');
  }

  // ------------------------------------------------------------------ periodic refresh

  update(speed: SpeedIndex | -1) {
    const sim = this.sim;
    const c = sim.company;
    if (speed >= 0) this.setSpeed(speed as SpeedIndex);

    const t = formatJst(nowMs(sim.clock));
    this.els.company.textContent = c.name;
    this.els.cash.textContent = yen(c.cash);
    this.els.cash.classList.toggle('negative', c.cash < 0);
    const todayProfit = profit(c.today);
    this.els.today.textContent = `本日 ${yen(todayProfit, { sign: true, compact: true })}`;
    this.els.today.className = `delta ${todayProfit >= 0 ? 'up' : 'down'}`;
    this.els.date.textContent = `${t.date}（${t.weekday}）`;
    this.els.time.textContent = t.time;

    const r = this.primaryRoute();
    const first = sim.cities.get(r.stops[0])!;
    const last = sim.cities.get(r.stops[r.stops.length - 1])!;
    const total = stopDistanceKm(r, 0, r.stops.length - 1);
    const expressKm = r.legs.reduce((a, l) => a + l.expresswayKm, 0);
    this.els.routeChip.style.background = r.color;
    this.els.routeName.textContent = r.name;
    this.els.routeSub.textContent = `${first.name} ⇄ ${last.name}・高速バス`;
    this.els.dist.innerHTML = `${km(total)}<small>高速 ${Math.round((expressKm / total) * 100)}%</small>`;
    const model = VEHICLE_MODELS['microbus-28'];
    this.els.dur.textContent = duration(freeFlowMinutes(r, model.maxSpeedKmh));
    const fare = ticketPrice(total, r.fare);
    this.els.fare.textContent = yen(fare);
    this.els.fareMult.textContent = `×${r.fare.multiplier.toFixed(2)}`;
    const dAB = sim.expectedDailyDemand(r, 0, r.stops.length - 1);
    const dBA = sim.expectedDailyDemand(r, r.stops.length - 1, 0);
    this.els.demand.innerHTML = `${int(dAB)}<small>⇄ ${int(dBA)} 人</small>`;

    this.els.stops.innerHTML = r.stops
      .map((id, i) => {
        const city = sim.cities.get(id)!;
        const w = waitingAt(r, i);
        const deps = departuresPerDay(r, i === 0 ? 1 : -1, sim.clock.minutes);
        return `<div class="stop"><span class="dot" style="--c:${r.color}"></span><b>${city.name}</b><span class="muted">待ち ${int(w)}人・発車 ${deps}便/日</span></div>`;
      })
      .join('');

    const vehicles = [...sim.vehicles.values()].filter(v => v.routeId === r.id);
    this.syncVehicleCards(vehicles, r);
    this.els.buy.innerHTML = `＋ ${model.name}を購入 <span>${yen(model.purchasePrice, { compact: true })}</span>`;
    (this.els.buy as HTMLButtonElement).disabled = c.cash < model.purchasePrice;

    this.els.totals.innerHTML = `
      <div><span>累計乗客</span><b>${int(r.stats.passengers)}人</b></div>
      <div><span>累計運賃収入</span><b>${yen(r.stats.revenue, { compact: true })}</b></div>
      <div><span>取りこぼし</span><b>${int(r.stats.lost)}人</b></div>`;

    this.updateFinance();
  }

  /** Vehicle cards are keyed and patched in place so their buttons stay clickable. */
  private readonly cards = new Map<string, Record<string, HTMLElement>>();

  private syncVehicleCards(vehicles: VehicleState[], r: RouteState) {
    for (const v of vehicles) {
      let card = this.cards.get(v.id);
      if (!card) {
        const el = h('div', 'vehicle');
        el.innerHTML = `
          <div class="vh-head"><b data-f="name"></b><button class="mini" data-follow="${v.id}" title="追従 (F)">追従</button></div>
          <div class="vh-status" data-f="status"></div>
          <div class="progress"><span data-f="progress"></span></div>
          <div class="vh-row"><span>乗客</span><div class="bar"><span data-f="load"></span></div><b data-f="pax"></b></div>
          <div class="vh-row"><span>走行距離</span><b data-f="odo"></b><span>前回運賃</span><b data-f="rev"></b></div>`;
        card = { el };
        el.querySelectorAll<HTMLElement>('[data-f]').forEach(x => (card![x.dataset.f!] = x));
        this.els.vehicles.appendChild(el);
        this.cards.set(v.id, card);
      }
      this.fillVehicleCard(card, v, r);
    }
  }

  private fillVehicleCard(card: Record<string, HTMLElement>, v: VehicleState, r: RouteState) {
    const sim = this.sim;
    const model = VEHICLE_MODELS[v.modelId];
    const n = onboardCount(v);
    const from = sim.cities.get(r.stops[v.stopIndex])!;
    const eta = sim.etaMinutes(v.id);
    let status: string, progress: number;
    if (v.status === 'dwell') {
      const to = sim.cities.get(r.stops[v.stopIndex + v.dir])!;
      status = `${from.name}で乗車中 → ${to.name}行き・発車まで ${duration(eta)}`;
      progress = 0;
    } else {
      const next = sim.cities.get(r.stops[v.stopIndex + v.dir])!;
      const leg = r.legs[v.dir === 1 ? v.stopIndex : v.stopIndex - 1];
      progress = v.legKm / leg.lengthKm;
      status = `${next.name}へ走行中・${Math.round(v.speedKmh)} km/h・到着まで ${duration(eta)}`;
    }
    const set = (k: string, text: string) => card[k].textContent !== text && (card[k].textContent = text);
    set('name', v.name);
    set('status', status);
    set('pax', `${n}/${model.capacity}`);
    set('odo', `${int(v.odometerKm)} km`);
    set('rev', yen(v.tripRevenue, { compact: true }));
    card.progress.style.width = `${(progress * 100).toFixed(1)}%`;
    card.progress.style.background = r.color;
    card.load.style.width = `${((n / model.capacity) * 100).toFixed(0)}%`;
  }

  private updateFinance() {
    const c = this.sim.company;
    const days: DailyReport[] = [...c.history.slice(-13), c.today];
    const key = days.map(d => `${d.day}:${Math.round(operatingProfit(d) / 1000)}`).join('|');
    if (key !== this.lastChartKey) {
      this.lastChartKey = key;
      drawChart(this.chart, days);
    }
    const rows = (obj: Partial<Record<LedgerCategory, number>>, cls: string) =>
      (Object.keys(obj) as LedgerCategory[])
        .filter(k => (obj[k] ?? 0) > 0.5)
        .map(k => `<div class="${cls}"><span>${CATEGORY_LABEL[k]}</span><b>${yen(obj[k]!, { compact: true })}</b></div>`)
        .join('');
    const t = c.today;
    this.els.ledger.innerHTML = `
      <div class="ledger-col"><div class="lh">本日の収入 <b>${yen(sum(t.income), { compact: true })}</b></div>${rows(t.income, 'in')}</div>
      <div class="ledger-col"><div class="lh">本日の支出 <b>${yen(sum(t.expense), { compact: true })}</b></div>${rows(t.expense, 'out')}</div>
      <div class="ledger-foot"><span>乗客 ${int(t.passengers)}人</span><span>取りこぼし ${int(t.lostPassengers)}人</span><span>走行 ${int(t.vehicleKm)} km</span></div>`;
  }
}

function drawChart(canvas: HTMLCanvasElement, days: DailyReport[]) {
  const dpr = Math.min(window.devicePixelRatio, 2);
  const cssW = canvas.clientWidth || 280, cssH = canvas.clientHeight || 80;
  if (canvas.width !== cssW * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const values = days.map(operatingProfit);
  const max = Math.max(1, ...values.map(Math.abs));
  const n = 14;
  const bw = cssW / n;
  const mid = cssH * 0.6;
  const scale = (cssH * 0.55) / max;
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.beginPath();
  ctx.moveTo(0, mid + 0.5);
  ctx.lineTo(cssW, mid + 0.5);
  ctx.stroke();
  values.forEach((v, i) => {
    const x = (n - values.length + i) * bw + bw * 0.18;
    const hgt = Math.max(1, Math.abs(v) * scale);
    const today = i === values.length - 1;
    ctx.fillStyle = v >= 0 ? (today ? 'rgba(82,214,160,0.55)' : '#52d6a0') : today ? 'rgba(255,107,107,0.55)' : '#ff6b6b';
    ctx.beginPath();
    ctx.roundRect(x, v >= 0 ? mid - hgt : mid, bw * 0.64, hgt, 2);
    ctx.fill();
  });
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = '10px Inter, sans-serif';
  ctx.fillText(yen(max, { compact: true }), 2, 10);
}
