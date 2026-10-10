# context-hud

**English** | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

A Claude Code mod for the Claude desktop app (and the terminal): one line above the prompt with your plan's usage windows and the prompt cache, each a ring beside a short line of text.

```
◔ Session 22% ↻ 3h39m   ◑ Weekly 69% ↻ 7h39m   ◑ Fable 53% ↻ 7h39m   ● Cache · 59m · Hit 97%   Cost $6.04
```

| Column  | What it shows                                                                 |
| ------- | ----------------------------------------------------------------------------- |
| Session | The 5-hour window: used %, countdown to its reset, `▲ full in …` when your pace fills it before the reset |
| Weekly  | The 7-day window across all models                                             |
| Fable   | A model's own weekly window, titled as the usage card titles it                |
| Cache   | The prompt cache: minutes left of its TTL, hit rate of the last response, warmth |
| $       | The session's cost so far at API prices, as `/cost` totals it, at the right end |

The ring is the window's use; a fainter run after it is the share of the window already gone by. Where the band is wide enough, each column adds `· Time 54%`, the cache its `· Warm` word and `· Warmth 98%`.

## Install

In a terminal session of Claude Code:

```
/plugin install context-hud --marketplace MiCat-S/context-hud
```

Answer `y` to add the marketplace, then pick the user scope. The mod then runs in every session, the desktop app's included.

## Commands

| Command        | Effect                                                   |
| -------------- | -------------------------------------------------------- |
| `/hud`         | Toggle the band                                          |
| `/hud on|off`  | Show or hide it                                          |
| `/hud refresh` | Re-read everything now and report the usage API's reply and the band's width |

## Where the figures come from

- **Session and Weekly** come with every API response (`$.session.usage().rateLimits`).
- **A model's weekly window (Fable)** is not in the response headers. The mod asks the same usage endpoint the usage card reads, `https://api.anthropic.com/api/oauth/usage`, through `$.session.authorize()` and `$.http.fetch(url, { auth })`: the engine adds the credential itself, the mod never sees it. It is asked at most once a minute, after a turn or when a window moves.
  - With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` the engine refuses that call. The mod then falls back to the engine's own last reading in `~/.claude.json` (`cachedUsageUtilization`), shows the figure as `~53%` in amber and, where there is room, how old it is.
- **Cache** is read from the session transcript: the last main-thread response's cache reads and which TTL it wrote.

## Development

```
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p . --noEmit   # after the engine has loaded the mod once (it writes .claude-plugin/types)
```

Run it from the folder without installing: `claude --plugin-dir .`, or name the folder in `CLAUDE_CODE_PLUGIN_DIRS` for sessions the desktop app starts.
