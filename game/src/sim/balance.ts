// Headless balance scenarios: run one route for a few weeks and measure its economics.
// Shared by scripts/balance.ts (the CLI table) and tests/balance.test.ts (regression bounds).
import { operatingProfit, sum } from './economy';
import { VEHICLE_MODELS, type City } from './model';
import type { Mode } from './modes';
import type { Networks } from './networks';
import { Simulation } from './simulation';

export interface Scenario {
  name: string;
  mode: Mode;
  modelId: string;
  stops: string[];
  vehicles: number;
  fare?: number;
  /** a deliberately poor route (the model should punish it) */
  poor?: boolean;
}

export interface ScenarioResult {
  scenario: Scenario;
  distanceKm: number;
  tripHours: number;
  demandPerDay: number;
  capacityPerDay: number;
  paxPerDay: number;
  loadFactor: number;
  revenuePerDay: number;
  costPerDay: number;
  profitPerDay: number;
  /** days of operating profit to pay back the fleet (Infinity if unprofitable) */
  paybackDays: number;
}

/** Representative routes per mode and vehicle (its "sweet spot"). */
export const SCENARIOS: Scenario[] = [
  { name: '東京–大阪', mode: 'bus', modelId: 'microbus-28', stops: ['tokyo', 'osaka'], vehicles: 1 },
  { name: '東京–大阪 ×3', mode: 'bus', modelId: 'microbus-28', stops: ['tokyo', 'osaka'], vehicles: 3 },
  { name: '東京–名古屋', mode: 'bus', modelId: 'coach-50', stops: ['tokyo', 'nagoya'], vehicles: 1 },
  { name: '大阪–広島', mode: 'bus', modelId: 'coach-50', stops: ['osaka', 'hiroshima'], vehicles: 1 },
  { name: '東京–仙台', mode: 'rail', modelId: 'dmu-2', stops: ['tokyo', 'sendai'], vehicles: 1 },
  { name: '東京–名古屋–大阪', mode: 'rail', modelId: 'emu-6', stops: ['tokyo', 'nagoya', 'osaka'], vehicles: 2 },
  { name: '東京–福岡', mode: 'air', modelId: 'turboprop-70', stops: ['tokyo', 'fukuoka'], vehicles: 1 },
  { name: '東京–札幌', mode: 'air', modelId: 'jet-180', stops: ['tokyo', 'sapporo'], vehicles: 1 },
  { name: '東京–ソウル', mode: 'air', modelId: 'jet-180', stops: ['tokyo', 'seoul-kr'], vehicles: 1 },
  { name: '東京–ロサンゼルス', mode: 'air', modelId: 'widebody-300', stops: ['tokyo', 'los-angeles-us'], vehicles: 2 },
  { name: '大阪–福岡', mode: 'ship', modelId: 'ferry-400', stops: ['osaka', 'fukuoka'], vehicles: 1 },
  { name: '東京–札幌 (船)', mode: 'ship', modelId: 'ferry-400', stops: ['tokyo', 'sapporo'], vehicles: 2, poor: true },
];

export async function runScenario(
  scenario: Scenario,
  cities: City[],
  networks: Networks,
  opts: { days?: number; warmupDays?: number; seed?: number } = {},
): Promise<ScenarioResult> {
  const days = opts.days ?? 14, warm = opts.warmupDays ?? 2;
  const sim = new Simulation({
    seed: opts.seed ?? 1,
    startMs: Date.UTC(2026, 2, 31, 15, 0), // 00:00 JST
    cities,
    companyName: 'balance',
    startingCash: 0,
  });
  const byId = new Map(cities.map(c => [c.id, c]));
  const plan = await networks.plan(
    scenario.mode,
    scenario.stops.map(id => {
      const c = byId.get(id);
      if (!c) throw new Error(`unknown city ${id}`);
      return c;
    }),
  );
  if (!plan.ok) throw new Error(`${scenario.name}: ${plan.error}`);
  const res = sim.openRoute({
    name: scenario.name,
    color: '#fff',
    mode: scenario.mode,
    stops: scenario.stops,
    paths: plan.legs,
    modelId: scenario.modelId,
    vehicles: scenario.vehicles,
    free: true,
    fare: { multiplier: scenario.fare ?? 1 },
  });
  if (typeof res === 'string') throw new Error(`${scenario.name}: ${res}`);
  const { route } = res;

  const loads: number[] = [];
  const model = VEHICLE_MODELS[scenario.modelId];
  for (let h = 0; h < (days + warm) * 24; h++) {
    sim.advance(60);
    for (const e of sim.drainEvents())
      if (e.type === 'departure' && e.t > warm * 1440) loads.push(e.onboard / model.capacity);
  }
  const reports = sim.company.history.slice(warm, warm + days);
  const n = reports.length || 1;
  const revenue = reports.reduce((a, r) => a + (r.income.fare ?? 0), 0) / n;
  const cost = reports.reduce((a, r) => a + sum(r.expense) - (r.expense.purchase ?? 0), 0) / n;
  const profit = reports.reduce((a, r) => a + operatingProfit(r), 0) / n;
  const pax = reports.reduce((a, r) => a + r.passengers, 0) / n;
  const deps = sim.scheduledDeparturesPerDay(route);
  const last = route.stops.length - 1;
  return {
    scenario,
    distanceKm: route.legs.reduce((a, l) => a + l.lengthKm, 0),
    tripHours: sim.offer(route, 0, last).rideHours,
    demandPerDay: sim.expectedDailyDemand(route, 0, last) + sim.expectedDailyDemand(route, last, 0),
    capacityPerDay: deps * 2 * model.capacity,
    paxPerDay: pax,
    loadFactor: loads.length ? loads.reduce((a, b) => a + b, 0) / loads.length : 0,
    revenuePerDay: revenue,
    costPerDay: cost,
    profitPerDay: profit,
    paybackDays: profit > 0 ? (model.purchasePrice * scenario.vehicles) / profit : Infinity,
  };
}
