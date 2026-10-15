// Which parts of the band show: the plugin's userConfig fields.

// What the band shows, as the person chose: the plugin's `userConfig` fields,
// kept in settings.json, drawn in /config and the band's Settings panel.
export type Part = 'limits' | 'context' | 'session' | 'buttons'
export type Shown = Record<Part, boolean>
export const SETTINGS: readonly { field: string; part: Part; label: string }[] = [
  { field: 'showLimits', part: 'limits', label: 'Usage limits and resets' },
  { field: 'showContext', part: 'context', label: 'Context and zone' },
  { field: 'showSession', part: 'session', label: 'Session and thinking' },
  { field: 'showButtons', part: 'buttons', label: 'Buttons' },
]
const ALL_SHOWN: Shown = { limits: true, context: true, session: true, buttons: true }

/** The parts the options show: each one on unless its field is `false`. */
export function shownFrom(options: Readonly<Record<string, unknown>> | undefined, local: Partial<Shown> = {}): Shown {
  const shown = { ...ALL_SHOWN }
  for (const s of SETTINGS) shown[s.part] = local[s.part] ?? options?.[s.field] !== false
  return shown
}
