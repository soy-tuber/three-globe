// Goals panel: the next few objectives with progress bars and rewards.
import { GOALS, openGoals } from '../sim/goals';
import type { Simulation } from '../sim/simulation';
import { int, yen } from './format';
import { h } from './hud';

export class GoalsPanel {
  readonly root: HTMLElement;
  private collapsed = false;
  private last = '';

  constructor(
    parent: HTMLElement,
    private readonly sim: Simulation,
  ) {
    this.root = h('section', 'panel goals-panel');
    parent.appendChild(this.root);
    this.root.addEventListener('click', e => {
      if ((e.target as HTMLElement).closest('.goals-head')) {
        this.collapsed = !this.collapsed;
        this.last = '';
        this.update();
      }
    });
  }

  update() {
    const done = this.sim.goals.completed.length;
    const open = openGoals(this.sim.goals, 3);
    const fmt = (id: string, v: number) => (id.startsWith('cash') || id.startsWith('daily') ? yen(v, { compact: true }) : int(v));
    const items = open
      .map(g => {
        const [cur, target] = g.progress(this.sim);
        const pct = Math.max(0, Math.min(1, cur / target));
        const counter = target > 1 ? `<span class="gp-num">${fmt(g.id, Math.min(cur, target))} / ${fmt(g.id, target)}</span>` : '';
        return `<div class="goal">
          <div class="goal-top"><b>${g.title}</b>${g.reward ? `<span class="reward">+${yen(g.reward, { compact: true })}</span>` : ''}</div>
          <div class="goal-hint">${g.hint}</div>
          <div class="goal-bar"><span style="width:${(pct * 100).toFixed(0)}%"></span></div>${counter}
        </div>`;
      })
      .join('');
    const html = `<div class="goals-head"><span class="section-title">目標</span><span class="muted">${done}/${GOALS.length} 達成</span><span class="toggle">${this.collapsed ? '▸' : '▾'}</span></div>
      ${this.collapsed ? '' : items || '<div class="muted">すべての目標を達成しました！</div>'}`;
    if (html !== this.last) {
      this.last = html;
      this.root.innerHTML = html;
    }
  }
}
