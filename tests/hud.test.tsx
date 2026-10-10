import type { SessionRateLimit, SessionUsage } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import {
  AMBER,
  CACHE_COLOR,
  LIMIT_COLOR,
  RED,
  buildCells,
  fitCells,
  formatReset,
  lineText,
  mergeLimits,
  paceWarning,
  parseEngineCache,
  parseLastRequest,
  parseUsageLimits,
  ringGlyph,
  toLimits,
} from '../hooks/model'
import type { Cell } from '../hooks/model'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 9, 10, 12, 0)
const iso = (ms: number) => new Date(ms).toISOString()

const rateLimits: SessionRateLimit[] = [
  { kind: 'seven_day', percentUsed: 23, resetsAt: iso(NOW + 5 * DAY) },
  { kind: 'five_hour', percentUsed: 34, resetsAt: iso(NOW + 2 * HOUR + 18 * MINUTE) },
]

// The usage endpoint's body, as the card reads it: the headers' two windows
// (here a point behind them) and the model's weekly window, which only it has.
const usageBody = JSON.stringify({
  five_hour: { utilization: 33, resets_at: iso(NOW + 2 * HOUR + 18 * MINUTE) },
  seven_day: { utilization: 22, resets_at: iso(NOW + 5 * DAY) },
  seven_day_opus: null,
  limits: [
    { kind: 'session', group: 'session', percent: 33, severity: 'normal', resets_at: iso(NOW + 2 * HOUR + 18 * MINUTE), scope: null, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 22, severity: 'normal', resets_at: iso(NOW + 5 * DAY), scope: null, is_active: false },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 9,
      severity: 'normal',
      resets_at: iso(NOW + 5 * DAY),
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: false,
    },
  ],
})
const limits = () => mergeLimits(toLimits(rateLimits), parseUsageLimits(usageBody))

/** .claude.json as the engine keeps its last reading of the endpoint, a day old. */
const CACHE_AT = NOW - 23 * HOUR
const engineCache = JSON.stringify({
  numStartups: 3,
  cachedUsageUtilization: { fetchedAtMs: CACHE_AT, accountUuid: 'acct', utilization: JSON.parse(usageBody) },
})

const usage: SessionUsage = {
  startedAt: NOW - HOUR,
  context: { tokens: 484_000, window: 1_000_000, percent: 48 },
  rateLimits,
  cost: { usd: 1.23 },
}

type Written = { h1?: number; m5?: number }
const response = (at: number, input: number, read: number, written: Written, isSidechain = false) =>
  JSON.stringify({
    type: 'assistant',
    isSidechain,
    timestamp: iso(at),
    message: {
      model: 'claude-opus-5-5',
      usage: {
        input_tokens: input,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: (written.h1 ?? 0) + (written.m5 ?? 0),
        cache_creation: { ephemeral_1h_input_tokens: written.h1 ?? 0, ephemeral_5m_input_tokens: written.m5 ?? 0 },
      },
    },
  })

// The last main-thread response is a pure hit; the TTL comes from the write before it.
const transcript = [
  response(NOW - 3 * MINUTE, 2, 100_000, { h1: 4_000 }),
  response(NOW - 1.2 * MINUTE, 8_000, 92_000, {}),
  response(NOW, 5, 0, { m5: 9_000 }, true),
  'not json',
  '',
]

const cells = (request = parseLastRequest(transcript, HOUR), costUsd: number | null = null) =>
  buildCells(limits(), request, NOW, costUsd)
const byKey = (list: Cell[], key: string) => list.find(cell => cell.key === key)!
const textOf = (list: Cell[], key: string) => lineText(byKey(list, key).pieces)

