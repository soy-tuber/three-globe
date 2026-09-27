// Test helpers: load the generated network data from public/ in Node.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Networks, type NetworksManifest } from '../src/sim';
import { CITIES } from '../src/data/cities';
import type { City } from '../src/sim';

export const PUBLIC = path.resolve(import.meta.dirname, '../public');

export function loadNetworks(): Networks {
  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'assets/data/networks.json'), 'utf8')) as NetworksManifest;
  return new Networks(manifest, {
    json: async url => JSON.parse(fs.readFileSync(path.join(PUBLIC, url), 'utf8')),
    bytes: async url => new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(PUBLIC, url)))),
  });
}

export const WORLD_CITIES: City[] = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'assets/data/cities-world.json'), 'utf8'));
export const ALL_CITIES: City[] = [...CITIES, ...WORLD_CITIES];
export const city = (idOrEn: string) => ALL_CITIES.find(c => c.id === idOrEn || c.nameEn === idOrEn)!;
