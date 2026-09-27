# Globe Rush — 日本高速バス

Worldwide Rush 風の輸送経営ゲームのプロトタイプ。
**Vite + TypeScript + three.js + three-globe** で、起伏のある地球儀の上を高速バスが走ります。

- Natural Earth の陸地・湖・河川・氷河・市街地・道路・国境をラスタライズした地表テクスチャ
- 標高データで変位させた地形（陸は DEM で隆起、海面は平らで海底地形は色で表現）
- 日本の主要 50 都市（47 都道府県庁所在地＋川崎・浜松・北九州）のラベル（ズーム段階と重なり回避つき）
- Natural Earth の道路網から A* で探索した **東京–大阪（東名・名神経由 約 555 km）** を Kenney のバスが走行
- 需要（重力モデル＋運賃・運行頻度による獲得率）と収益（運賃・燃料・高速料金・人件費・固定費）のシミュレーション

## 起動

```bash
cd game
npm install
npm run dev        # http://localhost:5173
npm test           # シミュレーション & アセットパイプラインのテスト
npm run build      # 型チェック + 本番ビルド (dist/)
```

生成済みのアセット（`public/assets/`）はリポジトリに含まれているので、そのまま起動できます。

## 操作

| 操作 | |
|---|---|
| ドラッグ | 地球を移動 |
| ホイール / ピンチ | ズーム（地表に近づくと自動で斜め視点に） |
| 右ドラッグ / Shift+ドラッグ | 回転・傾き |
| `Space` | 一時停止 / 再開 |
| `1`–`4` | ゲーム速度（1 秒あたり 2 分 / 8 分 / 30 分 / 2 時間） |
| `F` | 選択中のバスを追従 |
| `H` | 日本全体を表示 |
| `N` | 実時間の昼夜表示（夜側に都市の灯り） |

右パネルで運賃倍率（×0.6–1.6）の変更、バスの追加購入ができます。都市ラベルをクリックするとその都市へ移動します。

## 構成

```
game/
├─ scripts/build-assets.mjs   アセットパイプライン（下記）
├─ public/assets/             生成済みアセット
│  ├─ terrain/{world,japan}/  albedo.webp, height.hgt, mask.png
│  ├─ data/roads-japan.json   道路グラフ
│  └─ models/bus.glb          Kenney Car Kit (CC0)
├─ src/sim/                   シミュレーション（three.js / DOM に一切依存しない）
│  ├─ geo.ts                  大円距離・方位・ポリライン
│  ├─ roadGraph.ts            道路グラフと A*（経由地つき）
│  ├─ demand.ts               重力モデル需要・獲得率・時間帯プロファイル
│  ├─ economy.ts              資金・日次帳簿
│  ├─ route.ts / vehicle.ts   路線・待ち行列・車両の状態機械
│  ├─ simulation.ts           固定タイムステップ（0.25 分）のワールド更新とイベント
│  └─ clock.ts, model.ts, rng.ts
├─ src/render/                描画（sim の状態を読むだけ）
│  ├─ terrain*.ts             地形シェーダ（変位・DEM 由来の法線・海のハイライト・夜景・大気）
│  ├─ cameraRig.ts            地図アプリ風カメラ（自動チルト・fly-to・追従）
│  ├─ cityLayer.ts            都市マーカー（three-globe objects）＋ HTML ラベル
│  ├─ routeLayer.ts           路線（three-globe paths、地形に沿わせる）
│  └─ vehicleLayer.ts         glTF 車両の配置・向き・車輪回転
├─ src/ui/                    HUD
└─ tests/                     vitest
```

**sim と描画の分離**: `src/sim` はプレーンなデータと純粋な計算だけで構成され、ヘッドレス（テスト・Worker・サーバー）でそのまま動きます。
描画側は毎フレーム `sim.advance(ゲーム分)` を呼び、`sim.pose(id)` で補間済みの位置と向きを受け取るだけです。

## アセットパイプライン

```bash
npm run assets                       # DEM: AWS Terrain Tiles を自動取得
npm run assets -- --gebco ~/gebco    # DEM: GEBCO GeoTIFF タイルを使用
npm run assets -- --only japan       # 1 リージョンだけ再生成
```

- **地表テクスチャ**: Natural Earth 10m ベクタ（陸地・小島・湖・河川・氷河・南極棚氷・市街地・道路・国境）をラスタライズし、標高段彩＋水深段彩の上に重ねています。
  陸の色味には NASA Blue Marble（three-globe 同梱、パブリックドメイン）を低周波の「バイオーム色」として薄く混ぜています。
- **標高**: 全球 4096×2048 と、日本周辺（122–154°E, 24–46°N）の高解像度パッチ 3200×2200（0.01°/px）の 2 段構成。
  日本パッチは専用の細かいメッシュ（0.03° 間隔）で描画され、全球メッシュ側はその範囲をくり抜きます。
- **道路グラフ**: Natural Earth 10m roads から日本周辺を抽出し、頂点をスナップしてグラフ化（短い途切れは自動で接続）。

### GEBCO について

GEBCO の全球グリッドは <https://www.gebco.net/data-and-products/gridded-bathymetry-data> から
「GeoTIFF」形式（90°×90° の 8 タイル、`gebco_20xx_n…_s…_w…_e….tif`）をダウンロードし、
展開したディレクトリを `--gebco` に渡すと、そのデータから標高・水深を生成します（`geotiff` で符号付き 16bit のまま読み込み）。

同梱アセットは、この開発環境から GEBCO / Natural Earth 公式サイトに接続できなかったため、
**AWS Open Data の Terrain Tiles**（陸: SRTM/GMTED など、海: ETOPO1）から生成しています。
Natural Earth は公式 GitHub ミラー（nvkelso/natural-earth-vector）の GeoJSON を使用しています。

## データ・素材のクレジット

- Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com
- Terrain Tiles — Mapzen / AWS Open Data（SRTM, GMTED2010, ETOPO1 ほか）
- GEBCO Compilation Group, GEBCO Grid（`--gebco` 使用時）
- NASA Blue Marble（バイオーム色）
- 3D モデル: Kenney Car Kit（CC0）— Car Kit には専用のバスがないため、`van` をマイクロバスとして使用
