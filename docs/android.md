# Androidホスト（チェックポイント6）

`0.7.4-tools`（versionCode 13）をGalaxyへデータ保持で更新済み。更新直前にidle／空draft／dialog・settingsなし／package lockなしを確認してgraceful stop／adb install -rを実施し、7会話・98エントリのdigest、選択／設定、ChatGPT／GitHub認証、追加gh／CLI registryとcore digestsを保持しました。実機Piで標準npm／npx、公開Readitの起動・Preview、hardware PNG／画像だけのCanvas文字照合まで確認しています。[分離preview／画像read](browser.md)、[Readit task](readit-task.md)を参照。

## 前のGitHub／CLI実機検証

`0.5.1-cli`（versionCode 5）のoffline APK buildが成功し、Galaxyへデータ保持で更新済み。GitHub profile認証、git／gh、pi-pkgを追加し、実PAT保存、gh 2.102.0追加、private GitHubのread-only利用を確認しました。host検証は55 Node／browser／bundle＋6 Python＝61件、failure／skipなし。host依存・native baselineは参照側から読み取り専用で利用し、端末のghだけpi-pkgで取得しました。[CLIの検証範囲](cli.md)を参照してください。

更新時にidle／空draft／package lockなしを確認し、6会話・16エントリとentry digest、選択・ChatGPT認証を保持。gh追加後の再更新でもGitHub認証・CLIを保持しました。gitのcompiled Termux pathをGIT_EXEC_PATH／GIT_SSL_CAINFOで補正し、更新後はcommand側の追加指定なしでprivate ls-remoteが成功しました。Node／bash／git／xzのdigestはCLI追加の前後で一致、private metadataは0600、package lockは正常解除。CLI検証でモデル入力は送信していません。

## 前のPi型UIの実機検証

`0.4.0-ui`をGalaxyへデータ保持で更新。新UIは[Piを基本にしたAndroid表示](ui.md)を参照してください。認証・選択・6会話・16エントリの保持と確定entry比較の一致を確認しました。新UIの基本操作、3つのtool call/resultの表示と展開、footer selectors、実keyboard表示中のlayoutも確認しました。viewportは360×730→360×403で、送信control／footerはkeyboardに隠れず、履歴領域は209pxを確保。JavaScript error・水平overflowなし。

Pi型UIの区切りでのhost検証は36 Node／browser／bundle＋5 Python＝41件、failure／skipなし。APKのoffline buildとID／SDK確認も成功しています。新UI確認ではモデルへ新しい入力は送らず、会話・選択・設定・usageを保持しています。実IMEの手入力・変換は未検証。自動消灯には検証中だけWeb Screen Wake Lockを使い、終了時に解除しました。Android設定の変更や常時点灯機能の追加はありません。以下の実認証／実推論記録は前の`0.3.0-auth`での確認です。

**Galaxy SM-S931Zへ`0.3.0-auth`をデータ保持で更新し、新アプリ専用ChatGPTログイン・`openai/gpt-6.1-sol`の実推論・実モデルによるCodingTools選択／実行を確認しました。service再起動後も認証・会話・モデル／思考を保持。実IMEの手入力・変換や実ツール途中のkillまで完了したとは扱いません。**

## アプリと保存領域

- 新しいapplication ID：`io.github.tanabe1478.androidpi`
- 表示名：`Android Pi`（前のデモから変更。application ID／dataは同じ）
- `compileSdk 35` / `minSdk 26` / **`targetSdk 28`**
- debug APK。通常のAndroid debug署名を利用し、鍵はリポジトリへ入れない
- 旧`org.pimobile.app`はユーザーの明示依頼で端末のuser 0から削除済み。新アプリのdataとMacの参照リポジトリは保持。会話／認証の自動移行はしない

アプリの`files/`以下：

