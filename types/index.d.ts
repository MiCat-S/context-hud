export type HudLimit = {
  kind: string
  percentUsed: number
  resetsAt?: string
  /** The card's title when the server gave one: `Fable` for a model's weekly window. */
  title?: string
  /** When the figure was read, in ms since the epoch, when it is not live: the engine's cache. */
  asOf?: number
}

/** The last main-thread API response, as the session transcript records it. */
export type HudRequest = {
  /** When it was answered, in ms since the epoch. */
  at: number
  /** How long the prompt cache it wrote lives: 1 hour or 5 minutes. */
  ttlMs: number
  /** Share of its input the prompt cache served, 0 to 100. */
  hitPct: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-hud': {
      isHidden: boolean
      /** The response headers' windows: five_hour, seven_day; null before a reading. */
      limits: HudLimit[] | null
      /** The usage endpoint's windows, a model's weekly one (seven_day_fable) included; null before a reading. */
      usageLimits: HudLimit[] | null
      /** How the last usage endpoint call went, as /hud refresh reports it; null before one. */
      usageStatus: string | null
      lastRequest: HudRequest | null
      /** The session's cost so far in USD at API prices, as the engine totals it; null before a reading. */
      cost: number | null
    }
  }
}
