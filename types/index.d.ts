/** Token counts this session spent, summed over every model turn (subagents included). */
export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** One rate-limit window as the band draws it. */
export type LimitRow = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

/** The last limits reading any session had, in $.store under `limits`, and when (ms since the epoch). */
export type KeptLimits = { rows: LimitRow[]; at: number }

/** The live context window: its fill (null before the first response) and its size, in tokens. */
export type ContextFill = { tokens: number | null; window: number }

/** A skill the person used, and when (ms since the epoch). */
export type UsedSkill = { name: string; at: number }

/** The /retro run the Retro panel shows: its state, and its output or why it failed. */
export type RetroRun = {
  status: 'idle' | 'running' | 'done' | 'error'
  text: string
  startedAt: number
  finishedAt: number
}

/** What survives a resume: kept in $.store under `s:<sessionId>`. */
export type Saved = {
  tokens: Tokens
  /** Main-thread turn time so far, in ms; absent in what older versions saved. */
  thinkMs?: number
  /** The workflow stages' skills this session used; absent in older saves. */
  stagesUsed?: string[]
  /** The Linear issues this session linked; absent in older saves. */
  tasks?: LinearTask[]
  at: number
}

/**
 * A Linear issue the conversation linked: its identifier, title and link.
 * `isExact` when the title came from Linear itself, not the link's slug.
 */
export type LinearTask = { id: string; title: string; url: string; isExact: boolean }

/** Which panel under the buttons is open; '' for none. */
export type Panel = '' | 'stages' | 'hot' | 'settings'

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      sessionId: string
      tokens: Tokens
      limits: LimitRow[]
      context: ContextFill
      costUsd: number | null
      now: number
      panel: Panel
      localShown: Partial<Record<'limits' | 'context' | 'session' | 'buttons', boolean>>
      stagesUsed: string[]
      tasks: LinearTask[]
      prRun: RetroRun
      liveTokens: Tokens
      skills: string[]
      projectSkills: string[]
      retro: RetroRun
      spin: number
      thinkMs: number
      thinkReady: boolean
      countedUntil: number
      turnStartedAt: number
    }
  }
}
