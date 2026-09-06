# food-expiry-bot

買ってきた食材の賞味期限を記録し、期限が近づいたら LINE に通知する個人用の仕組み。

## 構成

| ディレクトリ | 内容 |
|---|---|
| `04-food-expiry/` | LINE Bot 本体（Google Apps Script）。登録・消費・週次通知 |
| `05-recipe-stock-check/` | レシピと在庫を突き合わせて買い物リストを作る仕組み |
| `.claude/skills/recipe-stock-check/` | 上記を Claude Code から呼ぶためのスキル定義 |

`04-food-expiry/.claspignore` は、clasp が GAS へ送るファイルを Bot 本体の
3ファイルだけに限定している（`icons/*.html` などが混入しないように）。

## 動作の全体像

```
        写真 / 音声入力
             │
          [ LINE ]
             │ Webhook
   [ Google Apps Script ]───→ [ Anthropic API ]  期限の読み取り・意図の判定
             │
   [ スプレッドシート「食材在庫」]
             │                      ▲
   毎週土曜の朝に push 通知          │ 読み取りのみ
                                     │
                            [ Claude Code スキル ]
                                     ▲
                               レシピの写真
```

## できること

**LINE 側**

- 賞味期限が写った写真を送ると読み取って登録（複数商品まとめて可）
- 「豆乳は2027年2月21日」のようなテキスト／音声入力でも登録
- 「牛乳使った」で消費、「豆腐捨てた」で破棄として記録
- 同じ食材が複数あるときは期限つきの候補を出して番号で選択
- 同じ内容を重複登録しようとすると確認
- 毎週土曜の朝、残り1か月と残り1週間のタイミングで1回ずつ通知

**Claude Code 側**

- レシピの写真を渡すと、在庫と突き合わせて買うものを提示

## セットアップ

[04-food-expiry/SETUP.md](04-food-expiry/SETUP.md) に、LINE チャネルの作成から
週次トリガーの設定までの手順をまとめてある。

## コードの反映

`04-food-expiry/` はこのリポジトリが原本で、**実行される実体は Google Apps Script 側**。
変更しただけでは動作は変わらない。

`clasp`（Apps Script の公式CLI）を設定してあれば、次の2つで反映できる。

```bash
cd 04-food-expiry
clasp push                              # コードを GAS へ
clasp deploy -i <デプロイID> -d "説明"   # 新バージョンとして本番へ
```

**`push` だけでは LINE に反映されない。** ウェブアプリはデプロイし直すまで
古いバージョンが動き続ける。

初回の設定手順は [04-food-expiry/SETUP.md の付録](04-food-expiry/SETUP.md#付録-clasp-で反映を自動化する)
にまとめてある。clasp を使わない場合は、GAS エディタに手で貼り直して
「デプロイを管理 → 編集 → 新バージョン」でも同じことができる。

## 注意

API キーやアクセストークンはコードに含めず、GAS のスクリプトプロパティで管理している。
clasp の認証情報（`~/.clasprc.json`）とプロジェクト設定（`.clasp.json`）も
リポジトリには入れない。
