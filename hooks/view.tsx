import type { ElementTable } from 'claude-code'

import { DESKTOP_RING_CELLS, RED, RING_CELLS, SLOT_GAP, fitCells, pieceText, ringGlyph } from './model'
import type { BarModel, Cell, TextPiece } from './model'

type Basic = Pick<ElementTable<'terminal'>, 'Box' | 'Text'>
type WithSvg = Pick<ElementTable<'desktop'>, 'Box' | 'Text' | 'Svg'>

/** The ring's side, in CSS pixels: about a text line's height. */
const RING_PX = 16
const RING_VIEW = 20
const RING_R = 7
const RING_STROKE = 3
const RING_ROUND = 2 * Math.PI * RING_R
/** When the band reports no width of its own. */
const FALLBACK_COLUMNS = 120
/** The desktop's note: up to two lines of small print, a ring's height. */
const NOTE_H = 18
const NOTE_FONT = 7.5
const NOTE_LINE = 9
/** About what one character of the note's face takes, in CSS pixels. */
const NOTE_CHAR_W = 4.6
const NOTE_DIM = '#8f8f8f'

/** One piece as a Text of its own, a space before it unless it leads. */
function pieceBox({ Box, Text }: Basic, pieces: readonly TextPiece[], i: number) {
  const one = pieces[i]!

  return (
    <Box flexShrink={0}>
      <Text
        {...(one.isBold === true ? { bold: true } : {})}
        {...(one.isDim === true ? { dimColor: true } : {})}
        {...(one.color === undefined ? {} : { color: one.color })}
      >
        {i === 0 ? pieceText(pieces, i) : ` ${pieceText(pieces, i)}`}
      </Text>
    </Box>
  )
}

/**
 * A column's line: its pieces side by side, none of them shrinking or
 * wrapping, so a line too long for its column is cut at the edge, never
 * continued under it. `drawNotes` takes a run of two or more notes (the
 * countdown with a warning under it) to draw as one element instead; a
 * note alone, or without it, is written inline like the rest.
 */
function line(els: Basic, cell: Cell, drawNotes?: (notes: TextPiece[]) => JSX.Element) {
  const { Box } = els
  const parts: JSX.Element[] = []
  for (let i = 0; i < cell.pieces.length; i++) {
    const run = cell.pieces.slice(i).findIndex(one => one.isNote !== true)
    const notes = cell.pieces.slice(i, run === -1 ? undefined : i + run)
    if (drawNotes !== undefined && notes.length >= 2) {
      parts.push(drawNotes(notes))
      i += notes.length - 1
    } else {
      parts.push(pieceBox(els, cell.pieces, i))
    }
  }

  return (
    <Box flexDirection="row" flexWrap="nowrap" overflow="hidden">
      {parts}
    </Box>
  )
}

/**
 * The card's columns spread evenly across one row, each as wide as its ring
 * and line. Short of room the cache column alone gives way, cut at its edge,
 * so the windows and the cost stay whole.
 */
function columns(
  els: Basic,
  cells: Cell[],
  width: number,
  ringCells: number,
  drawRing: (bar: BarModel) => JSX.Element,
  drawNotes?: (notes: TextPiece[]) => JSX.Element,
) {
  const { Box } = els

  return (
    <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" overflow="hidden">
      {fitCells(cells, width, ringCells).map(cell => (
        <Box
          paddingRight={SLOT_GAP}
          flexDirection="row"
          flexWrap="nowrap"
          flexShrink={cell.key === 'cache' ? 1 : 0}
          alignItems="center"
          overflow="hidden"
        >
          {cell.bar === undefined ? null : drawRing(cell.bar)}
          {line(els, cell, drawNotes)}
        </Box>
      ))}
    </Box>
  )
}

const widthOf = (bodyColumns: number) =>
  Number.isFinite(bodyColumns) && bodyColumns > 0 ? bodyColumns : FALLBACK_COLUMNS

const usedShare = (bar: BarModel) =>
  bar.parts.filter(part => part.isShade !== true).reduce((sum, part) => sum + part.share, 0)

// Desktop, editor and phone: each ring a donut a text line tall.

/** A ring filled clockwise from the top by the bar's runs, round-ended, over a faint track. */
function ringSvg(bar: BarModel): string {
  const c = RING_VIEW / 2
  const arcs: string[] = []
  let from = 0
  for (const part of bar.parts) {
    const share = Math.max(0, Math.min(1 - from, part.share))
    if (share > 0) {
      const shade = part.isShade === true ? ' stroke-opacity="0.3"' : ''
      arcs.push(
        `<circle cx="${c}" cy="${c}" r="${RING_R}" fill="none" stroke="${part.color}" stroke-width="${RING_STROKE}"${shade}` +
          ` stroke-linecap="round" stroke-dasharray="${(share * RING_ROUND).toFixed(2)} ${RING_ROUND.toFixed(2)}"` +
          ` stroke-dashoffset="${(-from * RING_ROUND).toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>`,
      )
      from += share
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${RING_PX}" height="${RING_PX}" viewBox="0 0 ${RING_VIEW} ${RING_VIEW}">` +
    `<circle cx="${c}" cy="${c}" r="${RING_R}" fill="none" stroke="#8f8f8f" stroke-opacity="0.22" stroke-width="${RING_STROKE}"/>` +
    `${arcs.join('')}</svg>`
  )
}

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * A run of notes stacked in small print, a ring's height: the countdown over
 * the warning, `2h35m` over `▲ full`.
 */
function notesSvg(notes: readonly TextPiece[]): { source: string; width: number } {
  const width = Math.ceil(Math.max(...notes.map(one => [...one.text].length)) * NOTE_CHAR_W) + 2
  const top = (NOTE_H - notes.length * NOTE_LINE) / 2
  const lines = notes.map((one, i) => {
    const fill = one.color ?? NOTE_DIM
    const y = top + (i + 1) * NOTE_LINE - 2
    return `<text x="0" y="${y.toFixed(1)}" font-size="${NOTE_FONT}" fill="${fill}">${escapeXml(one.text)}</text>`
  })

  return {
    width,
    source:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${NOTE_H}" viewBox="0 0 ${width} ${NOTE_H}"` +
      ` font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif" font-weight="500">` +
      `${lines.join('')}</svg>`,
  }
}

export function desktopBand(els: WithSvg, cells: Cell[], bodyColumns: number) {
  const { Box, Svg } = els

  return columns(
    els,
    cells,
    widthOf(bodyColumns),
    DESKTOP_RING_CELLS,
    bar => (
      <Box marginRight={1} flexShrink={0}>
        <Svg source={ringSvg(bar)} alt={`${Math.round(usedShare(bar) * 100)}%`} width={RING_PX} height={RING_PX} />
      </Box>
    ),
    notes => {
      const { source, width } = notesSvg(notes)
      return (
        <Box marginLeft={1} flexShrink={0}>
          <Svg source={source} alt={notes.map(one => one.text).join(', ')} width={width} height={NOTE_H} />
        </Box>
      )
    },
  )
}

// Terminal: each ring a circle glyph filled by quarters, in the window's color.

export function terminalBand(els: Basic, cells: Cell[], bodyColumns: number) {
  const { Box, Text } = els

  return columns(els, cells, widthOf(bodyColumns), RING_CELLS, bar => (
    <Box flexShrink={0}>
      <Text color={bar.parts[0]?.color ?? 'inactive'}>{`${ringGlyph(bar)} `}</Text>
    </Box>
  ))
}
