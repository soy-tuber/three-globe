// World cities from Natural Earth populated places (Japan is curated separately in src/data/cities.ts).
import { haversineKm } from './roads.mjs';

/**
 * Pick the world's major cities: every place with a metro population ≥ minPop, plus national capitals
 * ≥ capitalMinPop, skipping places within `dedupeKm` of a bigger pick (NE lists suburbs of megacities).
 */
/** "ソウル特別市" → "ソウル", "北京市" → "北京" (administrative suffixes read oddly on a map). */
function cleanName(name) {
  return name.replace(/(特別市|広域市|特別自治市)$/, '').replace(/^(.{2,})市$/, '$1');
}

/** Smaller places worth having as destinations (resorts, hubs). */
const EXTRA = ['Honolulu', 'Anchorage', 'Reykjavík', 'Auckland', 'Denpasar', 'Cebu', 'Guam'];

export function selectWorldCities(places, countries, { minPop = 1_500_000, capitalMinPop = 400_000, dedupeKm = 70, exclude = ['JPN'] } = {}) {
  const countryJa = new Map(countries.features.map(f => [f.properties.ADM0_A3, f.properties.NAME_JA]));
  const cand = places.features
    .map(f => f.properties)
    .filter(p => !exclude.includes(p.ADM0_A3) && !exclude.includes(p.SOV0NAME))
    .filter(
      p => p.POP_MAX >= minPop || (p.ADM0CAP === 1 && p.POP_MAX >= capitalMinPop) || EXTRA.includes(p.NAME),
    )
    .sort((a, b) => b.POP_MAX - a.POP_MAX);

  const picked = [];
  for (const p of cand) {
    const pos = [p.LONGITUDE, p.LATITUDE];
    if (picked.some(q => haversineKm(pos, [q.lng, q.lat]) < dedupeKm)) continue;
    const slug = (p.NAMEASCII || p.NAME).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let id = `${slug}-${(p.ISO_A2 || p.ADM0_A3).toLowerCase()}`;
    while (picked.some(q => q.id === id)) id += '-2';
    picked.push({
      id,
      name: cleanName(p.NAME_JA || p.NAME),
      nameEn: p.NAME_EN || p.NAME,
      pref: countryJa.get(p.ADM0_A3) || p.ADM0NAME,
      lat: +p.LATITUDE.toFixed(4),
      lng: +p.LONGITUDE.toFixed(4),
      population: p.POP_MAX,
      capital: p.ADM0CAP === 1,
    });
  }
  return picked;
}
