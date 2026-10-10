# Android Pi Agent

個人用のAndroidローカルPi環境。`pi-durable`を唯一のエージェントバックエンドにし、`pi-tui`の設計を参考に、タッチ・IME向けの操作画面を作ります。

**Galaxyは`0.7.4-tools`へデータ保持で更新済み。小さいscrolling headerと最小composer、別settings、標準npm／npx、前面Preview WebViewだけのhardware画像化を実装しています。実機PiがReaditを編集・起動し、取得画像だけから未知Canvas文字を正しく読み取れました。**

既存のChatGPT認証／実推論／write-read-bash、実GitHub認証／gh追加／private git HTTPSは維持しています。[Readitを使った改善と検証](docs/readit-task.md)では、phoneのcodingとhost build／E2E、画像readと実IME操作を区別します。期限切れcredentialの実refresh、WebGL／video、復旧保証、Pi全機能互換は未達です。

```text
Android向けUI（ブラウザとGalaxy WebViewで最小操作を検証）
    ↕ AppView / Action
認証付きloopback HTTP・SSE
    ↕ AppController
pi-durable Harness + CodingTools
    ↕
SQLite / 明示的な作業ディレクトリ
```

別のPi CLIを起動して不足機能を補う構成ではありません。UIは会話状態を作り直さず、durableの`Conversation.viewState()`を表示します。

## この区切りでできること

- Android foreground service、private assets展開、Node起動、認証付きWebView接続。別IDの`0.7.4-tools` APKをGalaxyへデータ保持で更新
- 端末のCodingToolsによるwrite/read/bash、会話保存、service停止／再開、idle owner kill後の復元を確認（fauxのscripted fixture）
- ChatGPT OAuthの開始・外部ブラウザ・取消・5分timeout・手動callback fallback。認証済みのログイン表示を隠し、操作メニューから再認証
- 実機でChromeへの遷移とユーザーのChatGPTログイン、実モデルの短い応答、回答中の日本語＋emoji draft／focus保持を確認
- 実モデルが既存CodingToolsを`write → read → bash`の順に選択し、専用fixture directoryで成功。service再起動後の認証利用も確認
- 新profile専用の0600認証ファイル、stable installation ID、pi-aiによる直列化したtoken refresh。旧アプリ／ホストPiの認証やambient API keyは使わない
- `/github`／操作メニューからPATを専用masked欄へ入力。GitHubで検証して保存し、失敗時は既存PATを保持。解除は確認付き。PATを会話やAppViewへ出さない。Galaxyで新profileへの実保存と認証管理UIを確認
- CodingToolsのshell環境に標準gitのHTTPS askpass、private `gh`／`pi-pkg` launcherを接続。usrの既存binaryを移動・上書きせず、必要なCLIだけ追加。Galaxyでgh 2.102.0の追加、20 repositoriesの一覧（うち4 private）、private git ls-remoteを確認
- managed npm／npxは既存Node entryを起動し、baselineを書き換えず固定shebang問題に対応。実機Piで両CLIの利用を確認
- 分離したlocal project previewと`pi-browser open/status/snapshot/screenshot/run`。CDP attachmentとnative hardware PNGを使い、別Pi CLIやdesktop browserを起動しない。実機で公開Readitを操作
- 既存readのPNG／JPEG／WebP画像対応（8 MiBまで）とsafeな画像tool表示。実機Piが画像だけの未知Canvas文字を照合。[境界と検証](docs/browser.md)
- fauxモデルによるローカルデモ（`--demo`。実認証ファイルや外部モデルAPIを使わない）
- Pi型のフラットなMarkdown本文、思考、paired toolsと展開保持。履歴内の16px `pi android client`とtappable model／thinking、下部cwd／session／累積usage／settings
- composerは入力欄（`...`）とSendだけ。Enterは改行、Send／Ctrl+EnterはSteer、Alt+EnterはFollow-up。`/`で候補、`/abort`・Escapeで停止。その他は別settings。[UI方針](docs/ui.md)
- 送信、steering／follow-up、入力キュー取消、停止
- モデル・思考レベル変更、会話作成・切替・命名・過去のユーザー入力からのfork
- SQLite再オープンによる会話・設定・選択の復元
- 文脈要約要求と状態表示、確認付きの文脈リセット（履歴は削除しない）
- 共通コマンド一覧によるスラッシュ補完・dispatch。未知のコマンドや未対応の`!`はモデルへ送らない
- 既存durable CodingToolsの実行。テストでは一時workspaceのファイルを書いて読み返す

**端末Piとの全機能互換ではありません。** 未対応・意味の違う機能は[機能表](docs/capabilities.md)で管理します。

## 読む順番

[中身の読み方](docs/walkthrough.md)に、実際の送信の流れとファイルの役割をまとめています。

1. `runtime/contracts.ts` — 表示する値と、依頼できる操作
2. `runtime/kernel.ts` — durableが所有する会話・設定・入力・永続化
3. `runtime/bridge.ts` — UIとの通信。認証と入力検証
4. `ui/components.js` — 表示部品・ダイアログ・ライフサイクル
5. `ui/app.js` — 部品を組み立て、ユーザー操作を共通APIへ接続

詳しい方針は[設計](docs/architecture.md)。

## ローカルデモ

