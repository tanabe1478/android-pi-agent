# Android Pi Agent

個人用のAndroidローカルPi環境。`pi-durable`を唯一のエージェントバックエンドにし、`pi-tui`の設計を参考に、タッチ・IME向けの操作画面を作ります。

**チェックポイント1：ホストで動く共通ランタイムと最小UI。Androidアプリ・実モデル認証はまだ未実装です。**

```text
Android向けUI（現在はブラウザで検証）
    ↕ AppView / Action
認証付きloopback HTTP・SSE
    ↕ AppController
pi-durable Harness + CodingTools
    ↕
SQLite / 明示的な作業ディレクトリ
```

別のPi CLIを起動して不足機能を補う構成ではありません。UIは会話状態を作り直さず、durableの`Conversation.viewState()`を表示します。

## この区切りでできること

- fauxモデルによるローカルデモ（外部モデルAPI・ホストのPi認証は使わない）
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

Node >=22.19.0。依存導入の承認後に：

```sh
npm ci --ignore-scripts
npm run dev
```

表示された `.demo/open.html` をブラウザで開きます。Macなら別端末で `open .demo/open.html`。起動リンクにはloopback接続用トークンが入るため、公開・共有しないでください。トークン値はログやコマンド引数に出しません。UIはフラグメントを取り除き、接続用トークンだけをタブのsessionStorageに保持します。

`.demo/session.sqlite`にデモ会話が保存されます。実際のAPI認証・GitHub PATは読みません。同じプロフィールを複数プロセスから同時に開く使い方は、この区切りでは未対応です。

現在の検証では既にある参照側の依存を読み取り専用で借用しました。追加のパッケージ導入は行っていません。lockfileは既存のlockメタデータから必要な依存を抽出し、`npm ls --package-lock-only --all`で整合性を確認しています。クリーンな`npm ci`による再検証は未実施です。

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
- パッケージ導入、GitHubへの書き込み・push、APKインストール、Android設定変更には承認が必要

この区切りにはAPK・Java/Kotlinブートストラップは含みません。次にこの共通APIをAndroidのホストとつなぎます。
