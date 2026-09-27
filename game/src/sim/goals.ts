// Goals: a progression of objectives with cash rewards. Pure functions over simulation state.
import { operatingProfit } from './economy';
import type { Simulation } from './simulation';

export interface Goal {
  id: string;
  title: string;
  hint: string;
  reward: number;
  /** [current, target] */
  progress(sim: Simulation): [number, number];
}

const JAPAN = (lat: number, lng: number) => lng > 122 && lng < 154 && lat > 24 && lat < 46.5;

const routesOf = (sim: Simulation, mode?: string) => [...sim.routes.values()].filter(r => !mode || r.mode === mode);

export const GOALS: Goal[] = [
  {
    id: 'first-profit',
    title: '初めての黒字',
    hint: '1日の営業損益をプラスにする',
    reward: 5_000_000,
    progress: s => [s.company.history.some(d => operatingProfit(d) > 0) ? 1 : 0, 1],
  },
  {
    id: 'second-route',
    title: '路線網の第一歩',
    hint: '「＋ 新規路線」から2本目の路線を開設する',
    reward: 5_000_000,
    progress: s => [s.routes.size, 2],
  },
  {
    id: 'fleet-4',
    title: '車両4台体制',
    hint: '混雑している路線に車両を追加する',
    reward: 8_000_000,
    progress: s => [s.vehicles.size, 4],
  },
  {
    id: 'pax-5k',
    title: '累計乗客 5,000人',
    hint: '需要の多い大都市間を結ぶ',
    reward: 10_000_000,
    progress: s => [s.company.totals.passengers, 5_000],
  },
  {
    id: 'rail',
    title: '鉄道事業に参入',
    hint: '鉄道路線を開設する（気動車 ¥1.1億〜）',
    reward: 25_000_000,
    progress: s => [routesOf(s, 'rail').length, 1],
  },
  {
    id: 'daily-1m',
    title: '日商100万円',
    hint: '1日の営業利益 ¥100万を達成',
    reward: 20_000_000,
    progress: s => [Math.max(0, ...s.company.history.map(operatingProfit)), 1_000_000],
  },
  {
    id: 'ship',
    title: '海の道',
    hint: '港のある都市どうしを船で結ぶ',
    reward: 25_000_000,
    progress: s => [routesOf(s, 'ship').length, 1],
  },
  {
    id: 'air',
    title: '空へ',
    hint: '航空路線を開設する（ターボプロップ機 ¥2.3億〜）',
    reward: 40_000_000,
    progress: s => [routesOf(s, 'air').length, 1],
  },
  {
    id: 'cities-12',
    title: '12都市に就航',
    hint: 'いろいろな都市に路線を伸ばす',
    reward: 30_000_000,
    progress: s => [new Set(routesOf(s).flatMap(r => r.stops)).size, 12],
  },
  {
    id: 'international',
    title: '海外進出',
    hint: '日本と海外の都市を結ぶ',
    reward: 60_000_000,
    progress: s => {
      const intl = routesOf(s).some(r => {
        const inJp = r.stops.map(id => s.cities.get(id)!).map(c => JAPAN(c.lat, c.lng));
        return inJp.includes(true) && inJp.includes(false);
      });
      return [intl ? 1 : 0, 1];
    },
  },
  {
    id: 'pax-100k',
    title: '累計乗客 10万人',
    hint: '大量輸送の鉄道・航空を活用する',
    reward: 100_000_000,
    progress: s => [s.company.totals.passengers, 100_000],
  },
  {
    id: 'cash-1b',
    title: '資金10億円',
    hint: '一流の輸送会社へ',
    reward: 0,
    progress: s => [s.company.cash, 1_000_000_000],
  },
];

export interface GoalState {
  completed: string[];
}

/** Goals still open, in order; the first `n` are the "current" ones shown to the player. */
export function openGoals(state: GoalState, n = Infinity): Goal[] {
  return GOALS.filter(g => !state.completed.includes(g.id)).slice(0, n);
}
