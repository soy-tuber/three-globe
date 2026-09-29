# 交通系ICカードと自動改札機の3D解説

`index.html` 1ファイルだけで動く、インタラクティブな3D解説ページです。ゲーム本体（`game/`）とは独立しています。

- three.js 0.183.2 は jsDelivr から importmap で読み込みます。フォントは Google Fonts のみです。その他の外部通信はありません。
- 3Dモデルと画像はすべてコードで生成しています（ジオメトリと CanvasTexture）。
- 磁場はループコイルの厳密解（楕円積分）で求め、磁力線は RK4 で追跡しています。カード電圧はコイル面の 7×7 点の磁束から求めます。

## 開き方

モジュールを使うので、ローカルサーバーから開いてください。

```sh
cd ic-card && python3 -m http.server 8000
# http://localhost:8000/        通常の操作
# http://localhost:8000/?demo=1 30秒の自動再生（録画用）
```

## フック

`window.__lab` から操作できます。

| 名前 | 内容 |
| --- | --- |
| `ready` | 準備ができたかどうか |
| `setDistance(cm)` | カードとリーダー面の距離を設定する |
| `getState()` | 現在の状態を返す（同期） |
| `tap()` | タッチ操作 |
| `setExploded(on)` | 分解表示の切り替え |
| `setCamera(name, instant)` | カメラの切り替え（`overview` / `reader` / `card` / `inside`） |
| `setSpeed('slow'｜'real')` | スロー表示と実時間の切り替え |
| `renderDemoFrame(t)` | デモの時刻 `t` 秒のフレームを同期的に、決定的に描画する |
