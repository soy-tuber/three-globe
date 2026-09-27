// Route builder: pick a mode, click cities on the globe, review the plan and projected economics, open.
import type { TransportPath } from '../sim/graph';
import { VEHICLE_MODELS, modelsFor, type City } from '../sim/model';
import { MODES, MODE_INFO, type Mode } from '../sim/modes';
import type { PlanResult } from '../sim/networks';
import type { RouteEstimate } from '../sim/simulation';
import { duration, int, km, yen } from './format';
import { bindEls, h } from './hud';

export interface BuilderCallbacks {
  plan(mode: Mode, stops: City[]): Promise<PlanResult>;
  estimate(mode: Mode, stops: City[], legs: TransportPath[], modelId: string, count: number): RouteEstimate;
  open(mode: Mode, stops: City[], legs: TransportPath[], modelId: string, count: number, name: string): string | null;
  preview(mode: Mode, legs: TransportPath[] | null): void;
  modeChanged(mode: Mode): void;
  stopsChanged(ids: string[]): void;
  closed(): void;
  cash(): number;
}

const MAX_STOPS = 6;
const SUFFIX: Record<Mode, string> = { bus: '線', rail: '線', air: '便', ship: '航路' };

export class RouteBuilder {
  readonly root: HTMLElement;
  private readonly els: Record<string, HTMLElement>;
  private mode: Mode = 'bus';
  private stops: City[] = [];
  private legs: TransportPath[] | null = null;
  private error = '';
  private planning = false;
  private token = 0;
  private modelId = modelsFor('bus')[0].id;
  private count = 1;
  private userPickedModel = false;
  isOpen = false;

