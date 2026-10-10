# GitHub認証と追加CLI（チェックポイント5）

実行は引き続き一つのdurable Harness／CodingToolsです。GitHub認証はprofileサービス、pi-pkgは標準CLIであり、別のPi CLIやmodel／tool loopではありません。

**61 host testsとAPK `0.5.1-cli` buildが成功し、Galaxyへデータ保持で更新済み。新profileへの実GitHub PAT保存、gh 2.102.0追加、private repositoryへのHTTPS git接続を確認しました。** 旧アプリでの成功や、実モデルの自律CLI選択とは区別します。

## GitHub認証

- `/github`または操作メニューから専用dialogを開く。PATをコマンド引数として渡すslash構文は拒否し、モデルへ送らない
- 必要なrepository・権限だけを許可したfine-grained PATを、password型の専用欄へ入力する
- `https://api.github.com/user`へだけ検証要求を送り、redirect禁止・15秒timeout・response size上限を設ける
- 成功したtoken／usernameを、新profileの`github.json`へ原子的に0600で保存する。旧アプリやホストの認証ファイルは読まない
- storageはno-follow／regular file／bounded read。破損・symlink・oversizeを認証なしとして上書きせず、要確認のerrorにする
- 再認証失敗では以前のPATを保持する。保存済みPATの存在がconnectedであり、その後もtokenが有効／すべてのrepositoryへアクセス可能という証明ではない
- UI入力欄を送信／close／disposeで消し、保存済みtokenを返さない。会話、durable文書、AppView、public errorへ入れない
- `/api/github`も既存のloopback・Host／Origin・header認証を使う。profile revisionが変わればstale操作を拒否する
- 解除は60秒・一度限り・revision付き確認。ユーザーが確認したときだけ新アプリのPATを削除し、ChatGPT認証や会話・workspaceは保持する。GitHub側でのtoken失効や、すでに起動したgh child内のtoken消去ではない
- HTTP responseが失われても保存／解除を自動再送せず、GETで状態を読み直す

## 標準gitとgh

`runtime/cli.ts`がprofileのmanaged `bin/`にNode launcherを生成します。Android serviceはprefixを明示し、CodingToolsのNodeExecutionEnv.shellEnvへ設定します。GitHubの保存・変更は次のcommandから反映され、tokenをdurableから復元する方式ではありません。

### git

- 標準gitを使い、GitHub HTTPSのUsername／Password要求だけをprivate askpassへ渡す
- Node shebangを使い、Termuxのhard-coded shell pathに依存しない
- Android prefixのlibexec/git-core／etc/tls/cert.pemをGIT_EXEC_PATH／GIT_SSL_CAINFOへ設定する。compiled Termuxの別package pathを使わず、TLS検証は無効にしない
- PATをremote URL、argv、Git設定、gitの親shell環境へ入れない。askpassのstdoutはgitだけが消費する内部credential transportであり、ツールとして直接呼んで表示してはいけない
- 子commandのcredential helper設定を空にし、別storeへcacheしない。ホスト／globalのgit configを変更しない
- `github.com`以外、HTTP、別port、malformed promptへPATを返さない
- SSH鍵／GitHub Enterpriseは管理しない

### gh

`gh`本体はAPKに追加同梱しません。必要時に`pi-pkg install gh --yes`で`usr/bin/gh`を追加します。PATHではprofile launcherを優先し、native本体は移動・上書きしません。

- 新profileのPATをnative gh childのGH_TOKENへだけ供給する
- ambientのGitHub token／enterprise token／debug／socket overrideを除き、github.comとprivate GH_CONFIG_DIRを固定する
- 認証の表示・別storeへのlogin／logout／setup-git、alias／extensionを拒否する
- hostname、repository host、URLを制限する。保存済みPATが読めない通常commandは拒否し、hostの認証へfallbackしない
- `gh --version`／helpはPAT保存前にも利用できる。本体未追加ならpi-pkgの案内を出す
- 完全なstock gh互換・任意extension対応とは扱わない

ホストMac側のGitHub操作は従来のgh-op／git-credential-opを使います。Android側は1Password CLIへ依存せず、新アプリに明示的に保存したPATだけを使います。

## pi-pkgは追加専用

```sh
pi-pkg list
pi-pkg plan gh
pi-pkg install gh --yes
gh repo list --limit 20
```

- ARM64／allのTermux package indexをHTTPSで取得する。`list`はnetwork不要
- commit済み`runtime/termux-baseline.json`は参照rootfsのpublic package名／versionに由来する68件。repacked rootfsのSHA-256と結びつけ、packagerが一致を確認する
- 実行時もnative installerの`.rootfs-sha256` receiptと照合し、追加registryからbaselineを上書きしない
- 依存・version・alternativesを解決する。既存versionを満たせない場合はupgradeせず拒否。virtual packages等は未対応
- installは明示的な`--yes`が必要。既存のowner authorizationを尊重し、それ以外は許可を得て実行する。OSレベルの承認強制ではない
- index・archive・expanded payload・依存数を制限する。archiveのSize／SHA-256を検証してから展開する
- tar checksum／traversal／symlink／entry type／collisionを検査する。既存filesとplanned file／linkをdirectoryとして辿らない
- usr内の存在しないfilesだけを追加し、既存binaryやuser filesを置換しない。scriptのshebangだけをrelocateし、ELF内の固定pathは書き換えない
- gzipはNode、xzは既存baselineのxzで展開。PAX・hard link・zstdなど未対応のarchiveは拒否する
- maintainer scriptsは実行せず警告する。apt／dpkg互換ではなく、fixed pathやscriptに依存するpackageは動作しない場合がある
- 通常の失敗では、そのinstallが新しく作ったfiles／空directoriesだけをrollbackする。registryはprivate atomic write。commit後の出力errorで成功したfilesを消さない

