# 実機PiでReaditのスマホ対応を進める

Readitの公開repositoryをAndroid app-private workspace内の新しいcheckoutへcloneし、
専用branchで実モデルに作業させる。既存のMac checkoutは変更せず、Readitへの
commit／push／PRはまだ行わない。Android Piの会話は既存の単一durable Harnessを使う。

## 実行したfirst passes

1. 実モデルがstandard coding toolsでclone、調査、修正、testを実行した。
   baselineはReadit `460b0c86e6aadc4fb3e6214f98a40cc2129ef124`。
2. Androidの229 keydownに続くbeforeinput削除意図が空の入力bufferではeditorへ
   届かない経路を修正し、JS配線testと実editor／保存bytesの回帰testを追加した。
3. phoneにMoonBit compilerがないため、phoneのpublic差分を新しい隔離Mac checkoutへ
   同期し、既存のread-only compiler／dependency cacheでbuild／testした。
4. 最初の追加E2Eは失敗した。失敗内容を実機Piへ返し、modelがInputEventの明示生成に
   修正した。期待する本文と保存bytesは弱めていない。
5. platform-neutralな生成物41件をhash receipt付きでphone branchへ追加した。
   npm依存はcheckout内にignore-scriptsで導入し、baseline packagesは変更していない。
6. 実モデルが公開fixtureの所有serverを起動し、pi-browserで一度だけPreviewを開いた。
   実Readitのready／idle、README表示、drawerからのfile選択を確認した。
7. 実モデルが同じ公開Previewを一度撮影し、標準read toolのimage contentを読み、
   menu／本文／clipの所見を報告した。旧software経路のCanvas欠落を再現した。
8. Android Piを0.7.4-toolsへ更新し、managed npm／npxとview-only hardware画像化を追加。
   7会話・98確定entryのdigest、選択／設定／認証／CLIを保持した。
9. 実機Piが通常のnpm／npxで既存11.20.0を利用し、画像だけの未知Canvas文字を照合。
10. 実機のWasm documentで229 backward／forward／選択削除を確認した後、keyboard-height
    CSSがmenubarを隠してSaveへ到達できない穴を再現した。失敗scriptは再実行しなかった。
11. 実機Piが最小CSSと355px回帰testを追加。現在のdirty documentをreloadせずCSSだけ
    更新し、保存だけを一度再開。正確なC改行bytesとdirty=false、保存後画像を確認した。
12. 新回帰testを隔離hostで旧CSSへ当て、両browserで期待したvisibility失敗を確認。
    修正CSSでmobile20件が成功した。既存Mac checkoutは引き続き未変更。
13. ユーザーが今回だけ公開Readitとkeyboard／候補欄の確認を許可した後、host ADBの
    touch injectionで実Samsung HoneyBoardを操作した。12keyのフリックと候補tapで
    日本語へ変換・確定し、実削除keyで日本へ、改行後に確認を変換・確定して改行した。
14. 保存前はdirty=true／disk 0 bytes。File menuのSaveを実tapし、dirty=falseと
    `日本\n確認\n`の正確なUTF-8 14 bytesを確認した。実機Piも保存bytesを独立確認し、
    Native WebView-only PNGを一度撮影して標準readで日本／確認／空行と保存表示を確認。

## 証拠の区別

- Phone：実モデルによるcode変更、Node配線7 tests、Readit server起動、分離Preview、
  viewport 360×682、公開fixtureの描画／drawer操作、PNG撮影／image read。
- Host：Moon28 tests、JS配線7 tests、Chromium／WebKit mobile E2E20 tests。
  229削除、選択削除、keyboard-heightのmenu／touch target／scroll、保存前のdisk保持と
  保存後bytes／dirty=falseを含む。新しいmenu回帰は旧CSSで両browserとも失敗した。
- Android Pi本体：79 Node／browser／bundle＋6 Python＝85 tests。これにはnative sourceの
  view-only境界guardを含むが、Java文字列検査をAndroid実行testとは扱わない。
- Host支援の実機確認：ADB touch injectionによる実soft keyboardのフリック、IME候補
  選択・変換・確定、確定後の削除／改行、menu Saveを確認。直接の日本語insertや
  合成InputEventではない。実指のscroll／tap、Pi composer自体のIME変換は未確認。
- trustedなcompositionstart／updateとinsertCompositionTextを確認したが、観測した
  compositionendはtrusted=falseだった。発生元は未特定で、内部fallbackとは断定しない。
  isTrustedだけでは実IME／本人操作と判定しない。
  後置observerに届かない削除／改行もあり、文書遷移と実tapを併せて検証した。
- Keyboard確認は今回だけの明示許可を受けたhost ADB画像であり、通常のpi-browserや
  Android PiのNative screenshotにkeyboard／Window撮影を追加したものではない。
- 旧software captureのCanvas欠落を修正。hardware経路でCanvas／PNGの背景pixelを
  確認し、実モデルもprompt／DOM text／phone sourceにないCanvas文字を画像だけから
  正しく回答した。任意のWebGL／video layerや長時間安定性までは保証しない。
- 最初の実機削除passはpublic fixture／合成eventsで、後のpassは実soft keyboardを使用。
  保存操作はReadit UIから行い、Node fsでdisk bytesを確認した。
  直接fsの書込みでReadit保存を代替していない。
- 検証用markerは除去し、公開Readit Previewと所有serverは閲覧できるよう残している。
  private PID／readiness、PNG、fixture、実行履歴の詳細はgitへ入れない。

## エージェント側で見つかった改善課題

- 標準npmの固定Termux shebangをmanaged npm／npx launcherで補正済み。
  baselineを書き換えず実機Piで利用した。third-party scriptの全互換は未保証。
- AndroidではMoonBitとdesktop Playwright E2Eをそのまま実行できない。
  phone編集 → 隔離host build/test → hash付き生成物返却の受け渡しを再現可能にする。
- 公開fixtureが表示され、image readが通っただけで視覚検証を完成扱いにしない。
  描画欠落を再現・修正し、2D Canvas文字の未知値照合を加えた。総合preview probeや
  cookie分離、巨大画像履歴paging、その他GPU layerは引き続き別検証。
- repository cwd／指示の自動読み込み、skills／templates、resource adaptersは未実装。
  今回は明示的なtask指示とabsolute pathsで補った。
- 将来の更新もdraft、durable tasks／queue／compaction、package lock、Readitの未保存状態と
  所有serverを確認してから行う。lost responseでtaskやbrowser mutationを再送しない。
  native preedit中はWasm dirty=falseでも入力がある。reload／open／更新前にはcomposingも
  確認する。file選択後は対象tabとidleを待ち、直後の旧tabを結果と取り違えない。
- 検証途中のbackground化とtemporary wake leaseの終了は別に記録する。既存taskへ復帰し、
  入力結果を読んでから続行した。原因を自動lockと断定せず、security設定を変更しない。

Readitのスマホ対応そのものは完了宣言していない。この実作業を回帰taskとして使い、
実機coding／browser／編集・保存・復帰の不足を確認しながらAndroid Piを改善する。