```text
usr/                    Termux ARM64の既存ネイティブ実行環境
app/                    このプロジェクトのruntime / ui / shared / production依存
work/                   CodingToolsの作業ディレクトリ
home/                   HOME（旧アプリとは別）
home/.android-pi/
  session.sqlite        durableの会話・catalog
  auth.json             新アプリ専用OAuth credential。0600、会話／AppViewへ出さない
  installation.json     stable installation ID。0600、更新時も保持
  github.json           checkpoint5の新profile専用PAT。0600、会話／AppViewへ出さない
  packages.json         checkpoint5の追加CLI registry。baseline／旧アプリとは独立
  package-install.lock  追加installerの排他。中断時は自動解除せず要確認
  bin/                  managed git askpass／gh／pi-pkg／pi-browser launcher
  gh/                   ghのprivate config。別の認証保存／token表示は制限
  runtime.lock          Androidプロセスのflock。ファイルは削除せず再利用
  bridge.json           pid・port・接続token。0600、準備完了後に原子的に公開
  status.json           ネイティブの起動段階。会話／モデル実行状態の正本ではない
  preview-request.json  foreground nativeへの一度限りのowner-bound request
  preview-state.json    別processのavailability。会話の正本ではない
  open.html             private launcher。共有しない
tmp/                    TMPDIR
log/                    private起動ログ。外部へそのまま共有しない
```

会話の保存は引き続き一つのdurable SQLite。Android側に別の会話や実行queueは作りません。PreviewActivityはexported=falseの:previewプロセスに置き、初期化前のWebView data-directory suffixでstorageとCDP targetsを分離します。MainActivity／Previewの前面時だけrequestを消費し、旧runtimeのrequestは採用しません。WebView preview storageもprivateに保持します。

## 起動と終了

1. `MainActivity`が`RuntimeService`を起動
2. serviceが署名APK内のbundle manifestとSHA-256を確認し、private stagingへ展開
3. 一つのservice内では起動workerを重複させない
4. `flock -n -F`の排他ロックを保持してNodeへexec。一つのプロフィールに同時に二つのHarnessを開かない
5. Nodeが`runtime/main.ts`を起動。OpenAI OAuthを新profileへ接続し、loopback bridgeの準備後に`bridge.json`を公開。認証前にはモデル入力・compactionを拒否
6. Activityがこのappプロセスに対応したpid／portを読み、tokenをfragmentでUIへ渡す。UIはfragmentを取り除き、APIへheaderで送信

JSのprivileged native interfaceは追加していません。WebViewはfile/content accessを禁止し、ページ表示をこのbridgeのexact originへ限定します。例外は、ユーザーがタップした`https://auth.openai.com/api/accounts/authorize`へのmain-frameリンクだけで、外部のシステムブラウザへ渡します。任意remote URL、`intent:`、file、OAuth callbackをWebViewで開く機能ではありません。HTTPを許可するnetwork security configはloopbackだけです。

OAuth callbackは既存pi-aiが`127.0.0.1:1455/auth/callback`で受け、stateとPKCEを扱います。旧アプリなどのログインがそのportを使用中なら新しいログインは失敗するため、先に終了してください。ログイン状態だけをAppViewへ載せ、OAuth URL／手動入力待ちはheader認証付き`/api/auth`で扱います。5分timeout・取消・終了でcallbackを閉じます。外部ブラウザからの復帰ではviewを読み直し、composerをreload／操作再送しません。手動callbackはmasked inputで、会話へ送信せず、送信／closeで入力欄を消します。

Nodeはappプロセスの消失を監視して終了を要求します。service終了では、準備済みでこのappが所有するchildへ`Os.kill(..., SIGTERM)`を送り、5秒を越えた場合はそのchildだけを強制終了します。プラットフォームによって即時終了になり得る`Process.destroy()`だけに依存しません。

実機でservice停止後のNode終了・ready record削除・flock解除と、再開時の会話復元を確認しました。idleのAndroid ownerをkillした試験でも、旧Node終了と`START_STICKY`による再起動、会話復元を確認しました。ただし、owner消失時にAndroidがchildを一緒に終了する場合もあるため、その試験だけでparent watcher経路を証明したとは扱いません。実ツール途中のkill・電源断は未検証です。

