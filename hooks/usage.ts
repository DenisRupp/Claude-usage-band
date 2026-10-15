// Rate limits: their order, and readings kept or taken from the app when no response brought one.

import type { KeptLimits, LimitRow } from '../types'

// How soon after a model response the usage figures are read again.
export const USAGE_REFRESH_MS = 1_500
/**
 * The limits a session shows before it has a reading of its own: the last one
 * any session kept, each window past its reset shown as reset (0%, its next
 * reset unknown till a reading says).
 */
export function keptLimits(kept: KeptLimits | undefined, now: number): LimitRow[] {
  return (kept?.rows ?? []).map(r =>
    r.resetsAt !== undefined && Date.parse(r.resetsAt) <= now ? { kind: r.kind, percentUsed: 0 } : r,
  )
}

// The desktop app's own read of the plan's limits, what its usage card shows:
// no model call, so a session shows them before its first response, and an
// idle one follows what other sessions use.
export const GET_USAGE = 'mcp__ccd_session_mgmt__get_usage'
export const PLAN_POLL_MS = 60_000
const PLAN_KINDS: readonly (readonly [RegExp, string])[] = [
  [/^5-hour/i, 'five_hour'],
  [/^weekly\W+all models/i, 'seven_day'],
  [/^weekly\W+opus/i, 'seven_day_opus'],
  [/^weekly\W+sonnet/i, 'seven_day_sonnet'],
]
/** The limit rows in what the app's `get_usage` tool answers; none unless its plan reading is there. */
export function planRows(text: string): LimitRow[] {
  type Window = { label?: string; percentUsed?: number; resetsAt?: string }
  try {
    const plan = (JSON.parse(text) as { plan?: { status?: string; windows?: Window[] } }).plan
    if (plan?.status !== 'ok') return []
    return (plan.windows ?? []).flatMap(w => {
      const kind = PLAN_KINDS.find(([label]) => label.test(w.label ?? ''))?.[1]
      if (kind === undefined || typeof w.percentUsed !== 'number') return []
      return [{ kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }]
    })
  } catch {
    return []
  }
}