describe('model', () => {
  test('reads the windows in the card order', async () => {
    expect(toLimits(rateLimits).map(limit => limit.kind)).toEqual(['five_hour', 'seven_day'])
  })

  test("reads the model's weekly window from the usage endpoint, under the headers' windows", async () => {
    const fromUsage = parseUsageLimits(usageBody)
    expect(fromUsage).toEqual([
      { kind: 'five_hour', percentUsed: 33, resetsAt: iso(NOW + 2 * HOUR + 18 * MINUTE) },
      { kind: 'seven_day', percentUsed: 22, resetsAt: iso(NOW + 5 * DAY) },
      { kind: 'seven_day_fable', percentUsed: 9, resetsAt: iso(NOW + 5 * DAY), title: 'Fable' },
    ])
    // The engine's own cache of the body wraps it; a body that is not JSON has no windows.
    expect(parseUsageLimits(JSON.stringify({ utilization: JSON.parse(usageBody) }))).toEqual(fromUsage)
    expect(parseUsageLimits('<html>')).toEqual([])
    expect(parseUsageLimits('{}')).toEqual([])

    // The headers' figures stand where both have one; the model's comes from the endpoint.
    expect(limits()?.map(limit => [limit.kind, limit.percentUsed])).toEqual([
      ['five_hour', 34],
      ['seven_day', 23],
      ['seven_day_fable', 9],
    ])
    // Before the first response the endpoint's windows stand alone; before either, nothing.
    expect(mergeLimits(null, fromUsage)?.map(limit => limit.kind)).toEqual(['five_hour', 'seven_day', 'seven_day_fable'])
    expect(mergeLimits(null, null)).toBeNull()
  })

  test("the engine's cache reads the same, stamped with its age", async () => {
    const cached = parseEngineCache(engineCache)
    expect(cached?.fetchedAt).toBe(CACHE_AT)
    expect(cached?.windows.map(limit => [limit.kind, limit.percentUsed, limit.asOf])).toEqual([
      ['five_hour', 33, CACHE_AT],
      ['seven_day', 22, CACHE_AT],
      ['seven_day_fable', 9, CACHE_AT],
    ])
    expect(parseEngineCache('{}')).toBeNull()
    expect(parseEngineCache('nope')).toBeNull()

    // Older than ten minutes the figure reads `~9%` in amber, its age last, where there is room.
    const stale = buildCells(mergeLimits(toLimits(rateLimits), cached!.windows), null, NOW)
    expect(textOf(stale, 'seven_day_fable')).toBe('Fable ~9% ↻ 5d · Time 29% · 23h ago')
    expect(byKey(stale, 'seven_day_fable').pieces[1]).toEqual({ text: '~9%', color: AMBER })
    expect(textOf(fitCells(stale, 80), 'seven_day_fable')).toBe('Fable ~9% ↻ 5d')
    const fresh = buildCells(parseUsageLimits(usageBody, NOW - MINUTE), null, NOW)
    expect(textOf(fresh, 'seven_day_fable')).toBe('Fable 9% ↻ 5d · Time 29%')
  })

  test('reads the last main-thread request from the transcript', async () => {
    expect(parseLastRequest(transcript, 5 * MINUTE)).toEqual({ at: NOW - 1.2 * MINUTE, ttlMs: HOUR, hitPct: 92 })
    const short = parseLastRequest([response(NOW - MINUTE, 0, 50_000, { m5: 50_000 })], HOUR)
    expect(short?.ttlMs).toBe(5 * MINUTE)
    expect(short?.hitPct).toBe(50)
    expect(parseLastRequest(['', 'garbage'], HOUR)).toBeNull()
  })

  test('warns when the 5-hour window fills before it resets', async () => {
    // Two hours in, 60% used: the last 40% goes in 1h 20m, before the reset in 3h.
    expect(paceWarning({ kind: 'five_hour', percentUsed: 60, resetsAt: iso(NOW + 3 * HOUR) }, NOW)).toBe(
      'full in 1h20m',
    )
    expect(paceWarning({ kind: 'five_hour', percentUsed: 20, resetsAt: iso(NOW + 3 * HOUR) }, NOW)).toBeNull()
    expect(
      paceWarning({ kind: 'five_hour', percentUsed: 3, resetsAt: iso(NOW + 5 * HOUR - 2 * MINUTE) }, NOW),
    ).toBeNull()
    expect(paceWarning({ kind: 'five_hour', percentUsed: 100, resetsAt: iso(NOW + HOUR) }, NOW)).toBe('full')
  })

  test('resets read as a countdown, in days past a day', async () => {
    expect(formatReset(NOW + 2 * HOUR + 18 * MINUTE, NOW)).toBe('2h18m')
    expect(formatReset(NOW + 2 * DAY + 3 * HOUR + 7 * MINUTE, NOW)).toBe('2d3h')
    expect(formatReset(NOW + 5 * DAY, NOW)).toBe('5d')
    expect(formatReset(NOW + 40_000, NOW)).toBe('40s')
  })

  test('each column reads short, on one line, the ring beside it', async () => {
    const list = cells()
    expect(list.map(cell => cell.key)).toEqual(['five_hour', 'seven_day', 'seven_day_fable', 'cache'])
    expect(textOf(list, 'five_hour')).toBe('Session 34% ↻ 2h18m · Time 54%')
    expect(textOf(list, 'seven_day')).toBe('Weekly 23% ↻ 5d · Time 29%')
    expect(textOf(list, 'seven_day_fable')).toBe('Fable 9% ↻ 5d · Time 29%')
    expect(textOf(list, 'cache')).toBe('Cache · Warm · 58m · Hit 92% · Warmth 98%')

    const cache = (request: Parameters<typeof cells>[0]) => textOf(cells(request), 'cache')
    expect(cache({ at: NOW - 50 * MINUTE, ttlMs: HOUR, hitPct: 99 })).toBe('Cache · Cooling · 10m · Hit 99% · Warmth 17%')
    expect(cache({ at: NOW - 2 * HOUR, ttlMs: HOUR, hitPct: 10 })).toBe('Cache · Cold · 0m · Hit 10% · Warmth 0%')
    expect(cache({ at: NOW - MINUTE, ttlMs: 5 * MINUTE, hitPct: 5 })).toBe('Cache · Warm · 4m · Hit 5% · Warmth 80%')

    const busy = buildCells([{ kind: 'five_hour', percentUsed: 92, resetsAt: iso(NOW + 30 * MINUTE) }], null, NOW)
    expect(textOf(busy, 'five_hour')).toBe('Session 92% ↻ 30m · Time 90% ▲ full in 23m')
    expect(byKey(busy, 'five_hour').pieces[1]).toEqual({ text: '92%', color: RED })

    // The terminal's ring fills by quarters with the use; anything used shows a quarter.
    expect(list.map(cell => ringGlyph(cell.bar!))).toEqual(['◔', '◔', '◔', '●'])
    expect(ringGlyph({ parts: [], mark: null })).toBe('○')
    expect(ringGlyph(byKey(busy, 'five_hour').bar!)).toBe('●')

    // The cost closes the row, with no ring, and only beside the others.
    const priced = cells(undefined, 1.23)
    expect(priced.map(cell => cell.key)).toEqual(['five_hour', 'seven_day', 'seven_day_fable', 'cache', 'cost'])
    expect(textOf(priced, 'cost')).toBe('Cost $1.23')
    expect(byKey(priced, 'cost').bar).toBeUndefined()
    expect(buildCells(null, null, NOW, 1.23)).toEqual([])

    // No model window: the cache takes the next column. Nothing at all: no columns.
    expect(buildCells(toLimits(rateLimits), null, NOW).map(cell => cell.key)).toEqual(['five_hour', 'seven_day'])
    expect(buildCells(null, null, NOW)).toEqual([])
  })

  test('each bar in the card colors', async () => {
    const list = cells()
    // Used in the window's own hue, the time gone by beyond it fainter, the mark at the time.
    const session = byKey(list, 'five_hour').bar!
    expect(session.parts.map(part => [part.color, part.isShade === true])).toEqual([
      [LIMIT_COLOR.five_hour, false],
      [LIMIT_COLOR.five_hour, true],
    ])
    expect(Math.round(session.parts[0]!.share * 100)).toBe(34)
    expect(Math.round(session.mark! * 100)).toBe(54)
    expect(byKey(list, 'seven_day').bar?.parts[0]?.color).toBe(LIMIT_COLOR.seven_day)
    expect(byKey(list, 'seven_day_fable').bar?.parts[0]?.color).toBe(LIMIT_COLOR.model)

    const cache = byKey(list, 'cache').bar!
    expect(cache.gradient).toEqual({ from: CACHE_COLOR.cold, to: CACHE_COLOR.warm })
    expect(Math.round(cache.parts[0]!.share * 100)).toBe(98)
    expect(cache.mark).toBeNull()
  })

  test('short of room every column drops its Time and Warmth figures, then the cache its word', async () => {
    const priced = () => cells(undefined, 1.23)
    const wide = fitCells(priced(), 260)
    expect(textOf(wide, 'five_hour')).toBe('Session 34% ↻ 2h18m · Time 54%')
    expect(textOf(wide, 'cache')).toBe('Cache · Warm · 58m · Hit 92% · Warmth 98%')
    expect(textOf(wide, 'cost')).toBe('Cost $1.23')

    // 120 columns on the terminal: 107 cells for the lines after the rings and gaps; whole they take 131.
    const narrow = fitCells(priced(), 120)
    expect(textOf(narrow, 'five_hour')).toBe('Session 34% ↻ 2h18m')
    expect(textOf(narrow, 'seven_day')).toBe('Weekly 23% ↻ 5d')
    expect(textOf(narrow, 'seven_day_fable')).toBe('Fable 9% ↻ 5d')
    expect(textOf(narrow, 'cache')).toBe('Cache · Warm · 58m · Hit 92%')
    expect(textOf(narrow, 'cost')).toBe('Cost $1.23')

    // 90 columns: 77 cells; the lines take 85, so the cache's word goes too. The cost stays whole.
    const tight = fitCells(priced(), 90)
    expect(textOf(tight, 'five_hour')).toBe('Session 34% ↻ 2h18m')
    expect(textOf(tight, 'cache')).toBe('Cache · 58m · Hit 92%')
    expect(textOf(tight, 'cost')).toBe('Cost $1.23')

    // The desktop's ring takes more of the band's cells: 112 columns there leave 83.
    const desktop = fitCells(priced(), 112, 6)
    expect(textOf(desktop, 'five_hour')).toBe('Session 34% ↻ 2h18m')
    expect(textOf(desktop, 'cache')).toBe('Cache · 58m · Hit 92%')
    expect(textOf(desktop, 'cost')).toBe('Cost $1.23')
  })
})

