// Heads-up display shell: top bar, finance panel, view controls, toasts, tooltips.
// Route management lives in routePanel.ts / builder.ts, goals in goals.ts.
import { SPEEDS, formatJst, nowMs, type SpeedIndex } from '../sim/clock';
import { CATEGORY_LABEL, operatingProfit, sum, type DailyReport, type LedgerCategory } from '../sim/economy';
import type { City } from '../sim/model';
import { waitingAt } from '../sim/route';
import type { Simulation } from '../sim/simulation';
import { MODE_INFO } from '../sim/modes';
import { int, yen } from './format';

export interface HudCallbacks {
  setSpeed(i: SpeedIndex): void;
  flyHome(): void;
  flyWorld(): void;
  toggleRealSun(): boolean;
  setExaggeration(v: number): void;
  showTutorial(): void;
}

const SPEED_LABELS = ['⏸', '▶', '▶▶', '▶▶▶', '⏩'];
const SPEED_TITLES = ['一時停止 (Space)', '1倍速 (1)', '4倍速 (2)', '15倍速 (3)', '60倍速 (4)'];

export const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};

export function bindEls(root: HTMLElement): Record<string, HTMLElement> {
  const els: Record<string, HTMLElement> = {};
  root.querySelectorAll<HTMLElement>('[data-el]').forEach(el => (els[el.dataset.el!] = el));
  return els;
}

export class Hud {
  readonly root: HTMLDivElement;
  private readonly els: Record<string, HTMLElement>;
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

    const top = h('header', 'topbar');
    top.innerHTML = `
      <div class="brand">
        <div class="logo"><svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M5 16h22M16 3c4 4 6 8.5 6 13s-2 9-6 13c-4-4-6-8.5-6-13s2-9 6-13z" fill="none" stroke="currentColor" stroke-width="2"/></svg></div>
        <div><div class="company" data-el="company"></div><div class="sub">Globe Rush</div></div>
      </div>
      <div class="stat money"><div class="label">資金</div><div class="value" data-el="cash"></div><div class="delta" data-el="today"></div></div>
      <div class="stat fleet"><div class="label">路線・車両</div><div class="value" data-el="fleet"></div><div class="delta muted" data-el="fleetSub"></div></div>
      <div class="stat clock"><div class="label" data-el="date"></div><div class="value time" data-el="time"></div></div>
      <div class="speed" data-el="speed"></div>`;
    this.root.appendChild(top);

    const fin = h('section', 'panel finance-panel');
    fin.innerHTML = `
      <div class="section-title">営業損益 <span class="muted">（直近14日・車両売買と報酬を除く）</span></div>
      <canvas class="chart" data-el="chart"></canvas>
      <div class="ledger" data-el="ledger"></div>`;
    this.root.appendChild(fin);

    const view = h('div', 'view-controls');
    view.innerHTML = `
      <button class="icon-btn" data-el="home" title="日本を表示 (H)">⌂</button>
      <button class="icon-btn" data-el="world" title="地球全体を表示 (G)">🌐</button>
      <button class="icon-btn" data-el="sun" title="実時間の昼夜表示 (N)">☀</button>
      <button class="icon-btn" data-el="tutorial" title="チュートリアル">?</button>
      <label class="exag" title="起伏の強調"><span>起伏</span><input type="range" min="1" max="25" step="1" value="6" data-el="exag"/></label>`;
    this.root.appendChild(view);

    this.root.appendChild(
      h(
        'div',
        'help',
        `ドラッグ: 移動 ・ ホイール: ズーム ・ 右ドラッグ/Shift: 回転・傾き ・ <kbd>Space</kbd> 停止 ・ <kbd>1</kbd>–<kbd>4</kbd> 速度 ・ <kbd>F</kbd> 追従 ・ <kbd>Esc</kbd> 取消`,
      ),
    );
    const credit = h('div', 'credit', 'データ: Natural Earth · Terrain Tiles · Kenney <span class="i">ⓘ</span>');
    credit.title = [...attribution, '3D models: Kenney (CC0) + procedural'].join('\n');
    this.root.appendChild(credit);

    this.tooltip = h('div', 'tooltip');
    this.toasts = h('div', 'toasts');
    this.floaters = h('div', 'floaters');
    this.root.append(this.tooltip, this.toasts, this.floaters);

    this.els = bindEls(this.root);
    this.chart = this.els.chart as HTMLCanvasElement;

    SPEEDS.forEach((_, i) => {
      const b = h('button', 'speed-btn', SPEED_LABELS[i]);
      b.title = SPEED_TITLES[i];
      b.addEventListener('click', () => cb.setSpeed(i as SpeedIndex));
      this.els.speed.appendChild(b);
      this.speedButtons.push(b);
    });
    this.els.exag.addEventListener('input', e => cb.setExaggeration(+(e.target as HTMLInputElement).value));
    this.els.home.addEventListener('click', () => cb.flyHome());
    this.els.world.addEventListener('click', () => cb.flyWorld());
    this.els.tutorial.addEventListener('click', () => cb.showTutorial());
    this.els.sun.addEventListener('click', () => this.setRealSun(cb.toggleRealSun()));
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

  toast(html: string, kind: 'info' | 'money' | 'warn' | 'goal' = 'info', ms = 4200) {
    const t = h('div', `toast ${kind}`, html);
    this.toasts.prepend(t);
    while (this.toasts.children.length > 4) this.toasts.lastElementChild!.remove();
    setTimeout(() => t.classList.add('out'), ms);
    setTimeout(() => t.remove(), ms + 600);
  }

  floatText(x: number, y: number, text: string, kind: 'money' | 'info' = 'money') {
    const f = h('div', `floater ${kind}`, text);
    f.style.left = `${x}px`;
    f.style.top = `${y}px`;
    this.floaters.appendChild(f);
    setTimeout(() => f.remove(), 2000);
  }

  showCityTooltip(city: City | null, x: number, y: number, note = '') {
    if (!city) {
      this.tooltip.classList.remove('shown');
      return;
    }
    let extra = '';
    for (const r of this.sim.routes.values()) {
      const i = r.stops.indexOf(city.id);
      if (i >= 0)
        extra += `<div class="row"><span>${MODE_INFO[r.mode].icon} ${r.name} 待ち</span><b>${int(waitingAt(r, i))}人</b></div>`;
    }
    this.tooltip.innerHTML = `
      <div class="tt-title">${city.name}<span>${city.pref}</span></div>
      <div class="row"><span>人口</span><b>${int(city.population)}人</b></div>${extra}${note ? `<div class="tt-note">${note}</div>` : ''}`;
    this.tooltip.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
    this.tooltip.classList.add('shown');
  }

  // ------------------------------------------------------------------ periodic refresh

  update(speed: SpeedIndex) {
    const sim = this.sim;
    const c = sim.company;
    this.setSpeed(speed);

    const t = formatJst(nowMs(sim.clock));
    this.els.company.textContent = c.name;
    this.els.cash.textContent = yen(c.cash);
    this.els.cash.classList.toggle('negative', c.cash < 0);
    const today = operatingProfit(c.today);
    this.els.today.textContent = `本日 ${yen(today, { sign: true, compact: true })}`;
    this.els.today.className = `delta ${today >= 0 ? 'up' : 'down'}`;
    this.els.fleet.textContent = `${sim.routes.size} 路線 · ${sim.vehicles.size} 台`;
    this.els.fleetSub.textContent = `累計 ${int(c.totals.passengers)} 人`;
    this.els.date.textContent = `${t.date}（${t.weekday}）`;
    this.els.time.textContent = t.time;
    this.updateFinance();
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
