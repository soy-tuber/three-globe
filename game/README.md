# Globe Rush — 世界輸送ラッシュ

Worldwide Rush 風の輸送経営ゲーム。
**Vite + TypeScript + three.js + three-globe** で、起伏のある地球儀の上にバス・鉄道・航空・船の路線網をつくります。

- Natural Earth の陸地・湖・河川・氷河・市街地・道路・国境をラスタライズした地表テクスチャ
- 標高データで変位させた地形（陸は DEM で隆起、海面は平らで海底地形は色で表現）。日本・ヨーロッパ・北米は高解像度
- 都市: 日本の主要 50 都市＋世界の主要 335 都市（Natural Earth、日本語名）。ズーム段階と重なり回避つきのラベル
- **路線作成**: 交通手段を選び、地図上の都市を順にクリック。経路・所要時間・需要・輸送力・予想収支を見てから開設
- **4 つの交通手段**
  - バス: Natural Earth 道路網を A* 探索（東京–大阪は東名・名神経由 約 555 km）
  - 鉄道: Natural Earth 鉄道網を A* 探索（複数両の列車が線路に沿って走行）
  - 航空: 大円航路。機体は航続距離つき、離着陸の高度プロファイルに沿って弧を描いて飛行
  - 船: 全球の航行可能グリッド（0.1°）を A* 探索し、見通し線で平滑化した航路
- **需要と収益**: 重力モデルの市場規模 × 一般化費用（運賃＋時間価値×（乗車・アクセス・待ち時間））のロジット選択。自社路線どうしも競合。運賃・燃料・通行料・線路使用料・着陸料・人件費・固定費
- **目標とチュートリアル**: 12 段階の目標（報酬つき）と初回チュートリアル
- **バランス調整ツール**: `npm run balance` で代表路線をヘッドレスに回し、需要・輸送力・乗車率・日次損益・投資回収日数を一覧

## 起動

```bash
cd game
npm install
npm run dev        # http://localhost:5173
npm test           # シミュレーション・経路探索・アセットパイプライン・バランスのテスト
npm run balance    # バランス表（npm run balance -- --days 30）
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
| `F` | 選択中の車両を追従 |
| `H` / `G` | 日本 / 地球全体を表示 |
| `N` | 実時間の昼夜表示（夜側に都市の灯り） |
| `Esc` | 路線作成を取り消し |

右パネル: 路線一覧、選択した路線の詳細（需要・輸送力・待ち客・車両）、運賃倍率（×0.6–1.6）、車両の追加購入、路線の廃止（車両は半額で売却）。
左パネル: 目標。`?` ボタンでチュートリアルを再表示。

### 車両

| 手段 | モデル | 定員 | 速度 | 価格 |
|---|---|---|---|---|
| バス | マイクロバス（Kenney van） / 大型高速バス | 28 / 50 | 90 / 100 km/h | ¥1,400万 / ¥3,800万 |
| 鉄道 | 気動車2両 / 特急電車6両 | 120 / 380 | 110 / 130 km/h | ¥1.1億 / ¥3.2億 |
| 航空 | ターボプロップ / ナローボディ / ワイドボディ | 70 / 180 / 300 | 510–900 km/h（航続 1,600–13,500 km） | ¥2.3億 / ¥6.8億 / ¥16億 |
| 船 | フェリー | 400 | 40 km/h | ¥1.3億 |

鉄道・航空機・船・大型バスは Kenney に該当モデルがないため、同じ寸法規約の手続き的ローポリモデルで描画しています。

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
│  ├─ modes.ts                交通手段ごとの速度・アクセス時間・参照運賃・航空高度プロファイル
│  ├─ graph.ts                道路・鉄道グラフ（辺の途中へのスナップ、A*、経由地）
│  ├─ sea.ts                  航路探索（全球グリッド A* + 平滑化）、大円航空路
│  ├─ networks.ts             地域別ネットワークの遅延読み込みと経路計画（日本語のエラー理由）
│  ├─ demand.ts               重力モデル・一般化費用・ロジット選択
│  ├─ economy.ts              資金・日次帳簿
│  ├─ route.ts / vehicle.ts   路線・待ち行列・車両の状態機械
│  ├─ simulation.ts           固定タイムステップ（0.25 分）の更新、路線の開設/廃止、予想収支、イベント
│  ├─ goals.ts                目標
│  ├─ balance.ts              バランス調整用シナリオ
│  └─ clock.ts, model.ts, rng.ts
├─ src/render/                描画（sim の状態を読むだけ）
│  ├─ terrain*.ts             地形シェーダ（変位・DEM 由来の法線・海のハイライト・夜景・大気）
│  ├─ cameraRig.ts            地図アプリ風カメラ（自動チルト・fly-to・追従）
│  ├─ cityLayer.ts            都市マーカー（three-globe objects）＋ HTML ラベル
│  ├─ routeLayer.ts           路線（three-globe paths。陸は地形に沿わせ、航空は高度の弧）
│  ├─ models.ts               手続き的ローポリモデル（列車・航空機・船・大型バス）
│  └─ vehicleLayer.ts         車両の配置・向き・車輪/プロペラ・航跡・複数両の列車
├─ src/ui/                    HUD・路線パネル・路線作成・目標・チュートリアル
├─ scripts/balance.ts         バランス表
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
- **道路・鉄道グラフ**: Natural Earth 10m roads / railroads から日本・東アジア、ヨーロッパ、北米を抽出し、頂点をスナップしてグラフ化（短い途切れは自動で接続）。
  次数 2 の頂点の連なりは形状つきの 1 辺に縮約し、Douglas–Peucker（約 300 m）で簡略化しています（28 MB → 5 MB）。
- **航路グリッド**: Natural Earth ocean を 0.05° でラスタライズし、0.1° へ OR 縮小（明石海峡などの狭い海峡を残すため）。
- **世界の都市**: Natural Earth populated places から人口 150 万以上と首都（40 万以上）を選び、70 km 以内の重複（郊外）を除外。

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
- 3D モデル: Kenney Car Kit（CC0）— Car Kit には専用のバスがないため、`van` をマイクロバスとして使用。その他の車両は手続き的モデル