const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 140 } } as const

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 30,
    bodyColumns: 140,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

/** The usage endpoint as the host answers it, the session's handle on the request. */
function mockUsageEndpoint(on: Parameters<TestBody>[1], asked: { url: string; auth?: string }[] = []) {
  on('session.authorize', () => ({ value: { handle: 'handle-1', kind: 'bearer' } }))
  on('http.fetch', ($, e) => {
    asked.push({ url: e.url, ...(e.init?.auth === undefined ? {} : { auth: e.init.auth }) })
    return { value: { status: 200, ok: true, headers: { 'content-type': 'application/json' }, text: usageBody } }
  })

  return asked
}

test('the band draws four columns, a ring then a line of text in each, one row', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: '6c3a2a37-a2dc-44ee-a9c3-e8d209722788' }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: transcript.join('\n'), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.usage', () => ({ value: usage }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  const asked = mockUsageEndpoint(on)
  await $.session.measure({
    context: usage.context,
    rateLimits,
    cost: { usd: 1.23 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  expect(asked).toEqual([{ url: 'https://api.anthropic.com/api/oauth/usage', auth: 'handle-1' }])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-hud', surface, ...BAND })
    const boxes = await ui.findAll({ type: 'Box' })
    expect([boxes[0]?.props.flexDirection, boxes[0]?.props.justifyContent]).toEqual(['row', 'space-between'])
    // Five columns spread across the row, each a row of its own: ring, then line,
    // centered on each other; only the cache's gives way when the row is short.
    const columns = boxes.filter(box => box.props.alignItems === 'center')
    expect(columns.map(box => [box.props.flexDirection, box.props.flexShrink, box.props.overflow])).toEqual([
      ['row', 0, 'hidden'],
      ['row', 0, 'hidden'],
      ['row', 0, 'hidden'],
      ['row', 1, 'hidden'],
      ['row', 0, 'hidden'],
    ])
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    // 140 columns: the lines take 131 whole, over the 127 the terminal leaves and
    // the 111 the desktop does, so every Time and Warmth figure goes on both. A
    // line is its pieces side by side, each a Text of its own that neither shrinks
    // nor wraps. The cost closes the row.
    const texts = await ui.findAll({ type: 'Text' })
    const joined = texts.map(one => one.text).join('')
    expect(joined).toContain('Session 34% ↻ 2h18m')
    expect(joined).toContain('Fable 9% ↻ 5d')
    expect(joined).toContain('Cache · Warm · 58m · Hit 92%Cost $1.23')
    expect(joined).not.toContain('Time')
    expect(texts.slice(-2).map(one => one.text)).toEqual(['Cost', ' $1.23'])
    if (surface === 'desktop') {
      // Each ring a thick donut a text line tall, filled by the use; no notch.
      const svgs = await ui.findAll({ type: 'Svg' })
      expect(svgs.map(svg => [svg.props.width, svg.props.height, svg.props.alt])).toEqual([
        [16, 16, '34%'],
        [16, 16, '23%'],
        [16, 16, '9%'],
        [16, 16, '98%'],
      ])
      expect(String(svgs[0]?.props.source)).toContain('stroke-dasharray=')
      expect(String(svgs[0]?.props.source)).toContain('stroke-linecap="round"')
      expect(String(svgs[0]?.props.source)).not.toContain('<line ')
    } else {
      // Each ring a circle glyph filled by quarters, a space after it.
      const rings = (await ui.findAll({ type: 'Text' })).filter(one => /^[○◔◑◕●] $/.test(one.text))
      expect(rings.map(one => one.text)).toEqual(['◔ ', '◔ ', '◔ ', '● '])
    }
    await ui.unmount()
  }
})

