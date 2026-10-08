# 中身の読み方

この区切りでは、まず「実行の本体を一つにして、画面だけ交換できる」構造を確認できます。

## 1. 画面と本体の約束

`runtime/contracts.ts`を最初に読みます。

- `AppView`：会話、一覧、モデルなど、画面が表示する値
- `Action`：画面が依頼できる操作。変更する会話IDは必須
- `AppController`：snapshot取得、操作実行、更新通知、終了

画面にHarnessや実行環境を渡しません。将来Androidのnative UIに変えても、この境界を使います。

## 2. 本体が状態を持つ

`runtime/kernel.ts`の`openKernel()`を読みます。

SQLiteを開く → durable Harnessを開く → CodingToolsを登録する → 会話を開く、という順です。

`Catalog`は会話一覧・名前・選択を同じSQLiteに保存する文書です。モデル・思考・実行中状態・入力キューはdurableの組込み文書です。画面側で同じ状態を独自管理しません。

## 3. 送信ボタンを押したとき

```text
ui/app.js: submit()
  現在のconversationIdと入力を捕捉
    → ui/client.js: action()
    → runtime/bridge.ts: POST /api/action
       認証とJSON検証
    → runtime/kernel.ts: execute() → perform()
       slashなら操作、通常文ならConversation.submit()
    → durableがモデル／ツールを実行してcommit
```

モデルの応答終了までHTTP操作を待つのではなく、入力の受理で返します。停止は通常の入場queueを待たずに実行できます。

## 4. 新しい出力が画面へ戻るとき

```text
durable commit
  → kernelの更新通知（このcallbackでは描画しない）
  → bridgeが最新snapshotを読む
  → SSE
  → Client.watch()
  → ui/app.js: render()
  → Transcript.render()
```

UIは独自のtokenイベント列から会話を再構成しません。接続し直しても最新snapshotを読み、操作を再送しません。

## 5. pi-tuiの設計をどう取り入れたか

`ui/components.js`は「表示部品・入力・ライフサイクル」を分けています。

- `Transcript`：メッセージをキーで管理し、履歴とライブ出力を更新
- `Dialog`：選択、確認、文字入力と、閉じたときの後始末
- composerのtextarea：更新のたびに作り直さず、フォーカス・IME・ドラフトを保つ

ANSI描画をスマホへ持ち込むのではなく、ブラウザの標準入力欄・dialogを使います。メッセージ内のHTMLは実行しません。

## 6. リセットが安全な理由

画面の「はい」というboolだけでリセットしません。kernelが短命の確認ticketを発行し、会話IDとその時点の文脈へ結びつけます。会話が変わったら再確認、一度使ったticketは無効。busy時も拒否します。

リセットで古いSQLiteエントリやファイルを削除しません。

## 7. テストで確認する

- `test/kernel.test.mjs`：durable・tools・再オープン・fork・キュー・確認
- `test/protocol.test.mjs`：不正入力とコマンド一覧
- `test/bridge.test.mjs`：認証・origin・SSE・再接続
- `test/ui.test.mjs`：360px幅のChromeで操作、生成中ドラフト、確認、会話作成

最後に`docs/capabilities.md`を読むと、何が実装済みで何がこれからか分かります。この時点でAndroidアプリやPiの全機能が完成した、という意味ではありません。
