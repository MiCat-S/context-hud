import type { SessionRateLimit } from 'claude-code'

import type { HudLimit, HudRequest } from '../types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const TTL_1H = HOUR
const TTL_5M = 5 * MINUTE
/** Too early in the window, one burst projects a false alarm. */
const PACE_MIN_ELAPSED = 5 * MINUTE
/** A reading from the engine's cache older than this says how old it is. */
const STALE_AFTER = 10 * MINUTE

/** The card's four ring columns: the session, the week, a model's week, the cache. */
export const COLUMNS = 4
/** Each ring column's share of the band; what is left at the right holds the cost. */
export const COLUMN_SHARE_PCT = 23
/** Cells kept clear at the right of each column, between it and the next. */
export const SLOT_GAP = 1
/** Cells the terminal's ring takes at the left of a column's line, its space included. */
export const RING_CELLS = 2
/**
 * What the desktop's ring takes, in the band's cells: the drawing and its
 * margin, and the slack a proportional face needs over the band's count.
 */
export const DESKTOP_RING_CELLS = 6

/** Each window's bar, as the card draws them: session green, weekly blue, a model's purple. */
export const LIMIT_COLOR = {
  five_hour: '#5aa65a',
  seven_day: '#4f7fe0',
  model: '#8a6fd6',
  other: '#c9a23c',
}

export const CACHE_COLOR = {
  warm: '#e0883a',
  cooling: '#d8b13c',
  cold: '#5b8fd9',
}

/** The bars' marks: how far a window has gone, how warm the cache still is. */
export const MARK_COLOR = '#d0d0d0'
export const AMBER = '#d8b13c'
export const RED = '#e05252'

/**
 * Where the usage card reads the account's windows. The response headers
 * carry the session and all-models windows alone; a model's weekly window
 * (Fable) is only here, a `limits` row of kind `weekly_scoped`.
 */
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

function limitRank(kind: string): number {
  if (kind === 'five_hour') return 0
  if (kind === 'seven_day') return 1
  if (kind.startsWith('seven_day_')) return 2

  return 3
}

export function toLimits(rateLimits: readonly SessionRateLimit[]): HudLimit[] {
  return rateLimits
    .map(limit => ({
      kind: limit.kind,
      percentUsed: limit.percentUsed,
      ...(limit.resetsAt === undefined ? {} : { resetsAt: limit.resetsAt }),
    }))
    .sort((a, b) => limitRank(a.kind) - limitRank(b.kind))
}

type UsageRow = {
  kind?: string
  percent?: number
  resets_at?: string | null
  scope?: { model?: { id?: string | null; display_name?: string | null } | null } | null
}

/** The usage endpoint's body; the engine's own cache of it wraps it in `utilization`. */
type UsageBody = { limits?: UsageRow[]; utilization?: { limits?: UsageRow[] } }

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

/**
 * The windows the usage endpoint's `limits` rows report, in the card's kinds:
 * `session` as `five_hour`, `weekly_all` as `seven_day`, and each
 * `weekly_scoped` row as `seven_day_<model>`, titled as the card titles it
 * (`Fable`). Empty for a body that is not JSON or has no such rows.
 */
export function parseUsageLimits(text: string, asOf?: number): HudLimit[] {
  let body: UsageBody | null
  try {
    body = JSON.parse(text) as UsageBody | null
  } catch {
    return []
  }

  return usageWindows(body, asOf)
}

function usageWindows(body: UsageBody | null, asOf?: number): HudLimit[] {
  const rows = Array.isArray(body?.limits) ? body.limits : Array.isArray(body?.utilization?.limits) ? body.utilization.limits : []
  const windows: HudLimit[] = []
  for (const row of rows) {
    if (typeof row?.kind !== 'string' || typeof row.percent !== 'number') {
      continue
    }
    let kind: string
    let title: string | undefined
    if (row.kind === 'session') {
      kind = 'five_hour'
    } else if (row.kind === 'weekly_all') {
      kind = 'seven_day'
    } else if (row.kind === 'weekly_scoped') {
      title = row.scope?.model?.display_name ?? row.scope?.model?.id ?? 'Model'
      kind = `seven_day_${slug(title)}`
    } else {
      continue
    }
    windows.push({
      kind,
      percentUsed: row.percent,
      ...(typeof row.resets_at === 'string' ? { resetsAt: row.resets_at } : {}),
      ...(title === undefined ? {} : { title }),
      ...(asOf === undefined ? {} : { asOf }),
    })
  }

  return windows.sort((a, b) => limitRank(a.kind) - limitRank(b.kind))
}

