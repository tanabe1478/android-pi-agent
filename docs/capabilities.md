# 機能対応表（チェックポイント5）

検証環境を各行と[Androidの検証範囲](android.md)で区別する。「実装済み」は端末Piと完全に同じ意味を保証する表示ではない。

| 機能 | 状態 | この区切りの範囲／残る作業 |
| --- | --- | --- |
| モデル呼び出し・coding tools | 既存実装を利用・実機確認 | durableとCodingTools。Galaxyで実`openai/gpt-6.1-sol`の応答と、実モデルが選んだwrite/read/bashを専用fixtureで確認 |
| ストリーミング表示 | 実装済み | committed viewを表示。ドラフトを維持 |
| Pi型UI・thinking・tool結果表示 | DOMへ適応 | フラットなMarkdown本文、思考折りたたみ、tool call/result pairingとpreview、下部editor／footer。Galaxyでtool展開、footer selectors、実keyboard layoutを確認。思考切替はdesktop確認。専用extension rendererは未対応 |
| usage表示 | 累計のみ実装 | durableのpi.usageを表示。reasoningはoutputの内数。context占有率は未取得、参考costは実請求とは扱わない |
| モデル・思考レベル | 実装済み | 登録モデルの変更・検索・対応レベル検証・再オープン復元。実機でgpt-6.1-sol／lowを確認。他モデルの利用可否は未検証 |
| 会話作成・切替・命名 | 実装済み | 同じdurable SQLiteのcatalog。明示的な対象ID |
| fork | durable向けに適応 | ユーザー入力地点から別会話を作成。CLIの同一ファイル内tree navigationとは異なる |
| clear | 実装済み | 文脈リセット。確認・busy guard・履歴保持。旧履歴の閲覧UIは未実装 |
| compaction | 最小接続 | 要求・live状態・停止。完了結果の専用通知や実モデル要約の検証は未実施 |
| steering / follow-up | 実装済み | durableの入力キューに入れる。取消・abort。個別編集は未実装 |
| slash completion | 実装済み | 共通catalogの11コマンド（/github追加）。説明付きリストとArrow／Tab／tap選択。未知のコマンドは拒否 |
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
| ChatGPT認証 | 接続済み・実機確認 | 既存pi-ai OAuth、private保存、refresh、取消・timeout、manual fallback。GalaxyのChromeで実ログインし、login非表示／menu再認証とservice再開後の認証利用を確認。期限切れ実refreshは未検証。logout・他provider／API keyは未対応 |
| GitHub認証 | 実装済み・Galaxy確認 | 新profile専用PAT、専用UI／API、git HTTPS askpass、ghの限定ラッパー。指定1Password itemから明示的に新profileへ設定し、20 repos（4 private）の一覧とprivate git HTTPSを確認。旧PATは移行しない。実失効／解除は未検証 |
| on-demand CLI | 追加専用・Galaxy確認 | pi-pkg list／plan／install --yesでgh 2.102.0を追加。baseline照合・SHA256・既存files保護、APK再更新後の保持を確認。他package、maintainer scripts／APT署名検証／crash自動修復は未対応／未検証 |
| pi-browser | 未対応 | 参照のisolated preview／CLI-first実装とnative hostを移植する |
| Android APK・native host | Galaxyで最小動作確認 | 別ID・targetSdk 28。private展開、foreground service、Node／WebView、keyboard resize、実認証／推論／toolsを確認。実IME変換・長時間動作などは未検証 |
| process death / recovery | 限定的に検証 | Android service停止／再開で実認証・会話・モデル／思考を復元。前のfauxではidle owner kill後の会話復元とflockも確認。実ツール途中のkill・電源断・長時間background、デスクトップのprofile lockは未検証／未対応 |

## 実装の順序

1. この土台をコミットし、構造と未対応範囲を共有
2. Androidホストのfaux確認、ChatGPT adapter、実認証／推論／tools、Pi型UIの基本実機確認は完了。GitHub・on-demand CLIもデータ保持更新、実認証・read-only通信・gh追加を確認済み。browser移植と実IME／復旧を続ける
3. Piのresource loader・拡張UI能力を再利用／適応し、端末Piとの機能差を埋める
4. 添付、履歴／tree、直接シェル、MCPなどを対応表とテストで進める

別のCLIが使えることを、この表の「対応済み」の根拠にはしない。
