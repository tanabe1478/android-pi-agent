# 機能対応表（チェックポイント1）

「実装済み」はホストで検証した範囲。Androidの動作や端末Piと完全に同じ意味を保証する表示ではない。

| 機能 | 状態 | この区切りの範囲／残る作業 |
| --- | --- | --- |
| モデル呼び出し・coding tools | 既存実装を利用 | durableとCodingTools。fauxによる会話と一時workspaceのwrite/readを検証 |
| ストリーミング表示 | 実装済み | committed viewを表示。ドラフトを維持 |
| thinking・tool結果表示 | 最小実装 | 展開できる。装飾・専用renderer・usage表示は未整備 |
| モデル・思考レベル | 実装済み | 登録モデルの変更・対応レベル検証・再オープン復元。実認証は未実装 |
| 会話作成・切替・命名 | 実装済み | 同じdurable SQLiteのcatalog。明示的な対象ID |
| fork | durable向けに適応 | ユーザー入力地点から別会話を作成。CLIの同一ファイル内tree navigationとは異なる |
| clear | 実装済み | 文脈リセット。確認・busy guard・履歴保持。旧履歴の閲覧UIは未実装 |
| compaction | 最小接続 | 要求・live状態・停止。完了結果の専用通知や実モデル要約の検証は未実施 |
| steering / follow-up | 実装済み | durableの入力キューに入れる。取消・abort。個別編集は未実装 |
| slash completion | 実装済み | 共通catalogの9コマンド。未知のコマンドは拒否 |
| workspace | 最小実装 | 起動時に明示、realpath確認、会話作成時に引継ぎ。picker／変更UIは未実装 |
| skills / AGENTS.md読込み | 未対応 | 既存Piのloader／prompt生成を再利用できる境界を整える |
| prompt templates | 未対応 | 引数展開とresource discoveryを共通側へ接続 |
| 従来のPi拡張 | 未対応 | durableのextensionとはAPIが異なる。状態・イベント・操作のadapterが必要 |
| 拡張のselect/confirm等 | 未対応 | Android UI capabilityを供給。現在のDialogはアプリ内部用 |
| TUI custom components | 未対応 | 互換方式を決める。DOMへ自動変換できるとは扱わない |
| MCP / codemode | 未対応 | 接続・tools exposure・更新／reloadの整合性を検証 |
| 添付・画像・ファイル補完 | 未対応 | picker、モデル能力確認、永続化、画像表示を接続 |
| ! / !! | 明示的に未対応 | 私的シェル入力として扱うべきものをモデルへ誤送信しない |
| tree / import / export / share | 未対応 | durableの履歴・分岐とCLI形式の違いを扱う |
| provider認証 / GitHub認証 | 未対応 | ChatGPTログインなど参照の既存実装を、共通側の認証adapterへ接続 |
| on-demand CLI / pi-browser | 未対応 | 参照のCLI-first実装を移植。承認境界とnative hostを先に整える |
| Android APK・native host | 未着手 | 別アプリID・targetSdk 28・参照データ保持 |
| process death / recovery | 基盤はdurable | graceful reopenは検証。kill途中のツール・電源断・実機復旧は未検証。profile lockも未実装 |

## 実装の順序

1. この土台をコミットし、構造と未対応範囲を共有
2. Androidホストと実モデル認証を接続。参照アプリと並行して実機確認
3. Piのresource loader・拡張UI能力を再利用／適応し、端末Piとの機能差を埋める
4. 添付、履歴／tree、直接シェル、MCPなどを対応表とテストで進める

別のCLIが使えることを、この表の「対応済み」の根拠にはしない。
