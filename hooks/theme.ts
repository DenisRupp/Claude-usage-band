// The band's palette, sizes and labels, and the context window's zones.

// Colors: what was used before / by others, and what this session ate.
// Theme keys for text; hex for the SVG bars, which are drawn as images.
// The palette of Claude Code's own context window bar, so the two read alike:
// its blue for what is used; the track, what is left, a few tones lighter so it shows.
export const USED_HEX = '#4E85DE'
export const TRACK_HEX = '#4F4D49'
const DONE_PALETTE_HEX = '#4A9C74'
export const MUTED_HEX = '#97958E'
export const FAINT_HEX = '#5F5E5B'
// The terminal's bar in the same color (hex: the terminal draws it too).
export const USED = USED_HEX

// The context window's zones: where the model stays sharp, where it slips
// (too much context: it forgets instructions, errs, makes things up), and
// where the harness stops. The first border is a rule of thumb, not a wall.
export const SMART_MAX = 250_000
const LIMIT_FRACTION = 0.9
export const ZONE_HEX = { smart: '#4A9C74', dumb: '#E2B93B', limit: '#F2464B' } as const
export const ZONE_LABEL = { smart: 'Smart zone', dumb: 'Dumb zone', limit: 'Context limit' } as const
export type ContextZone = keyof typeof ZONE_HEX

/**
 * Which zone a context of `tokens` is in: smart below SMART_MAX, at the
 * limit from LIMIT_FRACTION of the window (or the auto-compact point, when
 * that comes first), the dumb zone between.
 */
export function contextZone(tokens: number, window: number, compactAt?: number): ContextZone {
  const limitFrom = Math.min(window * LIMIT_FRACTION, compactAt ?? Number.POSITIVE_INFINITY)
  if (window > 0 && tokens >= limitFrom) return 'limit'
  return tokens < SMART_MAX ? 'smart' : 'dumb'
}

// Claude's spark keeps the brand's own orange.
export const SPARK_HEX = '#D97757'

// The Hot commands panel: a couple of tones off the band's background.
export const PANEL_BG_HEX = '#80808014'

export const BAR_HEIGHT = 5
export const LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: 'week',
  seven_day_opus: 'week opus',
  seven_day_sonnet: 'week sonnet',
  spend_limit: 'spend $',
}
export const ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'spend_limit']

// The workflow stages' icons: done, ignored (skipped), and not reached yet.
export const DONE_HEX = DONE_PALETTE_HEX
