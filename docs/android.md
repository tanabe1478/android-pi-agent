# Androidホスト（チェックポイント2）

**ARM64のデモAPKをビルドした段階。実機インストール・Android WebView／IME・端末のNode/bashはまだ未検証。実モデル認証は次の区切りです。**

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

Nodeはappプロセスの消失を監視して終了を要求します。service終了ではSIGTERMを送り、5秒を越えた場合はそのchildだけを強制終了します。型／hostテストで親消失とgraceful shutdownを確認しましたが、Androidのkill・電源断・実ツール途中の復旧まで確認したわけではありません。

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
- Android：JavaコンパイルとAPK組立は成功。インストール、展開、flock、Node/bash、WebView・実IMEはこれから
- real provider：未認証・未検証。fauxは事前登録した返答であり、端末内の小型LLMではない

実機確認では、旧アプリのデータを触らず、新アプリの起動・日本語入力・会話保存・停止／再開・ツールの実行経路を個別に確認します。
