# Androidホスト（チェックポイント2）

**Galaxy SM-S931ZでデモAPKの起動・WebView・Node/bash・durableのツール・保存／再開を確認済み。実モデル認証は次の区切りです。日本語IMEの手入力・変換操作まで完了したとは扱いません。**

## アプリと保存領域

- 新しいapplication ID：`io.github.tanabe1478.androidpi`
- 表示名：`Android Pi Demo`
- `compileSdk 35` / `minSdk 26` / **`targetSdk 28`**
- debug APK。通常のAndroid debug署名を利用し、鍵はリポジトリへ入れない
- 旧`org.pimobile.app`を更新・終了・初期化しない。会話／認証の自動移行もしない

アプリの`files/`以下：

```text
usr/                    Termux ARM64の既存ネイティブ実行環境
app/                    このプロジェクトのruntime / ui / shared / production依存
work/                   CodingToolsの作業ディレクトリ
home/                   HOME（旧アプリとは別）
home/.android-pi/
  session.sqlite        durableの会話・catalog
  runtime.lock          Androidプロセスのflock。ファイルは削除せず再利用
  bridge.json           pid・port・接続token。0600、準備完了後に原子的に公開
  status.json           ネイティブの起動段階。会話／モデル実行状態の正本ではない
  open.html             private launcher。共有しない
tmp/                    TMPDIR
log/                    private起動ログ。外部へそのまま共有しない
```

会話の保存は引き続き一つのdurable SQLite。Android側に別の会話や実行queueは作りません。

## 起動と終了

1. `MainActivity`が`RuntimeService`を起動
2. serviceが署名APK内のbundle manifestとSHA-256を確認し、private stagingへ展開
3. 一つのservice内では起動workerを重複させない
4. `flock -n -F`の排他ロックを保持してNodeへexec。一つのプロフィールに同時に二つのHarnessを開かない
5. Nodeが今回の`runtime/main.ts --demo`を起動し、loopback bridgeの準備後に`bridge.json`を公開
6. Activityがこのappプロセスに対応したpid／portを読み、tokenをfragmentでUIへ渡す。UIはfragmentを取り除き、APIへheaderで送信

JSのprivileged native interfaceは追加していません。WebViewはfile/content accessを禁止し、このbridgeのexact origin以外へはnavigateしません。HTTPを許可するnetwork security configもloopbackだけです。実認証用のシステムブラウザ遷移は未接続です。

Nodeはappプロセスの消失を監視して終了を要求します。service終了では、準備済みでこのappが所有するchildへ`Os.kill(..., SIGTERM)`を送り、5秒を越えた場合はそのchildだけを強制終了します。プラットフォームによって即時終了になり得る`Process.destroy()`だけに依存しません。

実機でservice停止後のNode終了・ready record削除・flock解除と、再開時の会話復元を確認しました。idleのAndroid ownerをkillした試験でも、旧Node終了と`START_STICKY`による再起動、会話復元を確認しました。ただし、owner消失時にAndroidがchildを一緒に終了する場合もあるため、その試験だけでparent watcher経路を証明したとは扱いません。実ツール途中のkill・電源断は未検証です。

wake lockは期限付きで更新し、worker終了／service終了で解除します。通知からランタイムを終了できます。Androidの通知許可を拒否した場合は、システムの「実行中のアプリ」などから終了できます。画面を閉じるだけではserviceを止めません。

## 更新時に守るもの

- `home/`・SQLite・`work/`・認証を上書きしない
- ネイティブ`usr/`は初回だけ展開。既存prefixや追加CLIを丸ごと置換しない
- 既存prefixのreceiptがない／baselineが変わった場合は自動上書きせず、明示的な確認・移行が必要
- `app/`はstagingから差し替え、公開失敗時に旧コードを戻す。失敗したrollbackは回復用stagingを残す
- APK更新前に実行中の仕事を確認し、承認後に`adb install -r`を使う

これは承認・検証・rollbackを伴う完成した自己更新機能ではありません。別portでbridgeを再起動したときの画面reloadでは未送信ドラフトが失われ得ます。確定会話はSQLiteから復元します。