installはexclusive-createの`package-install.lock`を保持します。正常終了／通常exceptionで自身のlockを解除します。process kill／power lossではpartial filesやlockが残り得るため、**自動解除・自動再試行・古いlockの時間判定はしません**。状態をinspectする必要があります。任意のusr削除／再展開で直さないでください。

APK更新前にも実行・draft・このlockを確認し、home／usr／workspaceを保持します。新しいAPKはmanaged launcherを再生成しますが、追加CLIとregistryは残します。

## 信頼の境界

private directory・no-follow・UIのmask・CLI制限は、誤表示・別host利用・別storeへのコピーを減らすためのものです。**同じapp UIDで動くコード／ツールからの隔離・暗号化ではありません。** 任意shell、native binary、cloneしたコード、追加packageは信頼できるものだけ実行してください。

packageのSHA-256はHTTPSで取得したindexを基準にします。独立したAPT署名検証は未実装です。APK／build inputsは既存と同じtrust rootであり、自己更新の完成や供給網全体の安全性を保証しません。

## host検証

全体は55 Node／browser／bundle＋6 Python＝61件、failure／skipなし。typecheck／format／diff check、90 production packagesのoffline bundle、minSdk26／targetSdk28のAPK buildを確認しました。hostのNode依存・native baselineの新規download／install scriptsは実行していません。端末のgh取得は以下の実機確認で実施しました。

- GitHub mock：公式endpoint／redirect禁止、private保存、再起動、失敗時保持、timeout／shutdown、stale／同時操作、確認付き解除、corrupt／symlink／oversize拒否
- host git：実gitのcredential protocolをtest-only tokenで接続。ホスト設定変更なし、結果はtest memory内だけで検証
- gh test double：新PATの利用、ambient token除去、host／token表示の拒否。実native ghや実GitHub通信ではない
- durable faux：既存CodingToolsのbashから同じprofile CLIを呼び、marker結果だけを会話へ確定。modelにPATを渡さない。自律的な実モデル選択の検証ではない
- desktop browser：360pxでmasked input、close時消去、保存・解除取消／確認、draft保持、model callなし・JS errorなし・page overflowなし
- package mock：fixture debのchecksum／version／path／collision／lock／baseline mismatch／rollback／maintainer script不実行。実Termux downloadではない
- packaged host：production-only appのboot／durable再開、GitHub API／generated helper、新追加sourceの一致
- Python packaging：baseline metadataのrootfs mismatch拒否、再現性・依存closure・private/dev/host除外を含む

## Galaxyの実機確認

- idle／空draft／package lockなしでgraceful stopし、`adb install -r`で0.5.0、修正後の0.5.1へ更新。6会話・16エントリ、確定entry digest、選択・model／thinking、ChatGPT認証を保持
- ユーザー指定の1Password itemからPATをsecret-aware経路で取得し、新profile専用APIへ一度だけ設定。値をログ、argv、URL、会話へ出さず、旧アプリのcredential fileは読まない
- pi-pkgで68件のnative baselineを照合し、実index／archive取得とgh 2.102.0の追加に成功。初回install後はregistryを読み、保存済みinstallを繰り返さない
- 本番と同じinstallGitTools／NodeExecutionEnv設定で標準CLIを実行。実ghでアカウントを確認し、20 repositories中4 privateを取得。private repoの名前・URL・refsは表示／記録せず、HTTPS git ls-remoteの成功だけを確認
- 初回gitはcompiled Termuxのexec pathを参照して失敗。新prefixのGIT_EXEC_PATH／GIT_SSL_CAINFOで補正し、修正APKではcommand側の追加指定なしで成功。git設定やbaseline binaryを書き換えたのではない
- Node／bash／git／xzのdigestはCLI追加前後で一致。private認証／registryは0600、正常終了時のpackage lock解除を確認
- gh追加後のAPK再更新でも、新PATとghを保持。新しいPAT保存やCLI installを再実行せず、保存済み状態から接続を確認
- GalaxyのGitHub管理dialogを開閉し、password型・空欄のまま、ChatGPT login非表示、page overflow／JS errorなしを確認。秘密をUIやclipboardへ貼る自動操作はしない
- 検証で新しいmodel input、remote write／push、cloneは行わない。会話・選択・設定・usageに差分なし。直接NodeExecutionEnvの検証であり、実モデルがghを自律選択した証明ではない
- temporary Web Screen Wake Lockは検証後に解除し、ADB forwardsも削除。Android設定は変更しない
- ユーザーの明示依頼により旧org.pimobile.appをuser 0から削除。新アプリのdataとMac上の参照リポジトリは保持し、旧PAT／会話は移行しない

実GitHubの失効／再認証失敗／解除、実CLI installの途中kill／電源断、他packageの互換性、実モデルによる自律CLI選択は未検証。browser preview移植、実IME変換、実compaction／途中killは次の別作業です。
