# Android Pi Agent

個人用のAndroidローカルPi環境。`pi-durable`を唯一のエージェントバックエンドにし、`pi-tui`の設計を参考に、タッチ・IME向けの操作画面を作ります。

**チェックポイント3：新アプリ専用のChatGPT認証・自動更新・実モデル入口を接続。ホストのmocked OAuth／ブラウザ検証まで完了し、実機ログイン・実推論は未確認です。**

前のデモAPKはGalaxyで起動・WebView・ツール・保存／再開を確認済みです。今回の実モデル版とは検証範囲を分けます。

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

- Android foreground service、private assets展開、Node起動、認証付きWebView接続。別IDのデモAPKをGalaxyで確認
- 端末のCodingToolsによるwrite/read/bash、会話保存、service停止／再開、idle owner kill後の復元を確認（fauxのscripted fixture）
- ChatGPT OAuthの開始・外部ブラウザ・取消・5分timeout・手動callback fallback。認証済みのログイン表示を隠し、操作メニューから再認証
- 新profile専用の0600認証ファイル、stable installation ID、pi-aiによる直列化したtoken refresh。旧アプリ／ホストPiの認証やambient API keyは使わない
- fauxモデルによるローカルデモ（`--demo`。実認証ファイルや外部モデルAPIを使わない）
- ストリーミング状態・思考・ツール結果の表示、生成中の入力保持
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

現在の検証では既にある参照側の依存を読み取り専用で借用しました。Android bundleはlockに沿ったproduction-onlyの配置で起動・保存・再起動をホスト検証しています。追加のパッケージ導入は行っていません。lockfileは既存のlockメタデータから必要な依存を抽出し、`npm ls --package-lock-only --all`で整合性を確認しています。クリーンな`npm ci`による再検証は未実施です。

## ChatGPT認証／実モデル入口

```sh
npm start
```

`.android-pi/open.html`をprivateに開き、「ChatGPTログイン」→「ログインを開始」→「外部ブラウザで続ける」。認証後にPiへ戻り、モデルを選びます。`openai/gpt-6.1-sol`は新規profileの初期モデルです。catalogの全モデルがアカウントで使えるとは保証しません。

認証は`pi-ai`の既存OpenAI OAuth／Models、実行は同じdurable Harnessです。認証前のモデル入力・compactionは拒否し、未送信draftを維持します。access／refresh token、callback URLは会話やAppViewへ入れません。OAuth URLと入力待ちは認証専用APIでだけ扱います。

`.android-pi/auth.json`と`installation.json`はprivateです。共有・commitしないでください。認証失敗／取消で既存認証を消しません。保存済み認証があることと、期限切れtokenの更新や実推論が成功することは別です。logout UI、他provider、API-key入力はまだ未対応です。

同じprofileを複数のデスクトッププロセスで同時に開かないでください。Androidはserviceのflockを使いますが、デスクトップのprocess lockは未実装です。

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

前のデモAPKは端末へインストール済みです。今回の実モデル版はADB未接続のためまだ更新していません。旧アプリ・会話・認証は移行／変更していません。実ログイン／推論、実IMEの日本語変換や実ツール途中のkillは未検証です。
