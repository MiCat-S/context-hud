# context-hud

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | **日本語**

Claude デスクトップアプリ（ターミナルでも可）向けの Claude Code mod。プロンプトの上に 1 行で、プランの利用枠とプロンプトキャッシュを表示します。各列はリングと短いテキストです。

```
◔ Session 22% ↻ 3h 39m    ◑ Weekly 69% ↻ 7h 39m    ◑ Fable 53% ↻ 7h 39m    ● Cache · 59m · Hit 97%
```

| 列      | 内容                                                                                       |
| ------- | ------------------------------------------------------------------------------------------ |
| Session | 5 時間枠：使用率、リセットまでのカウントダウン。現在のペースでリセット前に使い切る場合は `▲ full in …` |
| Weekly  | 全モデル合計の 7 日枠                                                                        |
| Fable   | 特定モデル専用の週間枠。名前は利用状況カードと同じ                                              |
| Cache   | プロンプトキャッシュ：TTL の残り分数、直前の応答のヒット率、温かさ                                  |

リングは枠の使用率、その後ろの薄い部分は枠のうち経過した時間の割合です。幅に余裕があれば各列に `· Time 54%`、キャッシュ列に `· Warm` と `· Warmth 98%` が加わります。

## インストール

ターミナルの Claude Code セッションで:

```
/plugin install context-hud --marketplace MiCat-S/context-hud
```

`y` でマーケットプレイスを追加し、user スコープを選びます。以後、デスクトップアプリを含むすべてのセッションで動きます。

## コマンド

| コマンド       | 効果                                                           |
| -------------- | -------------------------------------------------------------- |
| `/hud`         | 表示の切り替え                                                 |
| `/hud on|off`  | 表示または非表示                                               |
| `/hud refresh` | すぐに再読み込みし、利用状況 API の応答とバンドの幅を報告        |

## 数値の出どころ

- **Session と Weekly** は API 応答ごとに届きます（`$.session.usage().rateLimits`）。
- **モデル専用の週間枠（Fable）** は応答ヘッダーにありません。mod は `$.session.authorize()` と `$.http.fetch(url, { auth })` を通じて、利用状況カードと同じエンドポイント `https://api.anthropic.com/api/oauth/usage` に問い合わせます。資格情報はエンジンが付与し、mod は目にしません。問い合わせは最大 1 分に 1 回、ターン終了時や枠が動いたときです。
  - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` が設定されているとエンジンはこの呼び出しを拒否します。その場合 mod は `~/.claude.json` にあるエンジン自身の前回の読み取り（`cachedUsageUtilization`）を使い、琥珀色の `~53%` で表示し、余裕があれば古さも示します。
- **Cache** はセッションのトランスクリプトから読みます。直前のメインスレッド応答のキャッシュ読み取り量と、書き込んだ TTL です。

## 開発

```
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p . --noEmit   # エンジンが一度 mod を読み込んだ後（.claude-plugin/types が書かれます）
```

インストールせずフォルダから実行: `claude --plugin-dir .`。デスクトップアプリが起動するセッションでは `CLAUDE_CODE_PLUGIN_DIRS` にフォルダを指定します。