wake lockは期限付きで更新し、worker終了／service終了で解除します。通知からランタイムを終了できます。Androidの通知許可を拒否した場合は、システムの「実行中のアプリ」などから終了できます。画面を閉じるだけではserviceを止めません。

## 更新時に守るもの

- `home/`・SQLite・`work/`・認証を上書きしない
- ネイティブ`usr/`は初回だけ展開。既存prefixや追加CLIを丸ごと置換しない
- 既存prefixのreceiptがない／baselineが変わった場合は自動上書きせず、明示的な確認・移行が必要
- `app/`はstagingから差し替え、公開失敗時に旧コードを戻す。失敗したrollbackは回復用stagingを残す
- APK更新前に実行中の仕事・draftとpackage-install.lockの有無を確認し、継続承認内で`adb install -r`を使う
- デモ会話のモデルを黙って実モデルへ変更しない。更新後に認証し、モデルを明示的に選ぶ

これは承認・検証・rollbackを伴う完成した自己更新機能ではありません。別portでbridgeを再起動したときの画面reloadでは未送信ドラフトが失われ得ます。確定会話はSQLiteから復元します。

## ローカルのビルド

通常の依存インストールは継続承認内です。今回も既存の参照依存・ネイティブarchive・Gradle／SDKキャッシュを読み取り専用で使い、依存downloadやinstall scripts実行を行っていません。

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

## 前の認証チェックポイントの検証

認証チェックポイントのhost検証は**29 Node／browser／bundleテスト＋5 Pythonテスト＝34件、failure／skipなし**。typecheckとdebug APK `0.3.0-auth`のoffline buildが成功し、APKのapplication ID／minSdk 26／targetSdk 28を確認しました。以下のAndroid／実モデル確認は、それとは別に端末上で実施しています。

```sh
npm run check
PI_TEST_CHROME=/path/to/Chrome \
PI_TEST_ANDROID_BUNDLE=android/app/src/main/assets/runtime.bin npm test
python3 -m unittest discover -s scripts -p 'test_*.py' -v
```

- host：bridge公開／終了、親消失、同じdurable profileの再起動を検証
- packaged host：production-only archiveを展開し、Nodeのfaux送信・保存・再起動とreal modeへの切替を検証。デモ会話とモデルを保持し、未認証で実モデルを呼ばない
- auth host：private保存、stable ID、直列化refresh、取消・timeout・stale prompt、credential非公開を検証。既存ChatGPT callbackを実際にlistenし、token通信はmockしてstate拒否・code交換・refresh・cancel時closeを検証（portが使用中なら既存loginを守ってskip）
- desktop auth UI：360×780で取消、masked callback、認証済みlogin非表示、menu再認証を検証。このテスト自体は実OpenAIログインやAndroid Intentの検証ではない
- packaging：依存closure、version、hoisting、再現性、private/dev/hostファイル除外、traversal／symlink拒否を検証
- Android：Galaxy SM-S931Z（Android 16/API 36、ARM64）へ別アプリとしてインストール。Node 26.4.0、bash、稼働中flockと停止後の解除を確認
- tools：端末のfauxにtool callを登録し、実際のCodingToolsが`write → read → bash`を指定cwdで実行。実モデルが自律的に選択した検証ではない
- WebView：360×730、DPR 3。日本語＋emoji送信、stream中のdraft／focus保持、補完、未知コマンド拒否、clear取消、保存を確認。JavaScript errorなし・水平overflowなし
- keyboard：実際のAndroid tapでsoft keyboardを開閉。viewportは730→403へ縮み、送信操作はkeyboardより上。WebViewの合成イベント中Enterガードは確認したが、実IMEによる日本語の手入力・候補変換は未検証
- lifecycle：ホーム画面から復帰してSSE更新を確認。service停止／再開、idle owner kill後の再起動でもfixture会話3 entriesと選択を維持
- real provider：今回の新アプリで実ChatGPTログインと`openai/gpt-6.1-sol`の実推論を確認。以下を参照。fauxは事前登録した返答であり、端末内の小型LLMではない

