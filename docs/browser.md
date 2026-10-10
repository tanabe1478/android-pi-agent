# 分離プレビューと画像read（チェックポイント6）

`0.6.0-preview`をGalaxyへデータ保持で更新済み。66 Node／browser／bundle＋6 Python＝72 testsとoffline APK buildが成功しました。**端末のプレビュー操作・画像readは画面ロック中のため未検証**です。デスクトップChromeでの成功と区別します。

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

Galaxy：idle／空draft／package lockなしを確認後、graceful stopとadb install -rで更新。6会話・19エントリ、確定entry digest、選択・model／thinking、ChatGPT／GitHub接続を保持。Node／bash／git／xz／gh digestとCLI registryも一致、private file modesは維持。更新後のUI CDP attachmentは画面ロック中にtimeoutしたため、再更新や入力再送をせずAPI／read-only SQLiteで保持を確認しました。

残る実機確認：前面の公開fixtureだけでNative request消費、target／cookie store分離、draft保持、CLI click／snapshot／screenshot、readの画像結果と戻る操作を確認する。実モデルによる自律browser選択・vision推論、release、長時間background／途中killは別の検証です。
