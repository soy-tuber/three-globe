import './ui/style.css';
import { loadTerrain } from './render/terrainData';
import { startGame } from './game';
import type { RoadGraphJson } from './sim/roadGraph';

const app = document.getElementById('app')!;

const loader = document.createElement('div');
loader.className = 'loader';
loader.innerHTML = `
  <div class="loader-inner">
    <div class="loader-title">Globe Rush</div>
    <div class="loader-sub">日本高速バス</div>
    <div class="loader-bar"><span></span></div>
    <div class="loader-msg">地球を準備しています…</div>
  </div>`;
document.body.appendChild(loader);
const bar = loader.querySelector<HTMLSpanElement>('.loader-bar span')!;
const msg = loader.querySelector<HTMLDivElement>('.loader-msg')!;

function supportsWebGL2() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

async function main() {
  if (!supportsWebGL2()) throw new Error('このブラウザは WebGL2 に対応していません。');
  const base = import.meta.env.BASE_URL;
  const [terrain, roads] = await Promise.all([
    loadTerrain(base, 8, (label, done, total) => {
      bar.style.width = `${Math.round((done / (total + 1)) * 100)}%`;
      msg.textContent = `読み込み中: ${label}`;
    }),
    fetch(`${base}assets/data/roads-japan.json`).then(r => r.json() as Promise<RoadGraphJson>),
  ]);
  msg.textContent = '道路網から経路を探索しています…';
  await startGame(app, terrain, roads);
  bar.style.width = '100%';
  loader.classList.add('done');
  setTimeout(() => loader.remove(), 900);
}

main().catch(err => {
  console.error(err);
  msg.textContent = `エラー: ${err instanceof Error ? err.message : String(err)}`;
  loader.classList.add('error');
});
