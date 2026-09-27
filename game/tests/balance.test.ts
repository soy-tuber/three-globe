// Balance regression: each mode's representative route must pay back in a sensible time, and a
// deliberately poor route must not. Run `npm run balance` for the full table when tuning.
import { describe, expect, it } from 'vitest';
import { SCENARIOS, runScenario } from '../src/sim/balance';
import { ALL_CITIES, loadNetworks } from './helpers';

describe('balance', () => {
  const nets = loadNetworks();
  for (const s of SCENARIOS) {
    it(`${s.name} (${s.modelId} ×${s.vehicles})`, async () => {
      const r = await runScenario(s, ALL_CITIES, nets, { days: 10 });
      if (s.poor) {
        expect(r.profitPerDay).toBeLessThan(0);
      } else {
        expect(r.profitPerDay).toBeGreaterThan(0);
        expect(r.paybackDays).toBeGreaterThan(15);
        expect(r.paybackDays).toBeLessThan(90);
        expect(r.loadFactor).toBeGreaterThan(0.5);
      }
    }, 30_000);
  }
});
