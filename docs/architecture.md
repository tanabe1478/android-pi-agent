# 設計：実行は一つ、表示は交換できる

## 要件

スマホの操作画面からPiの機能を利用できることが目的。別のPi CLIへ切り替えれば使える、という代替は全機能対応の判定に含めない。

実行・モデル呼び出し・会話の所有者は`pi-durable`。UIの所有する状態は入力ドラフト、フォーカス、ダイアログ、展開状態、通信状態だけ。

## Pi本体から参考にした境界

Pi本体の手元のソース（commit `28dcce2ba`、パッケージ表記1.0.4）を調査した。

- `packages/tui/src/index.ts` / `packages/tui/README.md`：Component、入力・focus、描画、コンテナ、選択UI、disposeの分離
- `packages/coding-agent/src/experimental/durable/runtime.ts`：`DurableView`と`DurableController`。画面にはHarnessを渡さない
- 同ディレクトリの`README.md`：画面は`Conversation.viewState()`を表示し、復旧を担当しない
- `packages/coding-agent/src/experimental/services/`：`AgentController`、`Transcript`、`PresentationUI`などのサービス境界

実験系はnpm向けの安定した全機能クライアントではなく、CLIとの互換性に未対応項目がある。本実装はそのソース全体をコピーしたり、1.0.4の内部APIを1.0.2へ直接持ち込んだりしない。最初は参照アプリで動いているdurable/ai/chord 1.0.2の公開APIを固定して利用する。

## pi-tuiとAndroid UIの対応

| pi-tuiの考え方 | このUI |
| --- | --- |
| Componentのrender/invalidate | Transcriptの更新、キー付きメッセージ部品 |
| Editorと入力処理 | textareaとcomposer。表示更新時に作り直さない |
| Focusable / IME | DOMのfocus、標準入力欄、isComposing中は送信キーを奪わない |
| SelectList / overlay | HTML dialogと44px以上の選択ボタン |
| 画面スクロールと追従 | 履歴だけがscroll。下端付近のときだけ新出力へ追従 |
| stop / dispose | 通信のAbortController、購読解除、view mountのdispose |

ANSI互換レンダラーを実装するのではない。TUI専用のカスタムComponentを返す既存拡張は、そのままDOMとして動くとは扱わない。

## ランタイム

`openKernel()`は一つのSQLite storage、一つのHarness、cwd別のNodeExecutionEnvを持つ。既存のCodingToolsを登録し、UIからモデル／ツールの実行ループを実装しない。

会話一覧・名前・選択も同じSQLite内のsessionスコープ文書`android-pi.catalog`で管理する。別のJSONLセッションやsettingsコピーを状態の正本にしない。

`AppView.conversation`はdurableの構造的なview。`pi.agent`、`pi.live`、`pi.inbox`、`pi.usage`を含む。今回はHTTP/SSEで完全なsnapshotを送る。大きな履歴のページングやexact-frame転送は将来の最適化であり、独自イベントreducerへ戻さない。

すべての会話変更にはconversationIdが必要。画面を切り替える前に作られた操作が新しい会話に誤送信されない。最初のUIプロフィールは共有されたactiveIdを一つ持つ。複数クライアントが独立した選択を持つ機能はまだ作らない。

通常の操作は入場処理だけを直列化する。モデルの応答全体をそのqueueで待たない。abortは別経路で実行し、入力キューと実行中の作業を止める。

clearはidle時のみ。短命・一度限りの確認tokenをconversationIdと文脈のstampに結びつける。文脈やモデルが変われば再確認する。確認tokenはプロセス再起動で無効になる。

## 通信とプライバシー

- IPv4 loopbackのみでlisten。HostとOriginを検査
- 接続tokenはheader。URLのqueryでは認証しない
- UI静的ファイルだけをallowlistで配信。runtimeや保存ファイルを配信しない
- スクリプト・表示はsame-origin。モデルやツールのテキストをinnerHTMLにしない
- 遅いSSE接続は切断してsnapshotから再接続。受理された操作は自動再送しない
- 一般エラーには生のstackやprovider payloadを返さない
- 個人用stateDirは0700、SQLiteと起動リンクは0600

このbridge認証は外部サイト／別アプリからの誤アクセスを防ぐためのもの。同じapp UIDで動くtrusted shell・拡張からの隔離ではない。権限UI、データ移行は未実装。AndroidではflockでNodeプロセス全体にprofileの排他を持たせる。デスクトップ起動口の複数プロセス排他は未対応。

## プロバイダー認証

`runtime/auth.ts`はpi-aiの公開Models／OpenAI OAuthを利用し、既存providerのstreamをdurableへ渡します。独自の推論・tool loopやpi-coding-agentは追加しません。API-key／ambient credentialのfallbackを登録せず、新profileのOAuthだけを使います。`--demo`はcredential storageも開きません。

