// The layout file the editor exports: format "claude-terminal-layout", version 1 (see LAYOUT.md).
// This file is the same in checklist/ and cockpit/: plugins install on their own, so neither can import the other's.
// scripts/sync.sh copies it into both and writes layouts/default.json beside it as default-layout.ts; scripts/check.sh
// fails when a copy differs.
import type { EngineInterface } from 'claude-code'

import shipped from './default-layout'

export type Element = {
  key: string
  text?: string
  segments?: { text: string; style?: string[] }[]
  style?: string[]
  spaceBefore?: number
  width?: number
  align?: 'right'
}
export type Line = { key: string; elements: Element[] }
export type Block = { key: string; title?: string; badge?: string; lines: Line[] }
export type Layout = { sidebar: Block[]; bandAbovePrompt: Block[]; turnSummary: Line[]; statusLine: Line[] }

/** One drawn run of text and its style names (g y r c m dim b u tagel). */
export type Piece = { text: string; style: string[] }
/** What a data element shows: its text, or with a style the surface picks (a level color, say). */
export type Value = string | { text: string; style: string[] }

// Keys whose text is the element's own. Every other key is data the surface fills in, or skips.
export const LITERALS = new Set(['text', 'sep', 'emoji', 'mark', 'spacer', 'badge', 'rule', 'bar', 'spark', 'meter'])
const ICONS = new Set(['emoji', 'mark'])
const STYLES = new Set(['g', 'y', 'r', 'c', 'm', 'dim', 'b', 'u', 'tagel', 'spacer'])

export const LAYOUT_FILE = '.claude/terminal-layout.json'

