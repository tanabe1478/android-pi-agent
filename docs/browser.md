# 分離プレビューと画像read（チェックポイント6）

現在のGalaxyは`0.7.4-tools`。実モデルがphone branchのReaditを分離Previewで起動し、公開fixtureの表示、drawer操作、PNG撮影と標準readによる画像入力まで実行しました。

旧software bitmap描画ではCanvasが空白になり、同じ文字のPNGコピーは写る形で欠落を再現しました。現在はWebViewだけを専用offscreen hardware Surfaceへ描画します。実機のCanvas／PNGの両方と背景pixelの一致を確認し、実モデルもprompt／DOM text／sourceにないCanvas上の5文字を標準readの画像だけから正しく回答しました。これは2D Canvasの実機検証であり、WebGL／video／任意GPU layerや長時間の安定性を保証しません。

## 標準CLIから使う

AndroidのCodingToolsのbashから、ローカルproject serverを起動して使います。

```sh
pi-browser open http://127.0.0.1:7420/
pi-browser status
pi-browser snapshot
pi-browser screenshot public-preview.png
pi-browser run verify.mjs
```

`verify.mjs`の例：

```js
export default async ({ page }) => {
  await page.getByRole('button', { name: 'Test button' }).click();
  if (await page.getByRole('button').textContent() !== 'Clicked') {
    throw new Error('The fixture button did not change.');
  }
}
```

runはtrusted scriptです。任意のNode／Playwrightコードを実行でき、sandboxではありません。秘密のDOM、input values、cookies、storage、private screenshotsを承認なく収集しないでください。stdoutもモデルへ返るため、script自身の出力内容に注意します。

openは一度だけrequestを発行します。PiまたはPreviewを前面にしてnativeが消費する必要があり、60秒を超えたrequest・別runtimeのrequestは破棄します。pending requestを上書きせず、通信失敗でopen／runを自動再送しません。statusは読み直しです。availableはforegroundのWebViewが存在する表示で、HTTP／pageの成功を保証しません。

## nativeとCDPの境界

- MainActivityと異なる`:preview`プロセス、exported=falseのPreviewActivity
- previewプロセスの最初のWebView初期化より前にsetDataDirectorySuffix("preview")。Pi／認証とWebView storageを分ける
- HTTP loopbackの明示portだけ。Pi bridge port、OAuth 1455、userinfo、remote／file／content／intent navigationを拒否。通常のWeb resource requestsもlocal project portへ限定し、CDN assetsなどは未対応
- privileged JS bridge・新しいAndroid permissions・常時点灯は追加しない
- privateなrequest／stateにmain owner PIDとNode runtime PIDを結び、プロセス生存確認後にpreviewだけのabstract CDP socketへ接続。Main WebViewのsocketをproxyしない
- HTTP／WebSocket upgradeとも既存のx-pi-token、exact Host／Origin検査を使用。query tokenや任意CDP pathは拒否
- CDP discoveryは1 MiB、接続は4、WebSocket payload／pending／write bufferは16 MiBを上限にし、shutdownで接続・requestを閉じる
- discoveryのdebugger URLを書き換え、直接DevTools frontend linkを渡さない。接続tokenをupstreamへ転送しない
- Debug APKのみCDPを有効化。Android 9より前ではpreviewを開かない。release／他端末は未検証
- Playwrightは既存1.63.0をproductionへ移し、CDP接続だけに使う。browser install／launch／downloadやplatform spoofingはしない。wsも既存lockの8.22.0を直接依存へ指定

これは別UID／trusted toolsからの安全な隔離ではありません。CDP scriptや同じUIDのコードは信頼対象です。分離はPi／認証のtargets・WebView storageへ誤接続しないための境界です。

## Androidのnative画像化