/**
 * The engine's own last reading of the usage endpoint, as `.claude.json` keeps
 * it under `cachedUsageUtilization`: its windows stamped with when it was
 * fetched. Null when the file has none. The fallback when the live call is
 * refused, as it is while nonessential traffic is disabled.
 */
export function parseEngineCache(text: string): { windows: HudLimit[]; fetchedAt: number } | null {
  let cached: { fetchedAtMs?: number; utilization?: { limits?: UsageRow[] } } | undefined
  try {
    cached = (JSON.parse(text) as { cachedUsageUtilization?: typeof cached } | null)?.cachedUsageUtilization
  } catch {
    return null
  }
  if (typeof cached?.fetchedAtMs !== 'number') {
    return null
  }
  const windows = usageWindows(cached, cached.fetchedAtMs)

  return windows.length === 0 ? null : { windows, fetchedAt: cached.fetchedAtMs }
}

/**
 * The response headers' windows, then the usage endpoint's that they lack
 * (a model's weekly window; all of them before the first response), in the
 * card's order. Null before either has a reading.
 */
export function mergeLimits(header: readonly HudLimit[] | null, usage: readonly HudLimit[] | null): HudLimit[] | null {
  if (header === null && usage === null) {
    return null
  }
  const known = new Set((header ?? []).map(limit => limit.kind))

  return [...(header ?? []), ...(usage ?? []).filter(limit => !known.has(limit.kind))].sort(
    (a, b) => limitRank(a.kind) - limitRank(b.kind),
  )
}

type TranscriptRow = {
  type?: string
  isSidechain?: boolean
  timestamp?: string
  message?: {
    usage?: {
      input_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }
    }
  }
}

/**
 * The newest main-thread response among transcript lines (oldest first). A pure
 * cache hit writes nothing, so the TTL is the newest write's; `fallbackTtlMs`
 * when none of the lines wrote.
 */
export function parseLastRequest(lines: readonly string[], fallbackTtlMs: number): HudRequest | null {
  let last: TranscriptRow | null = null
  let ttlMs: number | null = null
  for (let i = lines.length - 1; i >= 0 && ttlMs === null; i--) {
    let row: TranscriptRow | null
    try {
      row = JSON.parse(lines[i]!) as TranscriptRow | null
    } catch {
      continue
    }
    const usage = row?.message?.usage
    if (row?.type !== 'assistant' || row.isSidechain === true || usage === undefined) {
      continue
    }
    last ??= row
    if ((usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0) {
      ttlMs = TTL_1H
    } else if ((usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) > 0) {
      ttlMs = TTL_5M
    }
  }
  const usage = last?.message?.usage
  const at = Date.parse(last?.timestamp ?? '')
  if (usage === undefined || Number.isNaN(at)) {
    return null
  }
  const read = usage.cache_read_input_tokens ?? 0
  const total = (usage.input_tokens ?? 0) + read + (usage.cache_creation_input_tokens ?? 0)

  return { at, ttlMs: ttlMs ?? fallbackTtlMs, hitPct: total > 0 ? (read * 100) / total : 0 }
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, ms)
  if (total >= DAY) {
    const d = Math.floor(total / DAY)
    const h = Math.floor((total % DAY) / HOUR)
    return h === 0 ? `${d}d` : `${d}d${h}h`
  }
  if (total >= HOUR) {
    const h = Math.floor(total / HOUR)
    const m = Math.floor((total % HOUR) / MINUTE)
    return m === 0 ? `${h}h` : `${h}h${m}m`
  }
  if (total >= MINUTE) {
    return `${Math.floor(total / MINUTE)}m`
  }

  return `${Math.ceil(total / 1000)}s`
}

/** The countdown to a reset: `2h18m`, `5d3h`. */
export function formatReset(resetsAt: number, now: number): string {
  return formatDuration(resetsAt - now)
}

const capitalize = (word: string) => (word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1))

function windowMsOf(kind: string): number | null {
  if (kind === 'five_hour') return 5 * HOUR
  if (kind === 'seven_day' || kind.startsWith('seven_day_')) return 7 * DAY

  return null
}

function titleOfKind(kind: string): string {
  if (kind === 'five_hour') return 'Session'
  if (kind === 'seven_day') return 'Weekly'
  if (kind.startsWith('seven_day_')) return kind.slice('seven_day_'.length).split('_').map(capitalize).join(' ')
  if (kind === 'spend_limit') return 'Spend'

  return kind.split('_').map(capitalize).join(' ')
}