test('/hud hides and shows the band', async ($, on) => {
  mock.clock(on, { now: NOW })
  // What the engine draws in the band when no plugin has anything to show.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('session.usage', () => ({ value: usage }))
  mockUsageEndpoint(on)
  const off = await $.command.run({ command: 'hud', args: 'off', ...TYPED })
  expect(off.text).toBe('Context HUD: off.')
  const ui = await $.ui.mount({ plugin: 'context-hud', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  const shown = await $.command.run({ command: 'hud', args: '', ...TYPED })
  expect(shown.text).toBe('Context HUD: on.')
  expect(await ui.find({ type: 'Text' })).toBeDefined()
  await ui.unmount()
})

test('/hud refresh asks the usage endpoint again and says what it answered', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.usage', () => ({ value: usage }))
  const asked = mockUsageEndpoint(on)
  const first = await $.command.run({ command: 'hud', args: 'refresh', ...TYPED })
  expect(first.text).toBe('Context HUD refreshed. Usage API: Session 33% · Weekly 22% · Fable 9%.')
  // Forced: not held back by the minute between asks.
  await $.command.run({ command: 'hud', args: 'refresh', ...TYPED })
  expect(asked.length).toBe(2)
})

test("refused the live call, the band shows the engine's cache and says how old it is", async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: '6c3a2a37-a2dc-44ee-a9c3-e8d209722788' }))
  on('session.usage', () => ({ value: usage }))
  on('session.authorize', () => ({ value: { handle: 'handle-1', kind: 'bearer' } }))
  // As the engine refuses it while CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set.
  on('http.fetch', () => ({
    deny: "the session's credential is withheld: nonessential network traffic is disabled for this session.",
  }))
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.some(arg => arg.includes('.claude.json')) ? engineCache : transcript.join('\n'),
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  const refreshed = await $.command.run({ command: 'hud', args: 'refresh', ...TYPED })
  expect(refreshed.text).toMatch(
    /^Context HUD refreshed\. Usage API: .*credential is withheld.*; showing the engine's cache of 23h ago\.$/,
  )
  const ui = await $.ui.mount({ plugin: 'context-hud', surface: 'desktop', ...BAND })
  const columns = (await ui.findAll({ type: 'Box' })).filter(box => box.props.alignItems === 'center')
  expect(columns.map(box => box.props.flexShrink)).toEqual([0, 0, 0, 1, 0])
  // The cached figure reads `~9%`; at this width its age has gone with the Time figure.
  const joined = (await ui.findAll({ type: 'Text' })).map(one => one.text).join('')
  expect(joined).toContain('Fable ~9% ↻ 5d')
  await ui.unmount()
})

test('without a first-party credential the band keeps to the headers', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.usage', () => ({ value: usage }))
  on('session.authorize', () => ({ value: null }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const refreshed = await $.command.run({ command: 'hud', args: 'refresh', ...TYPED })
  expect(refreshed.text).toBe('Context HUD refreshed. Usage API: no first-party credential.')
  const ui = await $.ui.mount({ plugin: 'context-hud', surface: 'terminal', ...BAND })
  const boxes = (await ui.findAll({ type: 'Box' })).filter(box => box.props.alignItems === 'center')
  expect(boxes.length).toBe(3)
  const joined = (await ui.findAll({ type: 'Text' })).map(one => one.text).join('')
  // Three columns leave room for the Time figures; the cost still closes the row.
  expect(joined).toContain('Weekly 23% ↻ 5d · Time 29%Cost $1.23')
  await ui.unmount()
})