AndroidのscreenshotはCDP接続の前に、認証付きPOST `/api/browser/screenshot`へ空のJSON objectを送ります。Native側はpostVisualStateCallback後に、前面Preview WebViewだけを専用ImageReader Surfaceのhardware Canvasへ描画します。RGBAのrow strideを確認し、paddingを除いてbitmap／boundedなPNGへ変換します。Pi／toolbar／keyboard／Window／他アプリは撮影しません。

- requestはowner PID／runtime PID／preview PID／URL／nonceへ結び、10秒の期限を持つ
- nonceごとのprivate publication leaseとPNG／resultを使う。pendingや別requestを上書きしない
- bitmapは4,000,000 pixelsまで、PNGは8 MiBまで。出力は0600、no-follow／size／signature検査
- 正常な終了／失敗では自分のnonce出力だけを片付ける。timeout時に撮影を再送しない
- pause／destroyでpending captureを取消。callbackの前後でforeground／URL／lease／期限を再確認
- native resultのrenderer識別も検証し、旧software画像をhardware画像として受け入れない
- Android native dimensionsはphysical pixels。整数CSS viewportとの丸め差があり得る
- desktopは引き続きPlaywrightのviewport PNG。Androidと別の検証として扱う

WindowのPixelCopy／screen captureをfallbackに使いません。描画失敗はerrorにし、空画像や旧software画像で成功を代替しません。すべてのGPU layerの網羅は未確認です。

## 画像read

既存CodingToolsのreadをdurable wrapToolでdecorateします。別tool／Harness／model loopは追加しません。

- PNG／JPEG／WebP拡張子とmagic signatureを確認し、image content（mimeType／base64）を返す
- 同じExecutionEnvでpathを解決し、symlink targetのregular file／sizeを確認。8 MiB超をread前と後に拒否
- textやsignature不一致は既存readへ戻し、offset／limit・pathの表記規則を維持
- portable statとreadはatomicではないので、同時にfileが増えた際のallocation自体を8 MiBに制限する仕組みではない
- durable image tool resultを表示するDOMはboundedなraster data URLのみ。remote／SVG／HTMLを挿入せず、展開内の画像を画面幅へ収める
- picker／image attachmentの送信、全モデルのvision互換、巨大履歴のpagingは未対応

## 検証範囲

Host：URL／request検証、single publication、0600、pending／symlink保護、owner／runtime／main target／dead PID拒否、HTTPとWebSocketのHost／Origin／header／query guards、discovery bounds、閉じる際のWS切断、launcher error redactionを確認。

Desktop Chrome：privateなfixture profileだけで、CLIのsnapshot／run／screenshot、button click、viewport保持、input value／hidden DOM非取得を確認。throwしたscript／CDPのraw errorはCLIが表示しない。画像readは実ExecutionEnv、oversize／symlink／directory／cancellationとfaux HarnessのSQLite保持、UIのunsafe image拒否／幅も確認。

Galaxy：0.7.4-toolsへの更新時にidle／空draft／dialog・settingsなし／package lockなしを確認し、graceful stopとadb install -rを実施。7会話・98エントリ、確定entry digest、選択・model／thinking、ChatGPT／GitHub接続、Node／bash／git／xz／gh digest、CLI registryを保持しました。これは更新直前のbaselineであり、その後のtask入力・画像結果は意図的な新規履歴です。

実モデルが標準CLIでReaditを起動・操作し、hardware PNGをreadへ渡して未知Canvas文字を照合できました。実finger gesture、cookie store分離の完全probe、draft保持を含む総合preview probe、release、WebGL／video、長時間background／途中killは別途検証します。[Readit taskでの区別](readit-task.md)。

Readitの公開fixtureでは、host ADBが実soft keyboardのフリック・候補選択・削除・改行・
Saveを操作し、保存前disk保持と正確な日本語bytesを確認しました。実機Piも保存後の
Native PNGを一度readで確認しました。今回だけ明示許可されたhostのkeyboard画像は
標準pi-browserの機能ではなく、Native screenshotは引き続きWebViewだけを撮影します。
