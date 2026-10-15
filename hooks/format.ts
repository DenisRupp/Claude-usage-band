// Numbers, times and token counts as the band writes them.

import type { ModelUsage } from 'claude-code'
import type { Tokens } from '../types'

/** No tokens at all. */
export const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** Token counts the short way: `950`, `132k`, `1M`, `1.2M`. */
export function fmtCompact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  const m = n / 1_000_000
  return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
}
export function addUsage(t: Tokens, u: ModelUsage): Tokens {
  return {
    input: t.input + u.input_tokens,
    output: t.output + u.output_tokens,
    cacheRead: t.cacheRead + u.cache_read_input_tokens,
    cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
  }
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** How long until a window resets: `in 3d 21h`, `in 2h 5m`, `in 12m`. */
export function fmtResetIn(resetsAt: string | undefined, at: number): string {
  if (resetsAt === undefined || at === 0) return ''
  const ms = Date.parse(resetsAt) - at
  if (!(ms > 0)) return 'now'
  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `in ${days}d ${hours % 24}h`
  if (hours > 0) return `in ${hours}h ${minutes % 60}m`
  return `in ${minutes}m`
}

/** When a window resets, local time: `17:00` today, `Mon 09:00` on another day. */
export function fmtResetAt(resetsAt: string | undefined, at: number): string {
  if (resetsAt === undefined || at === 0) return ''
  const when = new Date(resetsAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`
  if (when.toDateString() === new Date(at).toDateString()) return time
  return `${when.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
}

export function fmtMinutes(ms: number): string {
  const minutes = ms / 60_000
  return minutes < 10 ? `${minutes.toFixed(1)} min` : `${Math.round(minutes)} min`
}

export function sumTokens(all: Iterable<Tokens>): Tokens {
  let total = ZERO
  for (const t of all) {
    total = {
      input: total.input + t.input,
      output: total.output + t.output,
      cacheRead: total.cacheRead + t.cacheRead,
      cacheWrite: total.cacheWrite + t.cacheWrite,
    }
  }
  return total
}