`runtime/credentials.ts`はprovider-ownedなcredentialを0600のprivate JSONへ原子的に書き、同じowner内のread-modify-writeを直列化します。pi-aiがそのmodifyの内側でtoken refreshを行います。Androidのflockがprocess間のprofile所有を保護し、このファイルqueue自体はdesktopのprocess lockを代替しません。破損fileやsymlinkを受け入れず、失敗で既存認証を初期化しません。

AppViewには非secretのAuthSummaryだけを追加します。OAuth URL／manual promptは認証専用APIで扱い、sessionId／promptIdで古い取消・回答を拒否します。認証操作はprofile単位で、会話変更ではありません。失敗したHTTP mutationを再送せず、現在の状態を読み直します。login／refreshのraw provider errorは表示・保存せず、credentialやcallback URLを会話へ入れません。

既存認証を保持したまま再認証でき、5分timeout／取消／shutdownでloginを終了します。UIのconnectedは保存済み認証の存在を示すため、実token refresh／実推論の成功を証明する表示ではありません。logout UIや他providerは別の区切りです。

## GitHub・CLI

GitHubもprofileサービスで、会話やagent backendではありません。`runtime/github.ts`がprivate PATの検証・保存を所有し、controllerへ非secretのGitHubSummaryだけを加えます。専用APIはrevisionでstale操作を拒否し、解除は短命・一度限りの確認付き。HTTP失敗時は読み直しだけで、保存／削除を自動再送しません。

`runtime/cli.ts`の生成launcherとgit askpassはprofile専用。tokenをGit URL／config／argvへ入れず、gitの親shell環境へも渡しません。gh native childだけへGH_TOKENを供給し、認証表示・別host・別認証store・alias／extensionを制限します。同じUIDの任意コードからの隔離ではありません。

Android serviceが明示するprefixを、CodingToolsのNodeExecutionEnv.shellEnvへ渡します。Gitのcompiled Termux pathにはGIT_EXEC_PATH／GIT_SSL_CAINFOを新prefixへ設定し、TLS検証を維持します。pi-pkgは別のmodel loopを持たない標準CLIで、native baseline receiptと照合した追加registryを持ちます。APK更新と同じくusrの既存filesを保護し、maintainer scriptsやbaseline更新は実行しません。詳細は[CLIの境界](cli.md)。

## 分離previewと画像read

Previewは会話・モデル状態を所有しないprofileサービスです。private requestを前面のnative Activityが一度だけ消費し、owner／runtime PIDへ結びつけます。:previewプロセスとWebView data directoryを分け、そのsocketだけを既存header／Host／Origin認証付きCDP proxyで接続します。Pi／OAuth portやremote resourcesは許可しません。pi-browserは同じCodingToolsのshell環境から呼ぶCLIで、PlaywrightはCDP attachment専用です。

画像はCodingToolsのreadをdurable wrapToolでdecorateし、同じExecutionEnvとSQLiteへimage contentを返します。専用vision agentや別のtool loopではありません。UIはbounded raster data URLだけを展開内に表示します。trusted同一UID／CDP scriptをsandboxする構成ではないことと、[host／実機の検証差](browser.md)を区別します。

## Piを基本にする表示

画面は通常Piの配置・操作感を基本にし、mobileで難しい部分だけ変更する。
フラットな本文、thinking、tool call/result、下部editor／footerとslash commandsを使う。
IME誤送信を防ぐためEnterは改行のままで、touchの送信・停止・menuを残す。
usageはdurableの累計を表示し、context占有率と混同しない。[UI方針と検証](ui.md)を参照。

## Android

targetSdk 28の既存の実行方式を維持する。最新targetSdk／Play対応を先行課題にしない。`io.github.tanabe1478.androidpi`という別アプリIDとデータ領域を使い、旧会話・認証を自動移行しない。旧アプリはcheckpoint5でユーザーの明示依頼によりuser 0から削除し、Macの参照リポジトリは保持した。

foreground serviceがassetsをprivate stagingへ展開し、flockを保持してNodeへexecする。Activityはprivate ready recordから接続し、UIとkernelのAPIは同じまま使う。`usr/`の初回baselineと更新できる`app/`を分け、home・workspace・SQLiteを保持する。

Galaxyへ`0.3.0-auth`をデータ保持で更新し、ChromeへのOAuth遷移・ユーザーのChatGPTログイン・実`openai/gpt-6.1-sol`の応答を確認。実モデルが既存CodingToolsをwrite/read/bashの順で選び、専用fixtureを操作した。service再開後も認証、会話、モデル／thinkingを保持する。

WebViewの送信／draft保持、端末のNode/bash、flock、停止／再開、soft keyboardの開閉とviewport縮小も確認済み。実credentialの期限切れrefresh、実IME変換、実ツール途中のkillなどは未検証。CDP attach時のstream停滞は観測しており、原因は未特定。詳細は[Androidホストと検証範囲](android.md)。
