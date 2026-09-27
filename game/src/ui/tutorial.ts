// First-run tutorial: a short sequence of coach marks. Steps advance on "次へ" or when the player
// does the thing being explained.
import { h } from './hud';

export type TutorialTrigger = 'camera' | 'speed' | 'builder' | 'route-opened';

interface Step {
  title: string;
  body: string;
  /** CSS selector of the element to highlight */
  target?: string;
  /** advance automatically when this happens */
  until?: TutorialTrigger;
}

const STEPS: Step[] = [
  {
    title: 'ようこそ、社長！',
    body: 'あなたは新しい輸送会社「東海ハイウェイ交通」の社長です。東京–大阪の高速バス1台からスタートします。',
  },
  {
    title: '地球を動かす',
    body: 'ドラッグで移動、ホイール（ピンチ）でズーム。地表に近づくと視点が斜めになります。右ドラッグで回転・傾き。',
    until: 'camera',
  },
  {
    title: '時間を進める',
    body: '右上のボタンで時間の速さを切り替えます。<kbd>Space</kbd> で一時停止、<kbd>1</kbd>–<kbd>4</kbd> で速度変更。',
    target: '.speed',
    until: 'speed',
  },
  {
    title: '路線の状況',
    body: '右のパネルで路線の需要・輸送力・待ち客を確認できます。満席で「取りこぼし」が多いなら車両を追加しましょう。',
    target: '.route-panel',
  },
  {
    title: '新しい路線をつくる',
    body: '「＋ 新規路線」を押し、交通手段（バス・鉄道・航空・船）を選んで、地図上の都市を順にクリックします。予想収支を見てから開設しましょう。',
    target: '[data-el="new"]',
    until: 'builder',
  },
  {
    title: '目標とボーナス',
    body: '左の「目標」を達成すると報酬が入ります。バスで資金を貯め、鉄道・航空・船、そして世界へ路線網を広げましょう！',
    target: '.goals-panel',
  },
];

const STORAGE_KEY = 'globe-rush.tutorial-done';

export class Tutorial {
  private step = -1;
  private readonly card: HTMLElement;
  private focused: Element | null = null;

  constructor(private readonly parent: HTMLElement) {
    this.card = h('div', 'tutorial');
    this.card.style.display = 'none';
    parent.appendChild(this.card);
    this.card.addEventListener('click', e => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'next') this.next();
      if (act === 'skip') this.finish();
    });
    window.addEventListener('resize', () => this.position());
  }

  static shouldAutoStart(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) !== '1';
    } catch {
      return true;
    }
  }

  get active() {
    return this.step >= 0;
  }

  start() {
    this.step = -1;
    this.next();
  }

  /** Something happened in the game; advance if the current step was waiting for it. */
  notify(trigger: TutorialTrigger) {
    if (this.step >= 0 && STEPS[this.step].until === trigger) setTimeout(() => this.next(), 600);
  }

  private next() {
    this.step++;
    if (this.step >= STEPS.length) return this.finish();
    const s = STEPS[this.step];
    this.card.innerHTML = `
      <div class="tut-step">${this.step + 1} / ${STEPS.length}</div>
      <div class="tut-title">${s.title}</div>
      <div class="tut-body">${s.body}</div>
      <div class="tut-actions"><button class="mini" data-act="skip">スキップ</button>
        <button class="btn-accent" data-act="next">${this.step === STEPS.length - 1 ? 'はじめる' : s.until ? '次へ（または実際に操作）' : '次へ'}</button></div>`;
    this.card.style.display = '';
    this.focused?.classList.remove('tutorial-focus');
    this.focused = s.target ? this.parent.querySelector(s.target) : null;
    this.focused?.classList.add('tutorial-focus');
    this.position();
  }

  private position() {
    if (this.step < 0) return;
    const card = this.card;
    const target = this.focused?.getBoundingClientRect();
    card.classList.toggle('centered', !target);
    if (!target) {
      card.style.left = card.style.top = '';
      return;
    }
    const w = card.offsetWidth || 320, hgt = card.offsetHeight || 160;
    // Prefer the side of the target with more room.
    let x = target.left - w - 16;
    if (x < 12) x = target.right + 16;
    x = Math.max(12, Math.min(window.innerWidth - w - 12, x));
    let y = target.top;
    y = Math.max(12, Math.min(window.innerHeight - hgt - 12, y));
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  }

  private finish() {
    this.step = -1;
    this.card.style.display = 'none';
    this.focused?.classList.remove('tutorial-focus');
    this.focused = null;
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* storage unavailable (private mode) — tutorial will simply show again next time */
    }
  }
}
