// The bars, icons and rows the band draws: SVG for the desktop, glyphs for the terminal.

import type { BoxProps, ElementConstructor, RenderElement, TextProps } from 'claude-code'
import type { LimitRow } from '../types'
import type { StageStatus } from './stages'
import { BAR_HEIGHT, DONE_HEX, FAINT_HEX, LABELS, MUTED_HEX, SMART_MAX, SPARK_HEX, TRACK_HEX, USED, USED_HEX, ZONE_HEX, contextZone } from './theme'

/** Claude's spark, thinking: rays that pulse in turn while the whole turns. */
export function sparkSvg(size: number): string {
  const rays = Array.from({ length: 12 }, (_, i) => {
    const len = i % 2 === 0 ? 10 : 6.5
    const begin = ((i * 0.1) % 1.2).toFixed(1)
    return (
      `<line x1="12" y1="10.5" x2="12" y2="${12 - len}" transform="rotate(${i * 30} 12 12)">` +
      `<animate attributeName="opacity" values="1;0.3;1" dur="1.2s" begin="${begin}s" repeatCount="indefinite"/></line>`
    )
  })
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">` +
    `<g stroke="${SPARK_HEX}" stroke-width="2.1" stroke-linecap="round">` +
    `<animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="8s" repeatCount="indefinite"/>` +
    rays.join('') +
    `</g></svg>`
  )
}

export const STAGE_GLYPHS: Record<StageStatus, string> = { done: '✓', skipped: '⊘', ahead: '○' }
export const STAGE_ICON_PX = 14

/** A stage's status icon, drawn as an image: a filled check, a slashed circle, a ring. */
export function stageIconSvg(status: StageStatus, size: number): string {
  const shape =
    status === 'done'
      ? `<circle cx="8" cy="8" r="7" fill="${DONE_HEX}"/>` +
        `<path d="M4.6 8.3l2.2 2.2 4.6-4.8" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
      : status === 'skipped'
        ? `<circle cx="8" cy="8" r="6.2" fill="none" stroke="${MUTED_HEX}" stroke-width="1.6"/>` +
          `<path d="M3.6 12.4l8.8-8.8" stroke="${MUTED_HEX}" stroke-width="1.6" stroke-linecap="round"/>`
        : `<circle cx="8" cy="8" r="6.2" fill="none" stroke="${FAINT_HEX}" stroke-width="1.4"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16">${shape}</svg>`
}

/** Cells of a bar: used, and left. A use that is not zero is at least `min` long, so it shows. */
export function cells(pct: number, width: number, min = 1, step = 1) {
  const clamp = (n: number) => Math.max(0, Math.min(width, n))
  let used = clamp(Math.round((pct / 100) * width / step) * step)
  if (pct > 0 && used < min) used = Math.min(min, width)
  return { used, rest: width - used }
}

/** A thin bar drawn as Claude Code's context window bar is: a track, the used part over it. */
export function barSvg(pct: number, width: number): string {
  const h = BAR_HEIGHT
  const r = h / 2
  const { used } = cells(pct, width, h, 0.5)
  const round = (n: number) => Math.round(n * 10) / 10
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">`,
    `<rect width="${width}" height="${h}" rx="${r}" fill="${TRACK_HEX}"/>`,
    used > 0 ? `<rect width="${round(used)}" height="${h}" rx="${round(Math.min(r, used / 2))}" fill="${USED_HEX}"/>` : '',
    `</svg>`,
  ].join('')
}

/** The context bar: its fill in the zone's color, a tick where the smart zone ends. */
export function contextBarSvg(tokens: number, window: number, width: number, compactAt?: number): string {
  const h = BAR_HEIGHT
  const r = h / 2
  const pct = window > 0 ? (tokens / window) * 100 : 0
  const { used } = cells(pct, width, h, 0.5)
  const round = (n: number) => Math.round(n * 10) / 10
  const tick = window > SMART_MAX ? round((SMART_MAX / window) * width) : null
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">`,
    `<rect width="${width}" height="${h}" rx="${r}" fill="${TRACK_HEX}"/>`,
    used > 0
      ? `<rect width="${round(used)}" height="${h}" rx="${round(Math.min(r, used / 2))}" fill="${ZONE_HEX[contextZone(tokens, window, compactAt)]}"/>`
      : '',
    tick === null ? '' : `<rect x="${tick}" width="1" height="${h}" fill="${MUTED_HEX}"/>`,
    `</svg>`,
  ].join('')
}

function severity(pct: number): string {
  if (pct >= 90) return 'error'
  if (pct >= 70) return 'warning'
  return 'text'
}

/** A bar as line glyphs, for the terminal, which draws no SVG. */
export function textBar(Box: ElementConstructor<BoxProps>, Text: ElementConstructor<TextProps>, r: LimitRow, width: number) {
  const c = cells(r.percentUsed, width)
  return (
    <Box flexDirection="row">
      <Text color={USED}>{'━'.repeat(c.used)}</Text>
      <Text color={TRACK_HEX}>{'─'.repeat(c.rest)}</Text>
    </Box>
  )
}

/** A limit row's left part: its name, bar and percentage. */
export function limitLine(
  Box: ElementConstructor<BoxProps>,
  Text: ElementConstructor<TextProps>,
  r: LimitRow,
  bar: RenderElement,
): RenderElement {
  return (
    <Box key={`limit-${r.kind}`} flexDirection="row" alignItems="center" gap={1}>
      <Box width={11}>
        <Text bold>{LABELS[r.kind] ?? r.kind}</Text>
      </Box>
      {bar}
      <Box width={4}>
        <Text color={severity(r.percentUsed)} bold>{`${Math.round(r.percentUsed)}%`}</Text>
      </Box>
    </Box>
  )
}

/**
 * A row of the right-hand column (resets, thinking): label, value and a note,
 * each in a column of its own so every row's parts line up.
 */
export function sideLine(
  Box: ElementConstructor<BoxProps>,
  Text: ElementConstructor<TextProps>,
  key: string,
  label: string,
  value: RenderElement,
  note: RenderElement,
): RenderElement {
  return (
    <Box key={key} flexDirection="row" alignItems="center" gap={1}>
      <Text dimColor>│</Text>
      <Box width={8}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box width={9}>{value}</Box>
      {note}
    </Box>
  )
}