  constructor(
    parent: HTMLElement,
    private readonly cb: BuilderCallbacks,
  ) {
    this.root = h('aside', 'panel route-panel builder');
    this.root.innerHTML = `
      <div class="panel-title"><span>新規路線</span><button class="mini" data-el="cancel" title="キャンセル (Esc)">✕</button></div>
      <div class="mode-tabs" data-el="modes"></div>
      <p class="hint" data-el="hint"></p>
      <ol class="builder-stops" data-el="stops"></ol>
      <div class="plan-status" data-el="status"></div>
      <div class="grid estimate" data-el="estimate"></div>
      <div class="section-title">車両</div>
      <div class="model-list" data-el="models"></div>
      <div class="count-row"><span>台数</span><button class="mini" data-el="minus">−</button><b data-el="count">1</b><button class="mini" data-el="plus">＋</button></div>
      <button class="btn primary" data-el="open"></button>`;
    parent.appendChild(this.root);
    this.els = bindEls(this.root);
    this.root.style.display = 'none';

    for (const m of MODES) {
      const b = h('button', 'mode-tab', `<span>${MODE_INFO[m].icon}</span>${MODE_INFO[m].name}`);
      b.dataset.mode = m;
      b.addEventListener('click', () => this.setMode(m));
      this.els.modes.appendChild(b);
    }
    this.els.cancel.addEventListener('click', () => this.close());
    this.els.minus.addEventListener('click', () => ((this.count = Math.max(1, this.count - 1)), this.render()));
    this.els.plus.addEventListener('click', () => ((this.count = Math.min(6, this.count + 1)), this.render()));
    this.els.models.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-model]');
      if (!b) return;
      this.modelId = b.dataset.model!;
      this.userPickedModel = true;
      this.render();
    });
    this.els.stops.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-remove]');
      if (!b) return;
      this.stops.splice(+b.dataset.remove!, 1);
      this.replan();
    });
    this.els.open.addEventListener('click', () => this.submit());
  }

  get currentMode(): Mode {
    return this.mode;
  }

  open(mode: Mode = this.mode, first?: City) {
    this.isOpen = true;
    this.root.style.display = '';
    this.stops = first ? [first] : [];
    this.setMode(mode);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.style.display = 'none';
    this.stops = [];
    this.legs = null;
    this.cb.preview(this.mode, null);
    this.cb.stopsChanged([]);
    this.cb.closed();
  }

  setMode(mode: Mode) {
    this.mode = mode;
    this.userPickedModel = false;
    this.modelId = modelsFor(mode)[0].id;
    this.els.modes.querySelectorAll<HTMLElement>('.mode-tab').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    this.cb.modeChanged(mode);
    this.replan();
  }

  /** A city was clicked on the globe. */
  addCity(city: City) {
    const i = this.stops.findIndex(s => s.id === city.id);
    if (i === this.stops.length - 1 && i >= 0) this.stops.pop(); // click the last stop again → undo
    else if (i >= 0) return;
    else if (this.stops.length >= MAX_STOPS) return;
    else this.stops.push(city);
    this.replan();
  }

  private async replan() {
    this.cb.stopsChanged(this.stops.map(s => s.id));
    this.legs = null;
    this.error = '';
    this.cb.preview(this.mode, null);
    if (this.stops.length < 2) {
      this.planning = false;
      this.render();
      return;
    }
    const token = ++this.token;
    this.planning = true;
    this.render();
    const res = await this.cb.plan(this.mode, [...this.stops]);
    if (token !== this.token) return;
    this.planning = false;
    if (res.ok) {
      this.legs = res.legs;
      // Pick the smallest aircraft that has the range.
      if (!this.userPickedModel) {
        const longest = Math.max(...res.legs.map(l => l.lengthKm));
        this.modelId = (modelsFor(this.mode).find(m => m.rangeKm >= longest) ?? modelsFor(this.mode).at(-1)!).id;
      }
      this.cb.preview(this.mode, res.legs);
    } else this.error = res.error;
    this.render();
  }

  private submit() {
    if (!this.legs) return;
    const name = `${this.stops[0].name}–${this.stops[this.stops.length - 1].name}${SUFFIX[this.mode]}`;
    const err = this.cb.open(this.mode, this.stops, this.legs, this.modelId, this.count, name);
    if (err) {
      this.error = err;
      this.render();
      return;
    }
    this.close();
  }

  render() {
    const info = MODE_INFO[this.mode];
    this.els.hint.innerHTML =
      this.stops.length === 0
        ? `地図上の都市をクリックして${info.name}の停車地を選びます（最大${MAX_STOPS}）。灰色の都市は利用できません。`
        : this.stops.length === 1
          ? '次の停車地をクリックしてください。'
          : '停車地を追加するか、内容を確認して開設します。最後の停車地をもう一度クリックすると取り消せます。';

    this.els.stops.innerHTML = this.stops
      .map((s, i) => `<li><span class="num">${i + 1}</span><b>${s.name}</b><span class="muted">${s.pref}</span><button class="mini" data-remove="${i}">✕</button></li>`)
      .join('');

    const status = this.els.status;
    status.className = 'plan-status';
    if (this.planning) {
      status.textContent = '経路を探索しています…';
      status.classList.add('busy');
    } else if (this.error) {
      status.textContent = this.error;
      status.classList.add('error');
    } else status.textContent = '';

    // Model list.
    const longest = this.legs ? Math.max(...this.legs.map(l => l.lengthKm)) : 0;
    this.els.models.innerHTML = modelsFor(this.mode)
      .map(m => {
        const outOfRange = m.rangeKm < longest;
        const range = Number.isFinite(m.rangeKm) ? `・航続 ${int(m.rangeKm)} km` : '';
        return `<button class="model ${m.id === this.modelId ? 'active' : ''} ${outOfRange ? 'disabled' : ''}" data-model="${m.id}">
          <b>${m.name}</b><span>${m.capacity}席・${m.maxSpeedKmh} km/h${range}</span><em>${yen(m.purchasePrice, { compact: true })}</em></button>`;
      })
      .join('');
    this.els.count.textContent = String(this.count);

    const model = VEHICLE_MODELS[this.modelId];
    const openBtn = this.els.open as HTMLButtonElement;
    const price = model.purchasePrice * this.count;
    if (!this.legs) {
      this.els.estimate.innerHTML = '';
      openBtn.disabled = true;
      openBtn.innerHTML = `開設する <span>${yen(price, { compact: true })}</span>`;
      return;
    }
    const est = this.cb.estimate(this.mode, this.stops, this.legs, this.modelId, this.count);
    const profitCls = est.profitPerDay >= 0 ? 'up' : 'down';
    this.els.estimate.innerHTML = `
      <div><div class="k">距離</div><div class="v">${km(est.lengthKm)}</div></div>
      <div><div class="k">所要（片道）</div><div class="v">${duration(est.tripHours * 60)}</div></div>
      <div><div class="k">運賃</div><div class="v">${yen(est.fare)}</div></div>
      <div><div class="k">便数（片道/日）</div><div class="v">${est.departuresPerDay.toFixed(1)}</div></div>
      <div><div class="k">需要/日</div><div class="v">${int(est.demandPerDay)}</div></div>
      <div><div class="k">輸送力/日</div><div class="v">${int(est.capacityPerDay)}</div></div>
      <div class="wide"><div class="k">予想営業損益/日</div><div class="v ${profitCls}">${yen(est.profitPerDay, { sign: true, compact: true })}
        <small>${est.profitPerDay > 0 ? `回収 約${Math.ceil(price / est.profitPerDay)}日` : '赤字の見込み'}</small></div></div>`;
    const tooFar = longest > model.rangeKm;
    const broke = this.cb.cash() < price;
    openBtn.disabled = tooFar || broke;
    openBtn.innerHTML = tooFar ? '航続距離が足りません' : broke ? `資金不足 <span>${yen(price, { compact: true })}</span>` : `開設する <span>${yen(price, { compact: true })}</span>`;
  }
}
