// Route panel: the list of our routes and the detail view of the selected one.
import { operatingProfit } from '../sim/economy';
import { VEHICLE_MODELS, modelsFor } from '../sim/model';
import { MODE_INFO } from '../sim/modes';
import { freeFlowMinutes, stopDistanceKm, waitingAt, type RouteState } from '../sim/route';
import { RESALE_RATIO, type Simulation } from '../sim/simulation';
import { onboardCount, type VehicleState } from '../sim/vehicle';
import { ticketPrice } from '../sim/model';
import { duration, int, km, yen } from './format';
import { bindEls, h } from './hud';

export interface RoutePanelCallbacks {
  select(routeId: string): void;
  newRoute(): void;
  setFare(routeId: string, multiplier: number): void;
  buyVehicle(routeId: string, modelId: string): void;
  closeRoute(routeId: string): void;
  followVehicle(id: string): void;
  focusRoute(routeId: string): void;
}

export class RoutePanel {
  readonly root: HTMLElement;
  private readonly els: Record<string, HTMLElement>;
  private readonly listItems = new Map<string, HTMLElement>();
  private readonly cards = new Map<string, Record<string, HTMLElement>>();
  private selectedId: string | null = null;
  private closeArmed = false;

  constructor(
    parent: HTMLElement,
    private readonly sim: Simulation,
    cb: RoutePanelCallbacks,
  ) {
    this.root = h('aside', 'panel route-panel');
    this.root.innerHTML = `
      <div class="panel-title"><span>路線</span><button class="btn-accent" data-el="new">＋ 新規路線</button></div>
      <div class="route-list" data-el="list"></div>
      <div class="route-detail" data-el="detail">
        <div class="panel-head"><span class="chip" data-el="chip"></span><div><div class="title" data-el="name"></div><div class="subtitle" data-el="sub"></div></div>
          <button class="mini" data-el="focus" title="路線全体を表示">表示</button></div>
        <div class="grid">
          <div><div class="k">営業距離</div><div class="v" data-el="dist"></div></div>
          <div><div class="k">所要時間</div><div class="v" data-el="dur"></div></div>
          <div><div class="k">運賃（全区間）</div><div class="v" data-el="fare"></div></div>
          <div><div class="k">需要（往復/日）</div><div class="v" data-el="demand"></div></div>
        </div>
        <label class="slider"><span>運賃設定</span><input type="range" min="0.6" max="1.6" step="0.05" value="1" data-el="fareSlider"/><span class="slider-val" data-el="fareMult"></span></label>
        <div class="stops" data-el="stops"></div>
        <div class="section-title">車両 <span class="muted" data-el="freq"></span></div>
        <div class="vehicles" data-el="vehicles"></div>
        <div class="buy-row"><select data-el="model"></select><button class="btn" data-el="buy"></button></div>
        <div class="totals" data-el="totals"></div>
        <button class="btn danger" data-el="close"></button>
      </div>`;
    parent.appendChild(this.root);
    this.els = bindEls(this.root);

    this.els.new.addEventListener('click', () => cb.newRoute());
    this.els.fareSlider.addEventListener('input', e => {
      if (this.selectedId) cb.setFare(this.selectedId, +(e.target as HTMLInputElement).value);
      this.update();
    });
    this.els.buy.addEventListener('click', () => {
      if (this.selectedId) cb.buyVehicle(this.selectedId, (this.els.model as HTMLSelectElement).value);
    });
    this.els.model.addEventListener('change', () => this.update());
    this.els.focus.addEventListener('click', () => this.selectedId && cb.focusRoute(this.selectedId));
    this.els.close.addEventListener('click', () => {
      if (!this.selectedId) return;
      if (!this.closeArmed) {
        this.closeArmed = true;
        this.update();
        setTimeout(() => ((this.closeArmed = false), this.update()), 3000);
        return;
      }
      this.closeArmed = false;
      cb.closeRoute(this.selectedId);
    });
    this.els.vehicles.addEventListener('click', e => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-follow]');
      if (btn) cb.followVehicle(btn.dataset.follow!);
    });
    this.els.list.addEventListener('click', e => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('[data-route]');
      if (item) cb.select(item.dataset.route!);
    });
  }

  get selected() {
    return this.selectedId;
  }

  select(routeId: string | null) {
    if (routeId === this.selectedId) return;
    this.selectedId = routeId;
    this.closeArmed = false;
    for (const c of this.cards.values()) c.el.remove();
    this.cards.clear();
    const r = routeId ? this.sim.routes.get(routeId) : null;
    if (r) {
      (this.els.fareSlider as HTMLInputElement).value = String(r.fare.multiplier);
      const sel = this.els.model as HTMLSelectElement;
      sel.innerHTML = modelsFor(r.mode)
        .map(m => `<option value="${m.id}">${m.name} — ${yen(m.purchasePrice, { compact: true })}</option>`)
        .join('');
      const current = this.sim.vehiclesOn(r.id)[0]?.modelId;
      if (current) sel.value = current;
    }
    this.update();
  }

  setVisible(on: boolean) {
    this.root.style.display = on ? '' : 'none';
  }

  update() {
    this.updateList();
    const r = this.selectedId ? this.sim.routes.get(this.selectedId) : undefined;
    this.els.detail.style.display = r ? '' : 'none';
    if (r) this.updateDetail(r);
  }

  private updateList() {
    const routes = [...this.sim.routes.values()];
    const ids = new Set(routes.map(r => r.id));
    for (const [id, el] of this.listItems) if (!ids.has(id)) (el.remove(), this.listItems.delete(id));
    for (const r of routes) {
      let el = this.listItems.get(r.id);
      if (!el) {
        el = h('button', 'route-item');
        el.dataset.route = r.id;
        this.els.list.appendChild(el);
        this.listItems.set(r.id, el);
      }
      const n = this.sim.vehiclesOn(r.id).length;
      const waiting = r.stops.reduce((a, _, i) => a + waitingAt(r, i), 0);
      const html = `<span class="chip" style="background:${r.color}"></span><span class="ri-icon">${MODE_INFO[r.mode].icon}</span>
        <span class="ri-name">${r.name}</span><span class="ri-meta">${n}台・待ち${int(waiting)}</span>`;
      if (el.innerHTML !== html) el.innerHTML = html;
      el.classList.toggle('active', r.id === this.selectedId);
    }
  }

  private updateDetail(r: RouteState) {
    const sim = this.sim;
    const last = r.stops.length - 1;
    const total = stopDistanceKm(r, 0, last);
    const fast = r.legs.reduce((a, l) => a + l.fastKm, 0);
    const info = MODE_INFO[r.mode];
    const vehicles = sim.vehiclesOn(r.id);
    const model = VEHICLE_MODELS[vehicles[0]?.modelId ?? modelsFor(r.mode)[0].id];
    const fastLabel = { bus: '高速', rail: '幹線', air: '', ship: '' }[r.mode];

    this.els.chip.style.background = r.color;
    this.els.name.textContent = r.name;
    this.els.sub.textContent = `${info.icon} ${info.name}・${r.stops.map(id => sim.cities.get(id)!.name).join(' – ')}`;
    this.els.dist.innerHTML = `${km(total)}${fastLabel ? `<small>${fastLabel} ${Math.round((fast / total) * 100)}%</small>` : ''}`;
    this.els.dur.textContent = duration(freeFlowMinutes(r, model.maxSpeedKmh) + model.dwellMin * (r.stops.length - 2));
    this.els.fare.textContent = yen(ticketPrice(total, r.fare, r.mode));
    this.els.fareMult.textContent = `×${r.fare.multiplier.toFixed(2)}`;
    let demand = 0;
    for (let a = 0; a <= last; a++) for (let b = 0; b <= last; b++) if (a !== b) demand += sim.expectedDailyDemand(r, a, b);
    const deps = sim.scheduledDeparturesPerDay(r);
    const capacity = deps * 2 * model.capacity;
    this.els.demand.innerHTML = `${int(demand)}<small>輸送力 ${int(capacity)}</small>`;
    this.els.freq.textContent = `片道 ${deps.toFixed(1)}便/日・折返し ${duration(sim.cycleMinutes(r) / 2)}`;

    const stopsHtml = r.stops
      .map((id, i) => {
        const c = sim.cities.get(id)!;
        return `<div class="stop"><span class="dot" style="--c:${r.color}"></span><b>${c.name}</b><span class="muted">待ち ${int(waitingAt(r, i))}人</span></div>`;
      })
      .join('');
    if (this.els.stops.innerHTML !== stopsHtml) this.els.stops.innerHTML = stopsHtml;

    this.syncVehicleCards(vehicles, r);
    const buyModel = VEHICLE_MODELS[(this.els.model as HTMLSelectElement).value] ?? model;
    this.els.buy.innerHTML = `＋ 購入 <span>${yen(buyModel.purchasePrice, { compact: true })}</span>`;
    (this.els.buy as HTMLButtonElement).disabled = sim.company.cash < buyModel.purchasePrice;

    const refund = vehicles.reduce((a, v) => a + v.purchasePrice * RESALE_RATIO, 0);
    this.els.close.textContent = this.closeArmed ? `本当に廃止する？（売却 ${yen(refund, { compact: true })}）` : '路線を廃止';
    this.els.close.classList.toggle('armed', this.closeArmed);

    const days = sim.company.history.length;
    this.els.totals.innerHTML = `
      <div><span>累計乗客</span><b>${int(r.stats.passengers)}人</b></div>
      <div><span>累計運賃収入</span><b>${yen(r.stats.revenue, { compact: true })}</b></div>
      <div><span>取りこぼし</span><b>${int(r.stats.lost)}人</b></div>
      <div><span>会社全体の直近営業損益</span><b>${days ? yen(operatingProfit(sim.company.history[days - 1]), { sign: true, compact: true }) : '—'}</b></div>`;
  }

  /** Vehicle cards are keyed and patched in place so their buttons stay clickable. */
  private syncVehicleCards(vehicles: VehicleState[], r: RouteState) {
    const ids = new Set(vehicles.map(v => v.id));
    for (const [id, c] of this.cards) if (!ids.has(id)) (c.el.remove(), this.cards.delete(id));
    for (const v of vehicles) {
      let card = this.cards.get(v.id);
      if (!card) {
        const el = h('div', 'vehicle');
        el.innerHTML = `
          <div class="vh-head"><b data-f="name"></b><span class="muted" data-f="model"></span><button class="mini" data-follow="${v.id}" title="追従 (F)">追従</button></div>
          <div class="vh-status" data-f="status"></div>
          <div class="progress"><span data-f="progress"></span></div>
          <div class="vh-row"><span>乗客</span><div class="bar"><span data-f="load"></span></div><b data-f="pax"></b></div>`;
        card = { el };
        el.querySelectorAll<HTMLElement>('[data-f]').forEach(x => (card![x.dataset.f!] = x));
        this.els.vehicles.appendChild(el);
        this.cards.set(v.id, card);
      }
      this.fillCard(card, v, r);
    }
  }

  private fillCard(card: Record<string, HTMLElement>, v: VehicleState, r: RouteState) {
    const sim = this.sim;
    const model = VEHICLE_MODELS[v.modelId];
    const n = onboardCount(v);
    const here = sim.cities.get(r.stops[v.stopIndex])!;
    const next = sim.cities.get(r.stops[v.stopIndex + v.dir])!;
    const eta = sim.etaMinutes(v.id);
    const verb = { bus: '走行中', rail: '走行中', air: '飛行中', ship: '航行中' }[r.mode];
    let status: string, progress = 0;
    if (v.status === 'dwell') status = `${here.name}で乗車中 → ${next.name}行き・発車まで ${duration(eta)}`;
    else {
      const leg = r.legs[v.dir === 1 ? v.stopIndex : v.stopIndex - 1];
      progress = v.legKm / leg.lengthKm;
      status = `${next.name}へ${verb}・${Math.round(v.speedKmh)} km/h・到着まで ${duration(eta)}`;
    }
    const set = (k: string, text: string) => card[k].textContent !== text && (card[k].textContent = text);
    set('name', v.name);
    set('model', model.name);
    set('status', status);
    set('pax', `${n}/${model.capacity}`);
    card.progress.style.width = `${(progress * 100).toFixed(1)}%`;
    card.progress.style.background = r.color;
    card.load.style.width = `${((n / model.capacity) * 100).toFixed(0)}%`;
  }
}
