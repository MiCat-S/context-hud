import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HudLimit } from '../types'

import {
  USAGE_URL,
  buildCells,
  formatDuration,
  limitTitle,
  mergeLimits,
  parseEngineCache,
  parseLastRequest,
  parseUsageLimits,
  toLimits,
} from './model'
import { desktopBand, terminalBand } from './view'

/** The cache countdown moves with the clock, not with state. */
const TICK_MS = 5_000
const DEFAULT_TTL_MS = 60 * 60_000
/** The usage endpoint is asked at most this often, short of /hud refresh. */
const USAGE_MIN_INTERVAL_MS = 60_000

const isHidden = atom({ plugin: 'context-hud', key: 'isHidden' } as const, false)
const limits = atom({ plugin: 'context-hud', key: 'limits' } as const, null)
const usageLimits = atom({ plugin: 'context-hud', key: 'usageLimits' } as const, null)
const usageStatus = atom({ plugin: 'context-hud', key: 'usageStatus' } as const, null)
const lastRequest = atom({ plugin: 'context-hud', key: 'lastRequest' } as const, null)
const cost = atom({ plugin: 'context-hud', key: 'cost' } as const, null)

async function refreshLimits($: EngineInterface) {
  const usage = await $.session.usage()
  await update($, limits, () => toLimits(usage.rateLimits))
  if (usage.cost !== undefined) {
    const usd = usage.cost.usd
    await update($, cost, () => usd)
  }
}

let usageAskedAt = -Infinity
let isAskingUsage = false

/** The live reading, or why there is none. */
async function askUsage($: EngineInterface): Promise<{ windows: HudLimit[] } | { reason: string }> {
  try {
    const auth = await $.session.authorize()
    if (auth === null) {
      return { reason: 'no first-party credential' }
    }
    const reply = await $.http.fetch(USAGE_URL, {
      auth: auth.handle,
      headers: { accept: 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
    })
    if (!reply.ok) {
      return { reason: `HTTP ${reply.status}` }
    }
    const windows = parseUsageLimits(reply.text)

    return windows.length === 0 ? { reason: 'no windows in the reply' } : { windows }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    return { reason: message.replace(/^.*?refused: /, 'refused: ') }
  }
}

// The engine's own last reading, kept in .claude.json beside the config dir.
async function readEngineCache($: EngineInterface) {
  try {
    const run = await $.process.run(['sh', '-c', 'cat "${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"'])

    return parseEngineCache(run.stdout)
  } catch {
    return null
  }
}

const describe = (windows: readonly HudLimit[]) =>
  windows.map(limit => `${limitTitle(limit)} ${Math.round(limit.percentUsed)}%`).join(' · ')

// The response headers carry the session and all-models windows alone. A
// model's weekly window (Fable) is the usage endpoint's, as the usage card
// reads it: asked with the session's own credential, which stays with the
// host. Refused (nonessential traffic disabled), the engine's cache stands in,
// its age said.
async function refreshUsage($: EngineInterface, force = false) {
  const now = await $.clock.now()
  if (isAskingUsage || (!force && now - usageAskedAt < USAGE_MIN_INTERVAL_MS)) {
    return
  }
  isAskingUsage = true
  usageAskedAt = now
  try {
    const live = await askUsage($)
    if ('windows' in live) {
      await update($, usageLimits, () => live.windows)
      await update($, usageStatus, () => describe(live.windows))
      return
    }
    const cached = await readEngineCache($)
    if (cached === null) {
      await update($, usageStatus, () => live.reason)
      return
    }
    await update($, usageLimits, () => cached.windows)
    await update($, usageStatus, () => `${live.reason}; showing the engine's cache of ${formatDuration(now - cached.fetchedAt)} ago`)
  } finally {
    isAskingUsage = false
  }
}

/** The band's width as the surface last reported it, for /hud refresh. */
let bandColumns = 0

let isReadingTranscript = false

// The plugin API reports no prompt-cache state, but every API response in the
// session transcript does: when it was answered, what it read from the cache
// and which TTL it wrote.
async function refreshCache($: EngineInterface) {
  if (isReadingTranscript) {
    return
  }
  isReadingTranscript = true
  try {
    const id = await $.session.id()
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      return
    }
    const run = await $.process.run([
      'sh',
      '-c',
      `tail -n 300 "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/${id}.jsonl 2>/dev/null | grep '"cache_creation"' | tail -n 20`,
    ])
    const prev = await read($, lastRequest)
    const next = parseLastRequest(run.stdout.split('\n'), prev?.ttlMs ?? DEFAULT_TTL_MS)
    if (next !== null) {
      await update($, lastRequest, () => next)
    }
  } finally {
    isReadingTranscript = false
  }
}

async function refresh($: EngineInterface, force = false) {
  await Promise.all([
    refreshLimits($).catch(() => undefined),
    refreshUsage($, force).catch(() => undefined),
    refreshCache($).catch(() => undefined),
  ])
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'hud',
      description: 'Context HUD: show or hide the plan and cache columns above the prompt',
      argumentHint: '[on|off|refresh]',
      immediate: true,
    })
    $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
    const started = await next(e)
    await refresh($)

    return started
  })

  // Every priced response moves the cost, so this is also when a new response
  // has landed in the transcript; a window that moved is when the model's did too.
  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    const windows = toLimits(e.rateLimits)
    await update($, limits, () => windows)
    if (e.cost !== undefined) {
      const usd = e.cost.usd
      await update($, cost, () => usd)
    }
    if (e.changed.includes('rateLimits')) {
      await refreshUsage($).catch(() => undefined)
    }
    if (e.changed.includes('cost') || e.changed.includes('context')) {
      await refreshCache($).catch(() => undefined)
    }

    return measured
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId === undefined) {
      await Promise.all([refreshCache($).catch(() => undefined), refreshUsage($).catch(() => undefined)])
    }

    return completed
  })

  // /clear goes on under a new session id, with a transcript of its own.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, limits, () => null)
      await update($, usageLimits, () => null)
      await update($, lastRequest, () => null)
      await update($, cost, () => null)
      $.clock.after(1_000, () => void refresh($, true))
    }

    return next(e)
  })

  on('command.run', { command: 'hud' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'refresh') {
      await refresh($, true)
      const band = bandColumns > 0 ? ` Band: ${bandColumns} columns.` : ''
      return { text: `Context HUD refreshed. Usage API: ${(await read($, usageStatus)) ?? 'not asked'}.${band}` }
    }
    let hide: boolean
    if (arg === 'on' || arg === 'off') {
      hide = arg === 'off'
    } else if (arg === '') {
      hide = !(await read($, isHidden))
    } else {
      return { text: 'Usage: /hud [on|off|refresh]' }
    }
    await update($, isHidden, () => hide)
    if (!hide) {
      await refresh($)
    }

    return { text: `Context HUD: ${hide ? 'off' : 'on'}.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) {
      return next(e)
    }
    const windows = mergeLimits(await read($, limits), await read($, usageLimits))
    const cells = buildCells(windows, await read($, lastRequest), await $.clock.now())
    if (cells.length === 0) {
      return next(e)
    }
    bandColumns = e.props.bodyColumns
    const usd = await read($, cost)
    if (e.surface === 'terminal') {
      return terminalBand($.ui.resolve(e), cells, e.props.bodyColumns, usd)
    }

    return desktopBand($.ui.resolve(e), cells, e.props.bodyColumns, usd)
  })
}