/** The card's title for a window: the server's (`Fable`) when it gave one. */
export function limitTitle(limit: HudLimit): string {
  return limit.title ?? titleOfKind(limit.kind)
}

/** `full in 48m` when the 5-hour window fills at the pace so far before it resets. */
export function paceWarning(limit: HudLimit, now: number): string | null {
  if (limit.percentUsed >= 100) {
    return 'full'
  }
  const resetsAt = Date.parse(limit.resetsAt ?? '')
  if (Number.isNaN(resetsAt) || limit.percentUsed <= 0) {
    return null
  }
  const left = resetsAt - now
  const elapsed = 5 * HOUR - left
  if (left <= 0 || elapsed < PACE_MIN_ELAPSED) {
    return null
  }
  const toFull = ((100 - limit.percentUsed) * elapsed) / limit.percentUsed

  return toFull < left ? `full in ${formatDuration(toFull)}` : null
}

export type BarModel = {
  /** Filled runs from the left, in order; a shade is the same hue, fainter. */
  parts: { share: number; color: string; isShade?: boolean }[]
  /** A mark across the bar, 0 to 1; null for none. */
  mark: number | null
  /** Fill the first run with this left-to-right gradient, laid over the whole bar. */
  gradient?: { from: string; to: string }
}

/**
 * One run of a column's line. Pieces carry a rank: short of room the
 * highest rank goes first; rank 0 always stays, and the line is cut at the edge.
 */
export type TextPiece = {
  text: string
  color?: string
  isBold?: boolean
  isDim?: boolean
  rank?: number
}

/** One column of the card: its ring, then its line of text beside it. */
export type Cell = { key: string; pieces: TextPiece[]; bar: BarModel }

const piece = (text: string, style: Omit<TextPiece, 'text'> = {}): TextPiece => ({ text, ...style })

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

function limitColor(kind: string): string {
  if (kind === 'five_hour') return LIMIT_COLOR.five_hour
  if (kind === 'seven_day') return LIMIT_COLOR.seven_day
  if (kind.startsWith('seven_day_')) return LIMIT_COLOR.model

  return LIMIT_COLOR.other
}

/**
 * `Session 34% ↻ 2h18m · Time 54%` beside the window's ring: the ring is the
 * usage, its fainter run the time gone by; the Time figure only where there
 * is room. A figure from the engine's cache reads `~53%` in amber, its age at
 * the end.
 */
function limitCell(limit: HudLimit, now: number): Cell {
  const color = limitColor(limit.kind)
  const percent = Math.max(0, Math.round(limit.percentUsed))
  const used = clamp01(limit.percentUsed / 100)
  const resetsAt = Date.parse(limit.resetsAt ?? '')
  const windowMs = windowMsOf(limit.kind)
  const time = Number.isNaN(resetsAt) || windowMs === null ? null : clamp01(1 - (resetsAt - now) / windowMs)
  const staleMs = limit.asOf === undefined ? 0 : now - limit.asOf
  const isStale = staleMs >= STALE_AFTER

  const pieces = [
    piece(limitTitle(limit), { isBold: true }),
    piece(
      `${isStale ? '~' : ''}${percent}%`,
      isStale ? { color: AMBER } : percent >= 90 ? { color: RED } : percent >= 75 ? { color: AMBER } : {},
    ),
  ]
  if (!Number.isNaN(resetsAt)) {
    pieces.push(piece(`↻ ${formatReset(resetsAt, now)}`, { isDim: true }))
  }
  if (time !== null) {
    pieces.push(piece(`· Time ${Math.round(time * 100)}%`, { isDim: true, rank: 1 }))
  }
  if (isStale) {
    pieces.push(piece(`· ${formatDuration(staleMs)} ago`, { color: AMBER, rank: 1 }))
  }
  if (limit.kind === 'five_hour') {
    const warning = paceWarning(limit, now)
    if (warning !== null) {
      pieces.push(piece(`▲ ${warning}`, { color: RED }))
    }
  }

  // Used, then the stretch of the window gone by beyond it, fainter; the mark is the time.
  const bar: BarModel = {
    parts: [{ share: used, color }, ...(time !== null && time > used ? [{ share: time - used, color, isShade: true }] : [])],
    mark: time,
  }

  return { key: limit.kind, pieces, bar }
}

/**
 * `Cache · Warm · 59m · Hit 99% · Warmth 98%` beside the warmth ring. Short
 * of room Warmth goes first (the ring says it), then the status word (the
 * ring's color and the minutes left say it).
 */
