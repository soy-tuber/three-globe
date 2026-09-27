#!/usr/bin/env -S npx tsx
// Balance report: runs every scenario headless and prints its economics.
//
//   npm run balance              # table
//   npm run balance -- --days 30 # longer runs
//   npm run balance -- --json    # machine-readable
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CITIES } from '../src/data/cities';
import { SCENARIOS, runScenario } from '../src/sim/balance';
import { Networks, type City, type NetworksManifest } from '../src/sim';

const PUBLIC = path.resolve(import.meta.dirname, '../public');
const args = process.argv.slice(2);
const days = Number(args[args.indexOf('--days') + 1]) || 14;

const manifest: NetworksManifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'assets/data/networks.json'), 'utf8'));
const networks = new Networks(manifest, {
  json: async url => JSON.parse(fs.readFileSync(path.join(PUBLIC, url), 'utf8')),
  bytes: async url => new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(PUBLIC, url)))),
});
const world: City[] = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'assets/data/cities-world.json'), 'utf8'));
const cities = [...CITIES, ...world];

const yen = (n: number) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${(n / 1e3).toFixed(0)}k`);
const rows = [];
for (const s of SCENARIOS) rows.push(await runScenario(s, cities, networks, { days }));

if (args.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log(`\n${days}-day averages per route (2 warm-up days)\n`);
  console.table(
    rows.map(r => ({
      route: r.scenario.name,
      model: r.scenario.modelId,
      veh: r.scenario.vehicles,
      km: Math.round(r.distanceKm),
      'ride h': r.tripHours.toFixed(1),
      'demand/d': Math.round(r.demandPerDay),
      'cap/d': Math.round(r.capacityPerDay),
      'pax/d': Math.round(r.paxPerDay),
      load: `${Math.round(r.loadFactor * 100)}%`,
      'rev/d': yen(r.revenuePerDay),
      'cost/d': yen(r.costPerDay),
      'profit/d': yen(r.profitPerDay),
      payback: Number.isFinite(r.paybackDays) ? `${Math.round(r.paybackDays)}d` : '—',
    })),
  );
}