Node >=22.19.0。通常の依存導入はプロジェクトの継続承認内です：

```sh
npm ci --ignore-scripts
npm run dev
```

表示された `.demo/open.html` をブラウザで開きます。Macなら別端末で `open .demo/open.html`。起動リンクにはloopback接続用トークンが入るため、公開・共有しないでください。トークン値はログやコマンド引数に出しません。UIはフラグメントを取り除き、接続用トークンだけをタブのsessionStorageに保持します。

`.demo/session.sqlite`にデモ会話が保存されます。実際のAPI認証・GitHub PATは読みません。同じプロフィールを複数プロセスから同時に開く使い方は、この区切りでは未対応です。

現在の検証では既にある参照側の依存を読み取り専用で借用しました。Android bundleはlockに沿ったproduction-onlyの配置で起動・保存・再起動をホスト検証しています。hostのNode依存・native baselineは追加導入していません。端末では今回、pi-pkgでghを追加しました。lockfileは既存のlockメタデータから必要な依存を抽出し、`npm ls --package-lock-only --all`で整合性を確認しています。クリーンな`npm ci`による再検証は未実施です。

## ChatGPT認証／実モデル入口

```sh
npm start
```

`.android-pi/open.html`をprivateに開き、「ChatGPTログイン」→「ログインを開始」→「外部ブラウザで続ける」。認証後にPiへ戻り、モデルを選びます。`openai/gpt-6.1-sol`は新規profileの初期モデルです。catalogの全モデルがアカウントで使えるとは保証しません。

認証は`pi-ai`の既存OpenAI OAuth／Models、実行は同じdurable Harnessです。認証前のモデル入力・compactionは拒否し、未送信draftを維持します。access／refresh token、callback URLは会話やAppViewへ入れません。OAuth URLと入力待ちは認証専用APIでだけ扱います。

`.android-pi/auth.json`と`installation.json`はprivateです。共有・commitしないでください。認証失敗／取消で既存認証を消しません。保存済み認証があることと、期限切れtokenの更新や実推論が成功することは別です。logout UI、他provider、API-key入力はまだ未対応です。

同じprofileを複数のデスクトッププロセスで同時に開かないでください。Androidはserviceのflockを使いますが、デスクトップのprocess lockは未実装です。

## GitHub・必要なCLIの追加

`/github`または操作メニューのGitHub認証を開き、必要なrepositoryだけを許可したPATを専用欄で保存します。旧アプリやホストPiからは読み込まず、GitHub認証はChatGPT認証と独立しています。PATを会話、コマンド、URLへ貼らないでください。

AndroidのCodingToolsから、必要時に以下の標準CLIを使います：

```sh
pi-pkg list
pi-pkg plan gh
pi-pkg install gh --yes
gh repo list --limit 20
```

`git`は同じPATをHTTPS認証に使います。`gh`は追加後に新profileのラッパーを経由します。`pi-pkg`はbaseline／既存filesを置換しない追加専用で、apt互換ではありません。Galaxyで実保存・通信・CLI追加を確認済みです。Termuxの固定pathにはGIT_EXEC_PATH／GIT_SSL_CAINFOを新prefixへ設定して対応しました。[認証・CLIの境界と検証](docs/cli.md)を参照してください。

## local Web preview

Androidのbashからproject serverを起動し、`pi-browser open http://127.0.0.1:7420/`を一度実行します。Pi／Previewを前面にし、`status`、`snapshot`、`screenshot FILE.png`、`run SCRIPT.mjs`で検証します。Pi bridgeやOAuth portには接続しません。公開fixtureだけを撮影し、画像はreadへ渡せます。[使い方と未検証範囲](docs/browser.md)。

## 検証

```sh
npm run check
npm test
PI_TEST_CHROME='/path/to/Chrome' npm test
```

Chrome指定時は360×780のデスクトップブラウザでもUIを検証します。**実際のAndroid WebView・ソフトキーボード・端末実行の検証ではありません。** 未指定時はそのテストをskipします。

## Androidの前提

- Galaxy SM-S931Z / ARM64を優先。`targetSdk 28`とTermux系のアプリ専用領域からの実行方式を維持
- 一般配布・Play対応は要件にしない
- 参照の`org.pimobile.app`とは別のアプリID・保存領域を使う。会話・認証の自動移行はしない
- 通常のpackage setup・build/test・新アプリのデータ保持更新・このoriginへのpushは継続承認内。private dataの削除、旧アプリやAndroid設定の変更、upstreamへのpushは含めない

新application IDは`io.github.tanabe1478.androidpi`、今回の表示名は`Android Pi`です。[Androidホスト・ビルド・保存領域・未検証範囲](docs/android.md)を参照してください。

`0.7.4-tools`更新時は7会話・98確定エントリのdigest、選択／設定、ChatGPT／GitHub認証、追加gh／CLI registryとcore hashesを保持しました。その後のReadit taskは同じdurable会話へ新しい履歴を追加しています。旧`org.pimobile.app`は明示依頼でuser 0から削除しましたが、旧データ／認証の移行はせず、Macの参照リポジトリを保持しています。Readitではhost ADBによる実soft keyboardのIME変換・削除・改行・保存も確認しました。Pi composerのIME変換、実指操作、実ツール途中のkill、長時間backgroundなどは未検証です。
