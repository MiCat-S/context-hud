# context-hud

[English](README.md) | **繁體中文** | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

給 Claude 桌面版（終端機也可用）的 Claude Code mod：在輸入框上方用一行顯示方案的用量視窗與提示快取，每欄一個圓環加一行短文字。

```
◔ Session 22% ↻ 3h 39m    ◑ Weekly 69% ↻ 7h 39m    ◑ Fable 53% ↻ 7h 39m    ● Cache · 59m · Hit 97%
```

| 欄位    | 內容                                                                                   |
| ------- | -------------------------------------------------------------------------------------- |
| Session | 5 小時視窗：已用百分比、重置倒數；依目前速度會在重置前用完時顯示 `▲ full in …`           |
| Weekly  | 7 天視窗，所有模型合計                                                                  |
| Fable   | 單一模型自己的每週視窗，名稱與用量卡片相同                                               |
| Cache   | 提示快取：TTL 剩餘分鐘、上一次回應的命中率、暖度                                         |

圓環是視窗的用量，後面較淡的一段是視窗已經過去的時間比例。寬度足夠時每欄會多顯示 `· Time 54%`，快取欄多顯示 `· Warm` 與 `· Warmth 98%`。

## 安裝

在終端機的 Claude Code session 輸入：

```
/plugin install context-hud --marketplace MiCat-S/context-hud
```

回答 `y` 加入 marketplace，再選 user scope。之後每個 session 都會載入，包括桌面版。

## 指令

| 指令           | 效果                                               |
| -------------- | -------------------------------------------------- |
| `/hud`         | 切換顯示                                           |
| `/hud on|off`  | 顯示或隱藏                                         |
| `/hud refresh` | 立即重新讀取，並回報用量 API 的結果與帶子的寬度     |

## 數字從哪裡來

- **Session 與 Weekly** 隨每次 API 回應而來（`$.session.usage().rateLimits`）。
- **單一模型的每週視窗（Fable）** 不在回應標頭裡。mod 透過 `$.session.authorize()` 與 `$.http.fetch(url, { auth })` 呼叫用量卡片讀的同一個端點 `https://api.anthropic.com/api/oauth/usage`：憑證由引擎自己加上，mod 看不到。每分鐘最多問一次，在回合結束或視窗變動時。
  - 若設定了 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`，引擎會拒絕這個呼叫。mod 改讀引擎在 `~/.claude.json` 的上一次讀數（`cachedUsageUtilization`），以琥珀色 `~53%` 顯示，寬度夠時加上資料多舊。
- **Cache** 讀自 session 的 transcript：最後一次主線回應的快取讀取量與它寫入的 TTL。

## 開發

```
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p . --noEmit   # 引擎載入過一次之後（它會寫出 .claude-plugin/types）
```

不安裝直接從資料夾執行：`claude --plugin-dir .`；桌面版啟動的 session 則把資料夾寫進 `CLAUDE_CODE_PLUGIN_DIRS`。