const arr = (a: unknown): unknown[] => (Array.isArray(a) ? a : [])
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
const int = (v: unknown, d: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : d
const styles = (v: unknown): string[] => arr(v).filter((s): s is string => typeof s === 'string' && STYLES.has(s))

function element(o: unknown): Element {
  const e = (o ?? {}) as Record<string, unknown>
  const el: Element = { key: str(e.key, 'text') }
  if (typeof e.text === 'string') el.text = e.text
  if (Array.isArray(e.segments))
    el.segments = e.segments.map(s => ({ text: str((s as { text?: unknown })?.text), style: styles((s as { style?: unknown })?.style) }))
  const st = styles(e.style)
  if (st.length) el.style = st
  if (e.spaceBefore !== undefined) el.spaceBefore = int(e.spaceBefore, 1, 12)
  if (e.width !== undefined) el.width = int(e.width, 0, 40)
  if (e.align === 'right') el.align = 'right'
  return el
}
const line = (o: unknown): Line => {
  const l = (o ?? {}) as Record<string, unknown>
  return { key: str(l.key, 'line'), elements: arr(l.elements).map(element) }
}
const block = (o: unknown): Block => {
  const b = (o ?? {}) as Record<string, unknown>
  return { key: str(b.key, 'custom'), title: str(b.title), ...(typeof b.badge === 'string' && b.badge ? { badge: b.badge } : {}), lines: arr(b.lines).map(line) }
}

/** The layout in `text`, or undefined when it is not a version 1 layout. `parked` is the editor's and is ignored. */
export function parseLayout(text: string): Layout | undefined {
  try {
    return toLayout(JSON.parse(text))
  } catch {
    return undefined
  }
}

export function toLayout(o: unknown): Layout | undefined {
  const j = (o ?? {}) as Record<string, unknown>
  if (j.format !== 'claude-terminal-layout' || j.version !== 1) return undefined
  return {
    sidebar: arr(j.sidebar).map(block),
    bandAbovePrompt: arr(j.bandAbovePrompt).map(block),
    turnSummary: arr(j.turnSummary).map(line),
    statusLine: arr(j.statusLine).map(line),
  }
}

const DEFAULT = toLayout(shipped)!

/** The person's ~/.claude/terminal-layout.json, else the default this plugin ships. Read on each use: the file is small. */
export async function loadLayout($: EngineInterface): Promise<Layout> {
  try {
    const home = await $.env.get('HOME')
    if (home) {
      const own = parseLayout(String(await $.fs.read(`${home}/${LAYOUT_FILE}`)))
      if (own) return own
    }
  } catch {
    // no file of the person's, or not readable: the default stands
  }
  return DEFAULT
}

// Code points below U+1F000 that terminals draw two columns wide (Unicode Emoji_Presentation). statusline.jq holds the same list.
const WIDE: [number, number][] = [[0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55]]

/**
 * Columns a string takes in a terminal: two for an emoji drawn as one (U+1F000 and up, the list above, or any
 * character followed by U+FE0F), none for joiners and variation selectors, one for the rest.
 */
export function width(s: string): number {
  const cps = [...s].map(c => c.codePointAt(0)!)
  let n = 0
  cps.forEach((cp, i) => {
    if (cp === 0x200d || cp === 0xfe0e || cp === 0xfe0f) return
    n += cp >= 0x1f000 || cps[i + 1] === 0xfe0f || WIDE.some(([a, b]) => cp >= a && cp <= b) ? 2 : 1
  })
  return n
}

// Text from the model, other sessions' records or the layout file could carry terminal escapes; none reach the screen.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g
export const printable = (s: string): string => s.replace(CONTROL, '')

type Item = { el: Element; sep: boolean; data: boolean; pieces: Piece[] }

/**
 * Draws one line from `data` (key -> what it shows; missing or '' shows nothing):
 * - an empty data element without a width is left out, with the icons (emoji, mark) right before it and
 *   one separator before those; with a width it stays as blank cells, so columns keep their place;
 * - a separator shows only between two runs that each still hold a data element;
 * - the first element drawn has no space before it.
 */
export function resolveLine(l: Line, data: Record<string, Value | undefined>): Piece[] {
  const items: Item[] = []
  for (const el of l.elements) {
    if (LITERALS.has(el.key)) {
      const pieces = el.segments
        ? el.segments.map(s => ({ text: printable(s.text), style: [...(el.style ?? []), ...(s.style ?? [])] }))
        : [{ text: printable(el.text ?? ''), style: el.style ?? [] }]
      items.push({ el, sep: el.key === 'sep', data: false, pieces })
      continue
    }
    const v = data[el.key]
    const text = printable(typeof v === 'string' ? v : (v?.text ?? ''))
    if (!text) {
      if (el.width) {
        items.push({ el, sep: false, data: false, pieces: [{ text: '', style: [] }] })
        continue
      }
      while (items.length && !items[items.length - 1]!.sep && !items[items.length - 1]!.data && ICONS.has(items[items.length - 1]!.el.key)) items.pop()
      if (items.length && items[items.length - 1]!.sep) items.pop()
      continue
    }
    const style = el.style?.length ? el.style : typeof v === 'string' ? [] : (v?.style ?? [])
    items.push({ el, sep: false, data: true, pieces: [{ text, style }] })
  }

  // Runs between separators; a separator survives only between two runs holding data.
  const runs: { sep?: Item; items: Item[] }[] = [{ items: [] }]
  for (const it of items) {
    if (it.sep) runs.push({ sep: it, items: [] })
    else runs[runs.length - 1]!.items.push(it)
  }
  const kept: Item[] = []
  let prevData: boolean | undefined
  for (const run of runs) {
    if (!run.items.length) continue
    const hasData = run.items.some(i => i.data)
    if (run.sep && prevData && hasData) kept.push(run.sep)
    kept.push(...run.items)
    prevData = hasData
  }

  const out: Piece[] = []
  kept.forEach((it, i) => {
    const space = i === 0 ? 0 : (it.el.spaceBefore ?? 1)
    if (space) out.push({ text: ' '.repeat(space), style: [] })
    const w = it.el.width ?? 0
    const drawn = it.pieces.reduce((n, p) => n + width(p.text), 0)
    const pad = w > drawn ? ' '.repeat(w - drawn) : ''
    if (pad && it.el.align === 'right') out.push({ text: pad, style: [] })
    out.push(...it.pieces.filter(p => p.text))
    if (pad && it.el.align !== 'right') out.push({ text: pad, style: [] })
  })
  return out
}

/** The line as plain text, trailing spaces cut. */
export function plain(pieces: Piece[]): string {
  return pieces
    .map(p => p.text)
    .join('')
    .replace(/\s+$/, '')
}