function cacheCell(request: HudRequest, now: number): Cell {
  const leftMs = Math.max(0, request.at + request.ttlMs - now)
  const warmth = request.ttlMs > 0 ? leftMs / request.ttlMs : 0
  const status = leftMs <= 0 ? 'cold' : warmth < 0.25 ? 'cooling' : 'warm'
  const left = leftMs >= MINUTE || leftMs === 0 ? `${Math.floor(leftMs / MINUTE)}m` : `${Math.ceil(leftMs / 1000)}s`

  return {
    key: 'cache',
    pieces: [
      piece('Cache', { isBold: true }),
      piece(`· ${capitalize(status)}`, { isBold: true, color: CACHE_COLOR[status], rank: 1 }),
      piece(`· ${left}`, { isDim: true }),
      piece(`· Hit ${Math.round(request.hitPct)}%`, { isDim: true }),
      piece(`· Warmth ${Math.round(warmth * 100)}%`, { isDim: true, rank: 2 }),
    ],
    // The ring's fill is the warmth itself: no mark across it.
    bar: {
      parts: [{ share: warmth, color: CACHE_COLOR[status] }],
      mark: null,
      gradient: { from: CACHE_COLOR.cold, to: CACHE_COLOR.warm },
    },
  }
}

/** The columns in the card's order: the session, the week, a model's week, the cache. */
export function buildCells(limits: readonly HudLimit[] | null, request: HudRequest | null, now: number): Cell[] {
  const windows = limits ?? []
  const pick = (match: (kind: string) => boolean) => windows.find(limit => match(limit.kind))
  const cells = [
    pick(kind => kind === 'five_hour'),
    pick(kind => kind === 'seven_day'),
    pick(kind => kind !== 'five_hour' && kind !== 'seven_day'),
  ].flatMap(limit => (limit === undefined ? [] : [limitCell(limit, now)]))
  if (request !== null) {
    cells.push(cacheCell(request, now))
  }

  return cells
}

/** How many character cells a column's line takes, a space between pieces. */
export function lineWidth(pieces: readonly TextPiece[]): number {
  return pieces.reduce((sum, one) => sum + [...one.text].length, 0) + Math.max(0, pieces.length - 1)
}

const keepBelow = (pieces: readonly TextPiece[], rank: number) => pieces.filter(one => (one.rank ?? 0) < rank)

/** The lowest rank to drop from so the line fits `width`; Infinity when it fits whole. */
function dropFrom(pieces: readonly TextPiece[], width: number): number {
  const ranks = [...new Set(pieces.map(one => one.rank ?? 0))].filter(rank => rank > 0).sort((a, b) => b - a)
  let from = Infinity
  for (const rank of ranks) {
    if (lineWidth(keepBelow(pieces, from)) <= width) {
      return from
    }
    from = rank
  }

  return from
}

/** Cells one column's line holds, less its ring at the left and the gap at its right. */
export const columnWidth = (width: number, ringCells = RING_CELLS) =>
  Math.floor((width * COLUMN_SHARE_PCT) / 100) - ringCells - SLOT_GAP

/** The session's cost at API prices, as /cost totals it: `$1.23`. */
export const formatCost = (usd: number) => `$${Math.max(0, usd).toFixed(2)}`

/** The terminal's ring: a circle filled by quarters with the window's use. */
export function ringGlyph(bar: BarModel): string {
  const used = bar.parts.filter(part => part.isShade !== true).reduce((sum, part) => sum + part.share, 0)
  if (used <= 0) return '○'
  if (used < 0.375) return '◔'
  if (used < 0.625) return '◑'
  if (used < 0.875) return '◕'

  return '●'
}

/**
 * Each column's line fitted to its width; the windows drop the same pieces
 * together, so they read alike. What still runs over ends in `…`.
 */
export function fitCells(cells: readonly Cell[], width: number, ringCells = RING_CELLS): Cell[] {
  const room = columnWidth(width, ringCells)
  const windows = cells.filter(cell => cell.key !== 'cache')
  const from = Math.min(Infinity, ...windows.map(cell => dropFrom(cell.pieces, room)))

  return cells.map(cell => ({
    ...cell,
    pieces: keepBelow(cell.pieces, cell.key === 'cache' ? dropFrom(cell.pieces, room) : from),
  }))
}

export function lineText(pieces: readonly TextPiece[]): string {
  return pieces.map(one => one.text).join(' ')
}
