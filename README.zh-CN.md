# context-hud

[English](README.md) | [繁體中文](README.zh-TW.md) | **简体中文** | [日本語](README.ja.md)

给 Claude 桌面版（终端也可用）的 Claude Code mod：在输入框上方用一行显示套餐的用量窗口与提示缓存，每栏一个圆环加一行短文字。

```
◔ Session 22% ↻ 3h39m   ◑ Weekly 69% ↻ 7h39m   ◑ Fable 53% ↻ 7h39m   ● Cache · 59m · Hit 97%   Cost $6.04
```

| 栏位    | 内容                                                                                   |
| ------- | -------------------------------------------------------------------------------------- |
| Session | 5 小时窗口：已用百分比、重置倒计时；按当前速度会在重置前用完时显示 `▲ full in …`         |
| Weekly  | 7 天窗口，所有模型合计                                                                  |
| Fable   | 单个模型自己的每周窗口，名称与用量卡片相同                                               |
| Cache   | 提示缓存：TTL 剩余分钟、上一次回复的命中率、暖度                                         |
| $       | 这个会话到目前为止按 API 价格计算的费用（与 `/cost` 相同），显示在最右端                 |

圆环是窗口的用量，后面较淡的一段是窗口已经过去的时间比例。宽度足够时每栏会多显示 `· Time 54%`，缓存栏多显示 `· Warm` 与 `· Warmth 98%`。

## 安装

在终端的 Claude Code 会话中输入：

```
/plugin install context-hud --marketplace MiCat-S/context-hud
```

回答 `y` 添加 marketplace，再选 user scope。之后每个会话都会加载，包括桌面版。

## 命令

| 命令           | 效果                                               |
| -------------- | -------------------------------------------------- |
| `/hud`         | 切换显示                                           |
| `/hud on|off`  | 显示或隐藏                                         |
| `/hud refresh` | 立即重新读取，并报告用量 API 的结果与横条的宽度     |

## 数字从哪里来

- **Session 与 Weekly** 随每次 API 响应而来（`$.session.usage().rateLimits`）。
- **单个模型的每周窗口（Fable）** 不在响应头里。mod 通过 `$.session.authorize()` 与 `$.http.fetch(url, { auth })` 调用用量卡片读取的同一个端点 `https://api.anthropic.com/api/oauth/usage`：凭证由引擎自己加上，mod 看不到。每分钟最多问一次，在回合结束或窗口变动时。
  - 若设置了 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`，引擎会拒绝这个调用。mod 改读引擎在 `~/.claude.json` 的上一次读数（`cachedUsageUtilization`），以琥珀色 `~53%` 显示，宽度够时加上数据多旧。
- **Cache** 读自会话的 transcript：最后一次主线回复的缓存读取量与它写入的 TTL。

## 开发

```
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p . --noEmit   # 引擎加载过一次之后（它会写出 .claude-plugin/types）
```

不安装直接从文件夹运行：`claude --plugin-dir .`；桌面版启动的会话则把文件夹写进 `CLAUDE_CODE_PLUGIN_DIRS`。