### 今回のreal provider実機確認

- 更新前に全durable task／queueがidleで、未送信draftが空であることを確認。serviceをgraceful stopし、`adb install -r`で更新。旧5会話・3エントリと選択を保持し、確定entryの比較も一致
- AndroidからChromeへOAuth URLを渡し、ユーザーがブラウザでChatGPTログイン。callbackの成功表示だけでなく、新ランタイムの認証完了も確認。認証ファイル／installation metadataは0600。内容は取得・公開せず、旧アプリからの移行もしない
- 別の「実モデル確認」会話（ID 37）を作成し、UIで`openai/gpt-6.1-sol`を選択。thinkingは検証用にlow。短いmarker要求を一度だけ送信し、実assistant応答をdurableへ確定。input 648／output 8 tokens、stopReasonはstop
- 実回答中の日本語＋emoji draft／focusを保持。login非表示とmenu再認証、JavaScript errorなし・水平overflowなしを確認。composer入力は自動操作で、実IME変換の検証ではない
- idle／空draftでserviceを停止・再開。認証metadata、会話entry、モデル／thinking、選択、login非表示を復元。同じAndroid owner内でNode childを再起動した確認であり、app全体のhard killや電源断ではない
- その再起動後、実モデルにfixture directoryだけを操作するよう依頼。モデル自身が`write → read → bash`を選択し、3件とも成功。書いたmarkerのread結果、bashのmarkerと指定cwd、実assistantの完了応答を確認。fauxのscripted callではない
- 作成したfixture fileと空directoryだけを片付け、会話の検証履歴は保持。旧アプリや既存workspace fileは変更しない
- 実認証の期限切れrefreshは未検証。host mockでのrefresh成功と、新規／保存済み実credentialでの推論成功を混同しない

この認証チェックポイント当時は旧アプリのデータ・認証・設定／権限を変更していません。後のcheckpoint5で、ユーザーの明示依頼により旧アプリだけをuser 0から削除しました。ADB forwardsは検証後に削除し、private screenshots・SQLite・launcherをgitへ入れていません。ログイン中はブラウザのDOM／画面／callback URLを取得しませんでした。

実機で分かった差分：

- Android toyboxの`tar --restrict`は先頭entryを許可rootとする。runtime archiveの先頭へ明示的な`app/` directoryを追加して修正し、回帰テストと端末の小規模展開試験を追加
- CDPを既存WebViewへattachした際に既存fetch streamが更新されない状態を観測。real確認でも会話作成はAPIへ確定したが画面が更新されないことがあった。原因は未特定。draftが空であることを確認して読み取り専用reloadし、既存の検証会話から再開した。会話作成や送信を再実行したのではない。その後の実回答・tools表示や通常のhome／復帰は通った
- OAuthリンクのCDP clickは外部Activityへの遷移後にnavigation待ちがtimeoutしたが、実際にはChromeへ遷移済みだった。画面遷移の失敗と決めつけず、foreground componentと認証状態を独立に確認した
- keyboard表示中のCDP screenshotには重複描画が出たため、それだけで実表示を判定しない。実際のADB screenshotをkeyboard候補／clipboardが出ない状態でapp領域だけcropして確認。実keyboardのlayoutは別途数値検証

Readitの公開fixtureでは、host ADBで実Samsung soft keyboardを操作し、IME候補変換・確定後削除・改行・menu Saveと保存bytesを確認しました。本人の指操作でもPi composerのIME検証でもありません。

まだ未確認：実credentialの期限切れrefresh、実モデルcompaction、Pi composerの実IME変換、実指操作、実ツール途中のhard kill・電源断、長時間background、デスクトップの複数process排他、クリーンなAndroid Pi依存取得。GitHub／gh追加と実機PiによるReadit／npm／Preview／画像読取を確認済みです。他package、WebGL／video、resource loader、巨大画像履歴のpagingは別の作業です。