## ローカルのビルド

依存インストールは承認後だけ。今回のビルドは既存の参照依存・ネイティブarchive・Gradle／SDKキャッシュを読み取り専用で使い、ダウンロードやnpm scripts実行を行っていません。

```sh
python3 scripts/package-android.py --rootfs /path/to/trusted/rootfs.bin

cd android
JAVA_HOME=/path/to/jdk21 ANDROID_HOME=/path/to/android-sdk \
  ./gradlew --offline --no-daemon assembleDebug
```

出力：`android/app/build/outputs/apk/debug/app-debug.apk`。
assets・APK・データ・署名鍵はgit対象外です。Gradle wrapperは参照実装から再利用しています（Apache-2.0）。

packagerは独自lockのproduction依存closureだけを選び、各versionを確認します。借用treeで同じversionがhoistされている場合も、lockの位置に配置します。`pi-coding-agent`、dev依存、credentials、ホスト向けネイティブ実行ファイルは入れません。native archiveのmacOSメタデータも除去します。

借用treeにはoptionalな`@esbuild/android-arm64`がありません。今回のデモはNodeのネイティブTS strippingを利用して起動でき、Android用esbuildを利用する動的コンパイル機能は未対応です。optional不足はbundle manifestへ明記し、勝手に取得しません。クリーンな`npm ci`はまだ未検証です。

## 検証の区別

```sh
npm run check
PI_TEST_CHROME=/path/to/Chrome \
PI_TEST_ANDROID_BUNDLE=android/app/src/main/assets/runtime.bin npm test
python3 -m unittest discover -s scripts -p 'test_*.py' -v
```

- host：bridge公開／終了、親消失、同じdurable profileの再起動を検証
- packaged host：production-only archiveを展開し、実際にNodeを起動して送信・保存・再起動を検証
- packaging：依存closure、version、hoisting、再現性、private/dev/hostファイル除外、traversal／symlink拒否を検証
- Android：Galaxy SM-S931Z（Android 16/API 36、ARM64）へ別アプリとしてインストール。Node 26.4.0、bash、稼働中flockと停止後の解除を確認
- tools：端末のfauxにtool callを登録し、実際のCodingToolsが`write → read → bash`を指定cwdで実行。実モデルが自律的に選択した検証ではない
- WebView：360×730、DPR 3。日本語＋emoji送信、stream中のdraft／focus保持、補完、未知コマンド拒否、clear取消、保存を確認。JavaScript errorなし・水平overflowなし
- keyboard：実際のAndroid tapでsoft keyboardを開閉。viewportは730→403へ縮み、送信操作はkeyboardより上。WebViewの合成イベント中Enterガードは確認したが、実IMEによる日本語の手入力・候補変換は未検証
- lifecycle：ホーム画面から復帰してSSE更新を確認。service停止／再開、idle owner kill後の再起動でもfixture会話3 entriesと選択を維持
- real provider：未認証・未検証。fauxは事前登録した返答であり、端末内の小型LLMではない

旧アプリのデータ・認証・設定／権限は変更していません。ADB forwardsは検証後に削除し、private screenshots・SQLite・launcherをgitへ入れていません。

実機で分かった差分：

- Android toyboxの`tar --restrict`は先頭entryを許可rootとする。runtime archiveの先頭へ明示的な`app/` directoryを追加して修正し、回帰テストと端末の小規模展開試験を追加
- CDPを既存WebViewへattachした際に既存fetch streamが更新されない状態を観測。原因は未特定。検証ではattach後に、draftが空であることを確認して読み取り専用reloadを行った。その後の更新・通常のhome／復帰は通った
- keyboard表示中のCDP screenshotには重複描画が出たため、それだけで実表示を判定しない。実際のADB screenshotをkeyboard候補／clipboardが出ない状態でapp領域だけcropして確認。実keyboardのlayoutは別途数値検証

まだ未確認：real provider inference／auth、実IME変換操作、実ツール途中のhard kill・電源断、長時間background動作、デスクトップの複数process排他、クリーンインストールのnpm依存取得。
