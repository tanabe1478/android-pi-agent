# Piを基本にしたAndroid表示（チェックポイント4）

通常のPiの配置・操作感を基本にし、小さい画面・タッチ・IMEで難しい箇所だけ
スマホ向けに調整する。別のWebチャットアプリを基本形にはしない。

`pi-durable`と既存CodingToolsは引き続き唯一のbackend。Pi CLI、ANSI terminal、
別の会話／モデルloopは追加していない。TUI extension互換も、この見た目変更で
達成したとは扱わない。

## Piから引き継ぐ構成

- 起動表示はtranscript内でスクロールし、上部の固定操作バーは置かない
- user promptは全幅の薄い背景。assistantは吹き出しやrole見出しを付けない
- assistant本文はMarkdown、thinkingはmuted／italic。思考は個別tap／Ctrl+Tで切替
- tool callとresultはcall IDで一つの表示にまとめる。名前・path／command・状態・
  短いpreviewを表示し、tap／Ctrl+Oで展開。live outputから確定resultへの更新でも
  展開状態を維持する。結果がないことを成功と決めつけない
- editorの上下罫線をthinking levelで色分けする
- editorの下へcwd／session、累積usage／model／thinkingを配置する
- `/`の候補は説明付きのリスト。ArrowUp／DownとTab、またはtapで選択する
- `/model`、`/thinking`、`/resume`、`/login`などの操作を継続利用する
- checkpoint5の`/github`／menuはprofile認証専用dialogを開く。PATはcomposerや会話へ入れず、masked inputを送信／closeで消す。この追加画面はdesktop／mock確認のみで、Galaxy確認は次の更新後に行う

Piのusage docs、assistant/user/tool/footer componentsを確認し、DOMでこの表示を
適応した。一般的なPiのsession implementationへ切り替えたのではない。

## スマホ向けに残す違い

- **Enterは改行**。IME確定での誤送信を避ける。送信buttonとCtrl/Cmd+Enterを使う
- Alt+Enterはfollow-up。通常送信のsteer／follow-up選択もtouchで操作できる
- 停止buttonは実行中だけ表示する。hardware keyboardではEscapeでも停止
- `/`のtouch shortcut、操作menu、footerのtouch selectors、dialogを用意する。
  `/` shortcutは既存draftを上書きしない
- keyboardで高さが小さくなるとeditorを縮め、履歴の領域と送信controlを残す
- narrow footerはpath／modelを省略し、tapして詳細を見る。usageも詳細dialogへ
- 本文・codeは折り返す。tableだけは内部の横scrollを許し、page全体は横にはみ出さない
- user promptのfork操作は小さい`⋯`へまとめる

## 状態と安全性

確定conversation、live generation/tool状態、`pi.usage`はdurable viewが正本。
UIはdraft・focus・展開・候補selectionだけを持つ。composer nodeはtoken更新で
作り直さず、失敗したmutationを再送しない。

usageは`pi.usage.models`／`tools`の累計から表示する。reasoningはoutputの内数で、
加算し直さない。**累積tokensはcontext占有率ではない**。context使用率はまだ取得
しておらず、参考costもChatGPT subscriptionの実際の請求額とは扱わない。

MarkdownにはPiでも使われるMarkedの既存lexerを利用する。現在のvendorは18.0.11、
43,800 bytes。既存dependencyをread-onlyでコピーし、MIT licenseとSHA-256を保存した。
新たなdownload／installはしていない。[vendorの出典と更新手順](../ui/vendor/README.md)。

lexer tokensからallowlistのDOMを組み立てる。`innerHTML`、raw HTML実行、remote image
取得はしない。linksはuserinfoなしのHTTP(S)だけ。Androidの既存navigation制限も
変更しない。syntax highlightingや既存extensionの専用rendererはまだ未対応。

## ファイル

- `ui/index.html`／`style.css`：transcript・editor・footerとresponsive layout
- `ui/components.js`：message／tool表示、展開、dialog、focus復帰
- `ui/markdown.js`：Marked tokensから安全なDOMへ
- `ui/presentation.js`：usage、path省略、tool title／call-result pairing
- `ui/app.js`：入力、completion、selectors、keyboard／touch shortcuts
- `test/presentation.test.mjs`：ledger、pairing、vendor hash、安全なMarkdown、
  展開保持、draft／IME guard、320／360幅・keyboard相当の403高さを検証

## 検証範囲

36 Node／desktop browser／bundle testsと5 Python packaging tests、計41件が成功。
`0.4.0-ui` APKをoffline buildし、application ID／minSdk 26／targetSdk 28を確認。
Galaxyへ`adb install -r`で更新し、認証・選択と6会話・16エントリを保持した。
更新前後の確定entry比較も一致した。

### 新UIのGalaxy確認

- 認証保持／login非表示、上部固定barなし、下部editor／footerを確認。
  footerのmodel／thinking／累積usageがdurable viewと一致
- 既存の実モデル履歴にある3つのtool call/resultをまとめて表示し、個別の展開／
  折りたたみを確認。今回の履歴にはthinking blockがなかったため、思考表示の
  切替はdesktop browser検証の範囲
- model検索、thinking、会話、usage、workspaceのdialogとmenu再認証を開閉。
  設定の選択／保存や再ログインは行わない
- 実際のAndroid tapでkeyboardを表示し、viewportは360×730から360×403へ縮小。
  送信controlとfooterはkeyboardより上に収まり、履歴領域も515→209pxを確保。
  keyboardを閉じると730高さへ復帰。pageの水平overflowとJavaScript errorはなし
- 自動操作で日本語＋emoji draftを入力し、`/` shortcutが既存draftを上書きしないこと、
  `/mo`候補のtap選択、合成composition中Enter guardを確認。
  **実IMEでの手入力・候補変換は未検証**
- 検証前後のconversation entries、session選択、model／thinking、usageに差分なし。
  検証用draftだけを片付け、scroll／focusを復元。モデルへ新しい入力は送信しない
- 自動消灯で操作を進められない状態を観測した。端末の設定は変更せず、ユーザーの
  ロック解除後に検証用のWeb Screen Wake Lockを一時取得し、確認終了時に解除した。
  アプリに常時画面点灯する機能を追加したのではない
- ブラウザ／keyboardの画像、clipboardや候補内容は取得しない。ADB forwardsも解除

desktopの403高さへのresize、合成composition、実keyboardの開閉は別の検証。
前の`0.3.0-auth`の実推論／CodingTools成功とも区別する。CDP attach時のstream停滞は
未解決で、今回修正したとは扱わない。
