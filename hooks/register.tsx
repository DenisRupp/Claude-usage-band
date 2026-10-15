import { atom, read, update } from 'claude-code'
import type {
  BoxProps,
  ButtonProps,
  MarkdownProps,
  ElementConstructor,
  EngineInterface,
  ModelUsage,
  Register,
  RenderElement,
  SessionRateLimit,
  TextProps,
  Timer,
} from 'claude-code'

import type { ContextFill, KeptLimits, LimitRow, LinearTask, Panel, RetroRun, Saved, Tokens, UsedSkill } from '../types'

const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const KEEP_SESSIONS = 40

// Colors: what was used before / by others, and what this session ate.
// Theme keys for text; hex for the SVG bars, which are drawn as images.
// The palette of Claude Code's own context window bar, so the two read alike:
// its blue for what is used; the track, what is left, a few tones lighter so it shows.
const USED_HEX = '#4E85DE'
const TRACK_HEX = '#4F4D49'
const DONE_PALETTE_HEX = '#4A9C74'
const MUTED_HEX = '#97958E'
const FAINT_HEX = '#5F5E5B'
// The terminal's bar in the same color (hex: the terminal draws it too).
const USED = USED_HEX

// The context window's zones: where the model stays sharp, where it slips
// (too much context: it forgets instructions, errs, makes things up), and
// where the harness stops. The first border is a rule of thumb, not a wall.
const SMART_MAX = 250_000
const LIMIT_FRACTION = 0.9
const ZONE_HEX = { smart: '#4A9C74', dumb: '#E2B93B', limit: '#F2464B' } as const
const ZONE_LABEL = { smart: 'Smart zone', dumb: 'Dumb zone', limit: 'Context limit' } as const
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

/** Token counts the short way: `950`, `132k`, `1M`, `1.2M`. */
export function fmtCompact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  const m = n / 1_000_000
  return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
}
// Claude's spark keeps the brand's own orange.
const SPARK_HEX = '#D97757'

// The Hot commands panel: a couple of tones off the band's background.
const PANEL_BG_HEX = '#80808014'

const BAR_HEIGHT = 5
const RECENT_KEEP = 30
const HOT_SHOWN = 12
const SCAN_FILES = 25
const SCAN_MAX_BYTES = 4 * 1024 * 1024
const SCAN_FLAG = 'skillsScan:v1'

const sessionId = atom({ plugin: 'usage-band', key: 'sessionId' } as const, '')
const tokens = atom({ plugin: 'usage-band', key: 'tokens' } as const, ZERO)
const limits = atom({ plugin: 'usage-band', key: 'limits' } as const, [] as LimitRow[])
// The live context window: its fill (null before the first response) and size.
const context = atom({ plugin: 'usage-band', key: 'context' } as const, { tokens: null, window: 0 } as ContextFill)
const costUsd = atom({ plugin: 'usage-band', key: 'costUsd' } as const, null as number | null)
const now = atom({ plugin: 'usage-band', key: 'now' } as const, 0)
const panel = atom({ plugin: 'usage-band', key: 'panel' } as const, '' as Panel)
// The parts shown or hidden where settings took no row (and, until the reload, a change just made).
const localShown = atom({ plugin: 'usage-band', key: 'localShown' } as const, {} as Partial<Shown>)
const stagesUsed = atom({ plugin: 'usage-band', key: 'stagesUsed' } as const, [] as string[])
const tasks = atom({ plugin: 'usage-band', key: 'tasks' } as const, [] as LinearTask[])
const prRun = atom({ plugin: 'usage-band', key: 'prRun' } as const, { status: 'idle', text: '', startedAt: 0, finishedAt: 0 } as RetroRun)
// Tokens of turns still running, by the responses they had so far; a turn's
// own total replaces its share when it completes.
const liveTokens = atom({ plugin: 'usage-band', key: 'liveTokens' } as const, ZERO)
const skills = atom({ plugin: 'usage-band', key: 'skills' } as const, [] as string[])
const projectSkills = atom({ plugin: 'usage-band', key: 'projectSkills' } as const, [] as string[])
const IDLE: RetroRun = { status: 'idle', text: '', startedAt: 0, finishedAt: 0 }
const retro = atom({ plugin: 'usage-band', key: 'retro' } as const, IDLE)
const spin = atom({ plugin: 'usage-band', key: 'spin' } as const, 0)
// Time Claude Code spent on this session's turns: the sum of each main-thread
// turn's length. `countedUntil` is the moment counted up to, so a turn that
// began before a reload or a backfill is not counted twice.
const thinkMs = atom({ plugin: 'usage-band', key: 'thinkMs' } as const, 0)
const thinkReady = atom({ plugin: 'usage-band', key: 'thinkReady' } as const, false)
const countedUntil = atom({ plugin: 'usage-band', key: 'countedUntil' } as const, 0)
const turnStartedAt = atom({ plugin: 'usage-band', key: 'turnStartedAt' } as const, 0)

// The terminal's thinking glyphs, as Claude Code's own spinner cycles them.
const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const SPIN_MS = 120
const RETRO_SKILL = 'retro'
// Session Recap's output shows in a pane: a sidebar where the surface docks one.
const RECAP_PANE = 'session-recap'
const RECAP_TITLE = 'Session Recap'
const RECAP_COLUMNS = 60
const PR_PANE = 'pr-description'
// The diff the PR description is written from: every file, each cut to a few
// thousand characters, the whole to a budget; noise (lockfiles, builds) left out.
const DIFF_MAX = 60_000
const DIFF_FILE_MAX = 4_000
const DIFF_NOISE = ['*.lock', '*-lock.json', '*.lockb', '*.min.*', '*.map', '*.snap', 'dist/*', 'build/*']
const GLOSSARY_MAX = 12_000
// Past this since the last turn the conversation's cache entry has likely
// lapsed: a fork would bill the whole conversation afresh, so the PR run
// goes without it, from the skill and the branch's changes alone.
const FORK_WARM_MS = 50 * 60_000
// How soon after a model response the usage figures are read again.
const USAGE_REFRESH_MS = 1_500
// The band's clock: reset countdowns and live thinking time.
const TICK_MS = 15_000

const LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: 'week',
  seven_day_opus: 'week opus',
  seven_day_sonnet: 'week sonnet',
  spend_limit: 'spend $',
}
const ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'spend_limit']

/**
 * A diff cut to fit `total`, as many files as it holds: every file gets the
 * same cut (the largest that fits them all, at most `perFile`); when even
 * `minPerFile` each cannot hold them all, the most changed files are kept.
 * Files keep their order; those left out are named after (the stat lists them too).
 */
export function diffExcerpt(diff: string, perFile = DIFF_FILE_MAX, total = DIFF_MAX, minPerFile = 600): string {
  const files = diff.split(/(?=^diff --git )/m).filter(part => part.trim() !== '')
  const sizes = files.map(f => f.length)
  const fits = (cut: number) => sizes.reduce((sum, size) => sum + Math.min(size, cut), 0) <= total
  let lo = 0
  let hi = perFile
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(mid)) lo = mid
    else hi = mid - 1
  }
  const cut = Math.max(lo, Math.min(minPerFile, perFile))
  const part = (i: number) => {
    const file = files[i]!
    return file.length > cut ? `${file.slice(0, cut)}\n… (${file.length - cut} more characters of this file)\n` : file
  }
  const keep = new Set<number>()
  let used = 0
  for (const i of files.map((_, i) => i).sort((a, b) => sizes[b]! - sizes[a]!)) {
    const length = part(i).length
    if (used + length > total) continue
    keep.add(i)
    used += length
  }
  const left = files.flatMap((f, i) => (keep.has(i) ? [] : [/^diff --git a\/(\S+)/.exec(f)?.[1] ?? '?']))
  const kept = files.flatMap((_, i) => (keep.has(i) ? [part(i)] : [])).join('')
  return left.length === 0 ? kept : `${kept}\n… ${left.length} more files left out: ${left.join(', ')}\n`
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

/**
 * The main-thread turns of a transcript (JSONL), summed: from each prompt the
 * person sent to the last assistant message before the next one.
 */
export function transcriptTurnMs(text: string): number {
  let total = 0
  let start: number | null = null
  let last: number | null = null
  const close = () => {
    if (start !== null && last !== null && last > start) total += last - start
  }
  for (const line of text.split('\n')) {
    if (line === '') continue
    let row: { type?: string; isSidechain?: boolean; isMeta?: boolean; timestamp?: string; message?: { content?: unknown } }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.isSidechain || row.timestamp === undefined) continue
    const at = Date.parse(row.timestamp)
    if (Number.isNaN(at)) continue
    if (row.type === 'user' && !row.isMeta) {
      const content = row.message?.content
      const isToolResult =
        Array.isArray(content) && content.some(b => (b as { type?: string } | null)?.type === 'tool_result')
      if (isToolResult) continue
      close()
      start = at
      last = null
    } else if (row.type === 'assistant' && start !== null) {
      last = at
    }
  }
  close()
  return total
}

/** A task's phases, in order: each a skill the conversation runs. */
export const STAGES: readonly { skill: string; aliases: readonly string[]; hint: string }[] = [
  {
    skill: 'grill-with-docs',
    // `grilling` is what a session falls back to when grill-with-docs is not installed.
    aliases: ['grill-me', 'grilling'],
    hint: 'Get interviewed about a plan, and record the decisions.',
  },
  { skill: 'to-spec', aliases: [], hint: 'Turn an agreed conversation into a written spec.' },
  { skill: 'to-tickets', aliases: [], hint: 'Split a spec into small tickets an agent can build.' },
  { skill: 'implement', aliases: [], hint: 'Build a finished spec into code, test-first.' },
  { skill: 'code-review', aliases: [], hint: 'Review a diff against your standards and against the spec.' },
]

export type StageStatus = 'done' | 'skipped' | 'ahead'

/**
 * The stage a skill is, by its name or one of the stage's aliases, with any
 * `<plugin>:` prefix (`mattpocock-skills:`) dropped.
 */
export function stageOf(skill: string): string | undefined {
  const bare = skill.slice(skill.lastIndexOf(':') + 1)
  return STAGES.find(s => s.skill === bare || s.aliases.includes(bare))?.skill
}

/**
 * Each stage's status: `done` when its skill ran in this conversation,
 * `skipped` when it did not but a later stage's did, `ahead` otherwise.
 */
export function stageStatuses(used: readonly string[]): StageStatus[] {
  const furthest = STAGES.reduce((last, s, i) => (used.includes(s.skill) ? i : last), -1)
  return STAGES.map((s, i) => (used.includes(s.skill) ? 'done' : i < furthest ? 'skipped' : 'ahead'))
}

// A command typed at the start of any line of a message: the person may lead
// with an @-mention or a sentence and put the command on a line of its own.
const LINE_COMMAND = /^[ \t]*\/([\w:.-]+)/gm

type MessageRow = {
  role: string
  text: string
  toolUses: readonly { tool: string; input: Record<string, unknown>; text?: string }[]
}

/** The exact titles the Linear tools' answers in a conversation give, by issue id. */
export function exactTitlesInMessages(rows: readonly MessageRow[]): Map<string, string> {
  const exact = new Map<string, string>()
  for (const row of rows) {
    for (const use of row.toolUses) {
      if (!use.tool.startsWith('mcp__') || !/issue/i.test(use.tool) || use.text === undefined) continue
      for (const [id, title] of issueTitles(use.text)) exact.set(id, title)
    }
  }
  return exact
}

/**
 * The Linear issues the person linked in a conversation, titled exactly where
 * a Linear tool's result in it names them.
 */
export function tasksInMessages(rows: readonly MessageRow[]): LinearTask[] {
  let found: LinearTask[] = []
  for (const row of rows) if (row.role === 'user') found = mergeTasks(found, linearLinks(row.text))
  const exact = exactTitlesInMessages(rows)
  return found.map(t => {
    const title = exact.get(t.id)
    return title === undefined ? t : { ...t, title, isExact: true }
  })
}

/** The stages a conversation's messages ran: Skill tool calls, and the commands typed. */
export function stagesInMessages(rows: readonly MessageRow[]): string[] {
  const found = new Set<string>()
  const add = (name: unknown) => {
    const stage = typeof name === 'string' ? stageOf(name) : undefined
    if (stage !== undefined) found.add(stage)
  }
  for (const row of rows) {
    for (const use of row.toolUses) if (use.tool === 'Skill') add(use.input['skill'])
    if (row.role !== 'user') continue
    for (const m of row.text.matchAll(SLASH_COMMAND)) add(m[1])
    for (const m of row.text.matchAll(LINE_COMMAND)) add(m[1])
  }
  return [...found]
}

// A Linear issue link: linear.app/<workspace>/issue/<ID>/<slug of its title>.
const LINEAR_LINK = /https?:\/\/linear\.app\/([\w.-]+)\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/([A-Za-z0-9%._~-]+))?/g
const ISSUE_ID = /^[A-Z][A-Z0-9]*-\d+$/
// The ids this mod puts before a session's title: `DUP-1, DUP-2 | ` (`·` before 1.5), or the ids alone.
const TITLE_PREFIX = /^[A-Z][A-Z0-9]*-\d+(?:,\s*[A-Z][A-Z0-9]*-\d+)*\s*[|·]\s*/
const TITLE_SEPARATOR = ' | '
const TITLE_IDS_ONLY = /^[A-Z][A-Z0-9]*-\d+(?:,\s*[A-Z][A-Z0-9]*-\d+)*$/

/** A title from a link's slug: `close-the-stuck-vs-slow-gap` → `Close the stuck vs slow gap`. */
export function slugTitle(slug: string | undefined): string {
  if (!slug) return ''
  let text = slug
  try {
    text = decodeURIComponent(slug)
  } catch {
    // A malformed escape: the slug as it is.
  }
  text = text.replace(/-/g, ' ').trim()
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** The Linear issues a text links, in order, once each. */
export function linearLinks(text: string): LinearTask[] {
  const found = new Map<string, LinearTask>()
  for (const m of text.matchAll(LINEAR_LINK)) {
    const id = m[2]!.toUpperCase()
    if (found.has(id)) continue
    const slug = m[3]
    const url = `https://linear.app/${m[1]}/issue/${id}${slug ? `/${slug}` : ''}`
    found.set(id, { id, title: slugTitle(slug), url, isExact: false })
  }
  return [...found.values()]
}

/** The exact titles a Linear tool's result (JSON) carries: each issue's `id` or `identifier`, and `title`. */
export function issueTitles(text: string): Map<string, string> {
  const out = new Map<string, string>()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return out
  }
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    if (value === null || typeof value !== 'object') return
    const o = value as Record<string, unknown>
    const id = typeof o['identifier'] === 'string' ? o['identifier'] : o['id']
    if (typeof id === 'string' && ISSUE_ID.test(id) && typeof o['title'] === 'string') out.set(id, o['title'])
    Object.values(o).forEach(walk)
  }
  walk(data)
  return out
}

/** First-seen order, once each; a title from Linear wins over a slug's. */
export function mergeTasks(prev: readonly LinearTask[], found: readonly LinearTask[]): LinearTask[] {
  const byId = new Map(prev.map(t => [t.id, t]))
  for (const t of found) {
    const had = byId.get(t.id)
    if (had === undefined) byId.set(t.id, t)
    else if (!had.isExact && (t.isExact || (had.title === '' && t.title !== ''))) {
      byId.set(t.id, { ...had, title: t.title, isExact: t.isExact })
    }
  }
  return [...byId.values()]
}

/** Drops leading words that only repeat an issue's id or its team key (`DUP backup plan` → `backup plan`). */
function withoutIssueWords(text: string, ids: readonly string[]): string {
  const words = new Set(ids.flatMap(id => [id.toUpperCase(), id.split('-')[0]!.toUpperCase()]))
  let rest = text
  for (;;) {
    const m = /^([A-Za-z][A-Za-z0-9]*(?:-\d+)?)(?:\s*[:|·—–-]\s*|\s+)/.exec(rest)
    if (m === null || !words.has(m[1]!.toUpperCase())) return rest.trim()
    rest = rest.slice(m[0].length)
  }
}

/**
 * The session title with the linked issues' ids before it (`DUP-1, DUP-2 | title`),
 * replacing ids this mod put there before and dropping a leading team key the
 * title already had; undefined when it is already so. A session with no title
 * yet takes `fallback` (the first issue's title).
 */
export function titledWith(ids: readonly string[], current: string | undefined, fallback: string): string | undefined {
  if (ids.length === 0) return undefined
  const now = (current ?? '').trim()
  const rest = TITLE_IDS_ONLY.test(now) ? '' : withoutIssueWords(now.replace(TITLE_PREFIX, ''), ids)
  const base = rest || withoutIssueWords(fallback.trim(), ids)
  const next = base ? `${ids.join(', ')}${TITLE_SEPARATOR}${base}` : ids.join(', ')
  return next === now ? undefined : next
}

/** Newest first, one entry per skill, at most RECENT_KEEP. */
export function mergeRecent(prev: readonly UsedSkill[], used: readonly UsedSkill[]): UsedSkill[] {
  const latest = new Map<string, number>()
  for (const u of [...prev, ...used]) latest.set(u.name, Math.max(latest.get(u.name) ?? 0, u.at))
  return [...latest]
    .map(([name, at]) => ({ name, at }))
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENT_KEEP)
}

/** A skill's name: its SKILL.md frontmatter `name`, else its folder's. */
export function skillName(folder: string, skillMd: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd)?.[1] ?? ''
  const name = /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(front)?.[1]?.trim()
  return name || folder
}

export function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
}

/** The skills a skill's text says to load with the Skill tool. */
export function referencedSkills(body: string): string[] {
  return [...new Set([...body.matchAll(/Skill tool with `([^`]+)`/g)].map(m => m[1]!))]
}

/**
 * What the fork is asked: run the skill over this conversation, as if the
 * person had typed `/<name>`, with the skills it loads inlined, since a fork
 * calls no tools.
 */
export function skillForkPrompt(
  name: string,
  body: string,
  refs: readonly { name: string; body: string }[],
  context = '',
  ask = '',
  hasConversation = true,
): string {
  const inlined = refs.map(r => `<skill name="${r.name}">\n${r.body}\n</skill>`).join('\n\n')
  return [
    hasConversation
      ? `The user has invoked the /${name} skill. Its instructions follow; carry them out on this conversation.`
      : `The user has invoked the /${name} skill. Its instructions follow; carry them out on what is gathered in <context> below.`,
    hasConversation
      ? 'You cannot call tools in this reply: work from the conversation above, and where a step would read a file or run a command, say what you would check instead.'
      : 'You cannot call tools in this reply: work from what is given, and where a step would read a file or run a command, say what you would check instead.',
    context !== '' ? 'What a tool would have fetched for it is gathered in <context> below.' : '',
    refs.length > 0 ? 'Where the skill says to load another skill with the Skill tool, use the copy inlined below.' : '',
    ask,
    'Answer in Markdown.',
    '',
    `<skill name="${name}">\n${body}\n</skill>`,
    inlined,
    context !== '' ? `<context>\n${context}\n</context>` : '',
  ]
    .filter(line => line !== '')
    .join('\n')
}

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

// The workflow stages' icons: done, ignored (skipped), and not reached yet.
const DONE_HEX = DONE_PALETTE_HEX
const STAGE_GLYPHS: Record<StageStatus, string> = { done: '✓', skipped: '⊘', ahead: '○' }
const STAGE_ICON_PX = 14

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

const SKILL_TOOL = /"name":"Skill","input":\{"skill":"([^"]+)"/g
const SLASH_COMMAND = /<command-name>\/?([^<\s]+)<\/command-name>/g
const TIMESTAMP = /"timestamp":"([^"]+)"/

/**
 * The skills a transcript (JSONL) shows in use: the Skill tool's calls and the
 * slash commands typed, each with its line's time. `isCommand` marks the
 * latter, which may be a built-in command rather than a skill.
 */
export function scanTranscript(text: string): (UsedSkill & { isCommand: boolean })[] {
  const found: (UsedSkill & { isCommand: boolean })[] = []
  for (const line of text.split('\n')) {
    const hasTool = line.includes('"name":"Skill"')
    const hasCommand = line.includes('<command-name>')
    if (!hasTool && !hasCommand) continue
    const at = Date.parse(TIMESTAMP.exec(line)?.[1] ?? '')
    if (Number.isNaN(at)) continue
    if (hasTool) for (const m of line.matchAll(SKILL_TOOL)) found.push({ name: m[1]!, at, isCommand: false })
    if (hasCommand) for (const m of line.matchAll(SLASH_COMMAND)) found.push({ name: m[1]!, at, isCommand: true })
  }
  return found
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
function textBar(Box: ElementConstructor<BoxProps>, Text: ElementConstructor<TextProps>, r: LimitRow, width: number) {
  const c = cells(r.percentUsed, width)
  return (
    <Box flexDirection="row">
      <Text color={USED}>{'━'.repeat(c.used)}</Text>
      <Text color={TRACK_HEX}>{'─'.repeat(c.rest)}</Text>
    </Box>
  )
}

/** A limit row's left part: its name, bar and percentage. */
function limitLine(
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
function sideLine(
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

type Engine = EngineInterface

/** Puts `/<skill> ` at the start of the prompt, over a slash command already there. */
async function insertSkill($: Engine, name: string): Promise<void> {
  const { text } = await $.prompt.read()
  const rest = text.replace(/^\/\S+\s*/, '')
  await $.prompt.fill({ text: `/${name} ${rest}`, mode: 'replace' })
}

async function persist($: Engine): Promise<void> {
  const id = await read($, sessionId)
  if (id === '') return
  const saved: Saved = {
    tokens: await read($, tokens),
    thinkMs: await read($, thinkMs),
    stagesUsed: await read($, stagesUsed),
    tasks: await read($, tasks),
    at: await $.clock.now(),
  }
  await $.store.set(`s:${id}`, saved)
}

async function prune($: Engine): Promise<void> {
  const keys = (await $.store.keys()).filter(k => k.startsWith('s:'))
  if (keys.length <= KEEP_SESSIONS) return
  const dated = await Promise.all(
    keys.map(async k => ({ k, at: ((await $.store.get(k)) as Saved | undefined)?.at ?? 0 })),
  )
  dated.sort((a, b) => a.at - b.at)
  for (const { k } of dated.slice(0, dated.length - KEEP_SESSIONS)) await $.store.delete(k)
}

/** The names of the slash commands there are now, and where each comes from. */
let available: Map<string, string> | null = null

async function publishSkills($: Engine, recent: readonly UsedSkill[]): Promise<void> {
  const names = recent
    .map(u => u.name)
    .filter(name => available === null || available.has(name))
    .slice(0, HOT_SHOWN)
  await update($, skills, () => names)
}

async function recordSkills($: Engine, used: readonly UsedSkill[]): Promise<void> {
  const prev = ((await $.store.get('recentSkills')) ?? []) as UsedSkill[]
  const merged = mergeRecent(prev, used)
  await $.store.set('recentSkills', merged)
  await publishSkills($, merged)
}

/**
 * The skills the current project keeps: `.claude/skills/<name>/SKILL.md` in
 * the session's directory and each one above it, up to (not including) home,
 * whose `.claude/skills` are the person's own, not the project's.
 */
async function projectSkillDirs($: Engine): Promise<string[]> {
  const home = await $.env.get('HOME')
  let dir = await $.session.cwd()
  const roots: string[] = []
  while (dir !== home) {
    const root = `${dir}/.claude/skills`
    if (await $.fs.exists(root)) roots.push(root)
    const parent = dir.replace(/\/[^/]+\/?$/, '') || '/'
    if (parent === dir) break
    dir = parent
  }
  return roots
}

async function scanProject($: Engine): Promise<void> {
  const names = new Set<string>()
  for (const root of await projectSkillDirs($)) {
    for (const entry of await $.fs.list(root)) {
      if (entry.kind !== 'dir' && !entry.isLink) continue
      const text = await $.fs.read(`${root}/${entry.name}/SKILL.md`).catch(() => null)
      if (text !== null) names.add(skillName(entry.name, text))
    }
  }
  const found = [...names].sort((a, b) => a.localeCompare(b))
  await update($, projectSkills, () => found)
}

/** A skill's SKILL.md body, the project's copy first, then the person's own. */
async function readSkill($: Engine, name: string): Promise<string | null> {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
  const folder = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name
  for (const root of [...(await projectSkillDirs($).catch(() => [])), `${config}/skills`]) {
    const text = await $.fs.read(`${root}/${folder}/SKILL.md`).catch(() => null)
    if (text !== null) return stripFrontmatter(text)
  }
  return null
}

let spinTimer: Timer | null = null
let activeRuns = 0
// When the main thread's last turn ended (ms; 0 before one this load saw).
let lastTurnEndedAt = 0
// Tokens of the turns still running, by turn id.
const inFlight = new Map<string, Tokens>()
let isRefreshDue = false
// The token count where auto-compaction runs, read once a load (a local estimate, no request).
let compactAt: number | undefined
// Conversation rows already scanned for stages and tasks.
let scanned = 0


function startSpin($: Engine): void {
  if (activeRuns++ === 0) spinTimer = $.clock.every(SPIN_MS, () => void update($, spin, n => (n + 1) % SPINNER.length))
}

function stopSpin(): void {
  activeRuns = Math.max(0, activeRuns - 1)
  if (activeRuns > 0) return
  spinTimer?.cancel()
  spinTimer = null
}

/** A skill run in the background whose output shows in a sidebar pane. */
type SkillPane = {
  skill: string
  pane: string
  title: string
  /** Which run it is: names its state (readRun, writeRun) and starts its pane's element keys. */
  key: 'retro' | 'pr'
  /** What the run is over, under the pane's header. */
  scope: string
  /** `git`: the branch's changes are gathered for it first (gitContext), which may fail the run. */
  gathers?: 'git'
  /** One more line for the model. */
  ask?: string
}

const RECAP: SkillPane = {
  skill: RETRO_SKILL,
  pane: RECAP_PANE,
  title: RECAP_TITLE,
  key: 'retro',
  scope: `/${RETRO_SKILL} over this conversation`,
}

const PR: SkillPane = {
  skill: 'pr',
  pane: PR_PANE,
  title: 'PR description',
  key: 'pr',
  scope: "/pr over this branch's changes",
  gathers: 'git',
  ask: 'Reply with the PR body alone, ready to paste.',
}

// Each run's state is its own atom, named where it is read or written.
async function readRun($: Engine, key: SkillPane['key']): Promise<RetroRun> {
  return key === 'pr' ? read($, prRun) : read($, retro)
}

async function writeRun($: Engine, key: SkillPane['key'], value: RetroRun): Promise<void> {
  if (key === 'pr') await update($, prRun, () => value)
  else await update($, retro, () => value)
}

async function git($: Engine, args: readonly string[], cwd: string): Promise<string> {
  const r = await $.process.run(['git', ...args], { cwd, timeoutMs: 20_000 })
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} failed`)
  return r.stdout
}

/** The branch's commits, status and diff against its base, and the repo's GLOSSARY.md. */
async function gitContext($: Engine): Promise<string> {
  const cwd = await $.session.cwd()
  const root = (
    await git($, ['rev-parse', '--show-toplevel'], cwd).catch(() => {
      throw new Error('Not a git repository: there is no branch to describe.')
    })
  ).trim()
  const branch = (await git($, ['rev-parse', '--abbrev-ref', 'HEAD'], root)).trim()
  let base = (await git($, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root).catch(() => '')).trim()
  if (base === '') {
    for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
      if (await git($, ['rev-parse', '--verify', '--quiet', candidate], root).then(() => true, () => false)) {
        base = candidate
        break
      }
    }
  }
  if (base === '') throw new Error('Could not find the base branch (origin/HEAD, main or master).')
  const mergeBase = (await git($, ['merge-base', 'HEAD', base], root)).trim()
  const log = (await git($, ['log', '--no-merges', '--format=%h %s%n%b', `${mergeBase}..HEAD`], root)).trim()
  const status = (await git($, ['status', '--short'], root)).trim()
  const stat = (await git($, ['diff', '--stat', mergeBase], root)).trim()
  if (log === '' && stat === '' && status === '') throw new Error(`No changes on ${branch} against ${base}.`)
  const noise = DIFF_NOISE.map(glob => `:(exclude,glob)**/${glob}`)
  const diff = await git($, ['diff', '-U2', '--no-color', mergeBase, '--', '.', ...noise], root)
  const cut = diffExcerpt(diff)
  const glossary = await $.fs.read(`${root}/GLOSSARY.md`).catch(() => '')
  return [
    `Branch ${branch}, against ${base} (merge base ${mergeBase.slice(0, 12)}).`,
    `## Commits\n${log || '(none: the changes are not committed yet)'}`,
    status !== '' ? `## Status\n${status}` : '',
    `## Diff stat\n${stat}`,
    `## Diff\n${cut}`,
    glossary !== '' ? `## GLOSSARY.md\n${glossary.slice(0, GLOSSARY_MAX)}` : '',
  ]
    .filter(part => part !== '')
    .join('\n\n')
}

async function markStages($: Engine, found: readonly string[]): Promise<void> {
  const prev = await read($, stagesUsed)
  if (found.every(s => prev.includes(s))) return
  await update($, stagesUsed, used => [...new Set([...used, ...found])])
  await persist($)
}

/**
 * Reads the whole conversation for the stages it ran. What it found before
 * stays: a compaction drops early messages, not the stages they ran. Runs at
 * the start, after every main-thread turn and on opening the panel, so a
 * panel left open still catches a stage run since.
 */
/**
 * Scans the rows added since the last scan (all of them after a compaction,
 * which shortens the list): stages and tasks only ever add up.
 */
async function scanStages($: Engine): Promise<void> {
  const rows = await $.session.messages()
  const fresh = rows.length >= scanned ? rows.slice(scanned) : rows
  scanned = rows.length
  if (fresh.length === 0) return
  await markStages($, stagesInMessages(fresh))
  const found = tasksInMessages(fresh)
  // A Linear tool's answer may come rows after the link it titles.
  const exact = exactTitlesInMessages(fresh)
  const known = [...(await read($, tasks)), ...found]
  const titled = known.flatMap(t => {
    const title = exact.get(t.id)
    return title === undefined ? [] : [{ ...t, title, isExact: true }]
  })
  await markTasks($, [...found, ...titled])
}

async function markTasks($: Engine, found: readonly LinearTask[]): Promise<void> {
  if (found.length === 0) return
  const prev = await read($, tasks)
  const next = mergeTasks(prev, found)
  if (JSON.stringify(next) === JSON.stringify(prev)) return
  await update($, tasks, () => next)
  await persist($)
  if (next.some(t => !t.isExact)) $.clock.after(0, () => void fetchTitles($).catch(() => undefined))
  if (next.length > prev.length) isTitleCheckDue = true
  $.clock.after(0, () => void ensureTitle($).catch(() => undefined))
}

// The session's permission mode, as the last prompt's classic hook reported it.
let permissionMode = ''

/**
 * Whether a tool call this mod makes on its own may go ahead without putting
 * a dialog in front of the person: allowed outright, or asked in a mode that
 * decides without one (auto, bypass).
 */
async function mayCall($: Engine, tool: string, input: Record<string, unknown>): Promise<boolean> {
  const { decision } = await $.tool.check({ tool, input })
  return decision === 'allow' || (decision === 'ask' && (permissionMode === 'auto' || permissionMode === 'bypassPermissions'))
}

// The desktop app's own tools for this session's title.
const GET_SESSION = 'mcp__ccd_session_mgmt__get_session'
const SET_TITLE = 'mcp__ccd_session_mgmt__set_session_title'
// A title this mod set or tried, so a refused one is not asked for again.
let titleTried = ''
// The session's title as last known (each prompt's classic hook says it, and
// what this mod set), and whether the app's must be read again: at the first
// turn, which is when the app titles a session, and when a task is linked.
let titleKnown: string | undefined
let isTitleCheckDue = true

/**
 * Puts the linked issues' ids before the session's title in the desktop app,
 * through its own session tools: after a turn, so the app's generated title
 * is there to prefix, and again if something retitles it. Where the app
 * tools are missing (the terminal) the classic hooks' sessionTitle does it.
 */
async function ensureTitle($: Engine): Promise<void> {
  const known = await read($, tasks)
  if (known.length === 0) return
  let current = titleKnown
  if (isTitleCheckDue || current === undefined) {
    const self = { session_id: 'self' }
    if (!(await mayCall($, GET_SESSION, self))) return
    const got = await $.tool.call({ tool: GET_SESSION, ...self } as Parameters<Engine['tool']['call']>[0])
    try {
      current = (JSON.parse(got.text ?? '') as { title?: string }).title
    } catch {
      return
    }
    isTitleCheckDue = false
    titleKnown = current
  }
  const title = titledWith(known.map(t => t.id), current, known[0]?.title ?? '')
  if (title === undefined || title === titleTried) return
  titleTried = title
  const input = { session_id: 'self', title }
  if (!(await mayCall($, SET_TITLE, input))) return
  const set = await $.tool.call({ tool: SET_TITLE, ...input } as Parameters<Engine['tool']['call']>[0])
  if (set.isError !== true && set.deny === undefined) titleKnown = title
}

/** The Linear MCP server's get_issue tool, found once per load; null when there is none. */
let issueTool: string | null | undefined

async function findIssueTool($: Engine): Promise<string | null> {
  if (issueTool !== undefined) return issueTool
  const names = new Set((await $.tool.list()).map(t => t.name))
  // A get_issue beside list_issue_statuses: Linear's server, whatever it is named here.
  issueTool =
    [...names].find(n => /^mcp__.+__get_issue$/.test(n) && names.has(n.replace(/get_issue$/, 'list_issue_statuses'))) ??
    null
  return issueTool
}

/**
 * Asks Linear for the exact title of each issue known only by its link's
 * slug, through the person's Linear MCP server, and only where its permission
 * check allows the call outright: never a dialog for this. Titles are kept
 * across sessions in $.store.
 */
async function fetchTitles($: Engine): Promise<void> {
  const pending = (await read($, tasks)).filter(t => !t.isExact)
  if (pending.length === 0) return
  const cache = ((await $.store.get('linearTitles')) ?? {}) as Record<string, string>
  const found: LinearTask[] = []
  for (const t of pending) {
    let title = cache[t.id]
    if (title === undefined) {
      const tool = await findIssueTool($)
      if (tool === null) break
      const input = { id: t.id, fields: ['title', 'url'] }
      if (!(await mayCall($, tool, input))) break
      const r = await $.tool.call({ tool, ...input } as Parameters<Engine['tool']['call']>[0])
      title = r.text === undefined ? undefined : issueTitles(r.text).get(t.id)
      if (title !== undefined) cache[t.id] = title
    }
    if (title !== undefined) found.push({ ...t, title, isExact: true })
  }
  await $.store.set('linearTitles', cache)
  if (found.length > 0) {
    await update($, tasks, prev => mergeTasks(prev, found))
    await persist($)
  }
}

/** This session's own turn time, from its transcript; 0 where there is none yet. */
async function transcriptThinkMs($: Engine, id: string): Promise<number> {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
  const root = `${config}/projects`
  // The folder is named for the working directory, every other character a dash.
  let path = `${root}/${(await $.session.cwd()).replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`
  if (!(await $.fs.exists(path))) {
    const dirs = (await $.fs.exists(root)) ? await $.fs.list(root) : []
    const found = await Promise.all(dirs.map(async d => ((await $.fs.exists(`${root}/${d.name}/${id}.jsonl`)) ? d.name : null)))
    const dir = found.find(d => d !== null)
    if (dir === undefined || dir === null) return 0
    path = `${root}/${dir}/${id}.jsonl`
  }
  return transcriptTurnMs(await $.fs.read(path))
}

function failure(reason: string): string {
  if (reason === 'nothing-to-fork') return 'Nothing to look back on yet: this conversation has no reply so far.'
  if (reason === 'empty-reply') return 'The model returned nothing.'
  if (reason === 'aborted') return 'The run was cancelled.'
  return `The model call failed (${reason}).`
}

/**
 * Opens a skill's pane and runs the skill unless a run is going or its
 * answer is there; pressed while the pane is open, closes it.
 */
async function togglePane($: Engine, spec: SkillPane): Promise<void> {
  const panes = await $.ui.panes()
  if (panes.some(p => p.id === spec.pane)) {
    await $.ui.close({ id: spec.pane })
    return
  }
  await $.ui.open({ id: spec.pane, title: spec.title, columns: RECAP_COLUMNS })
  const { status } = await readRun($, spec.key)
  if (status === 'idle' || status === 'error') $.clock.after(0, () => void runSkill($, spec))
}

/**
 * Runs a skill in the background: a fork over this conversation, so nothing
 * is added to it, its prefix read from the prompt cache; what the skill needs
 * beyond the conversation is gathered first (`spec.gathers`).
 */
async function runSkill($: Engine, spec: SkillPane): Promise<void> {
  const startedAt = await $.clock.now()
  await writeRun($, spec.key, { status: 'running', text: '', startedAt, finishedAt: 0 })
  startSpin($)

  let status: RetroRun['status'] = 'error'
  let text: string
  try {
    const body = await readSkill($, spec.skill)
    if (body === null) {
      text = `Could not find the ${spec.skill} skill (.claude/skills/${spec.skill}/SKILL.md).`
    } else {
      const refs: { name: string; body: string }[] = []
      for (const name of referencedSkills(body)) {
        const ref = await readSkill($, name)
        if (ref !== null) refs.push({ name, body: ref })
      }
      const context = spec.gathers === 'git' ? await gitContext($) : ''
      // A run that can do without the conversation skips it when its cache
      // entry has likely lapsed, rather than pay for all of it again.
      const isWarm = lastTurnEndedAt > 0 && (await $.clock.now()) - lastTurnEndedAt <= FORK_WARM_MS
      const withConversation = spec.gathers === undefined || isWarm
      const prompt = skillForkPrompt(spec.skill, body, refs, context, spec.ask, withConversation)
      const r = withConversation
        ? await $.model.fork({ prompt })
        : await $.model.complete({ model: await $.session.model(), prompt })
      if ('usage' in r) {
        const usage = r.usage
        await update($, tokens, t => addUsage(t, usage))
        await persist($)
      }
      if (r.isAnswered) {
        status = 'done'
        text = r.text
      } else {
        text = failure(r.reason === 'api-error' ? `HTTP ${r.status ?? '?'}` : r.reason)
      }
    }
  } catch (err) {
    text = `The run failed: ${err instanceof Error ? err.message : String(err)}`
  }

  stopSpin()
  const finishedAt = await $.clock.now()
  await writeRun($, spec.key, { status, text, startedAt, finishedAt })
}

/** A skill pane's body: the run's scope, then the spark, its error, or its answer with Copy and Run again. */
function skillPaneBody(
  $: Engine,
  spec: SkillPane,
  run: RetroRun,
  els: {
    Box: ElementConstructor<BoxProps>
    Text: ElementConstructor<TextProps>
    Button: ElementConstructor<ButtonProps>
    Markdown: ElementConstructor<MarkdownProps>
  },
  spark: RenderElement,
): RenderElement {
  const { Box, Text, Button, Markdown } = els
  const isWorking = run.status === 'running' || run.status === 'idle'
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text dimColor>{spec.scope}</Text>
        {isWorking ? null : (
          <Box flexDirection="row" gap={1}>
            {run.status === 'done' ? (
              <Button
                key={`${spec.key}-copy`}
                label="Copy"
                onPress={press => void $.ui.copy({ text: run.text, surface: press.surface })}
              />
            ) : null}
            <Button key={`${spec.key}-run`} label="Run again" onPress={() => $.clock.after(0, () => void runSkill($, spec))} />
          </Box>
        )}
      </Box>
      {isWorking ? (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1}>
            {spark}
            <Text color={SPARK_HEX}>Thinking…</Text>
          </Box>
          <Text dimColor>Runs in the background; this conversation is not touched.</Text>
        </Box>
      ) : run.status === 'error' ? (
        <Text color="error">{run.text}</Text>
      ) : (
        <Markdown key={`${spec.key}-output`} text={run.text} />
      )}
    </Box>
  )
}

/** Once: the skills the person used before this mod, from recent transcripts. */
async function scanHistory($: Engine): Promise<void> {
  if ((await $.store.get(SCAN_FLAG)) === true) return
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
  const root = `${config}/projects`
  if (!(await $.fs.exists(root))) return

  const files: { path: string; mtimeMs: number }[] = []
  for (const dir of await $.fs.list(root)) {
    if (dir.kind !== 'dir') continue
    for (const f of await $.fs.list(`${root}/${dir.name}`)) {
      if (f.kind === 'file' && f.name.endsWith('.jsonl') && f.size <= SCAN_MAX_BYTES) {
        files.push({ path: `${root}/${dir.name}/${f.name}`, mtimeMs: f.mtimeMs })
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const used: UsedSkill[] = []
  for (const f of files.slice(0, SCAN_FILES)) {
    const text = await $.fs.read(f.path).catch(() => '')
    for (const u of scanTranscript(text)) {
      // A typed slash command counts only when it still exists and is not a built-in.
      const source = available?.get(u.name)
      if (u.isCommand && (source === undefined || source === 'builtin')) continue
      used.push({ name: u.name, at: u.at })
    }
  }
  await recordSkills($, used)
  await $.store.set(SCAN_FLAG, true)
}

/**
 * Reads the usage figures again soon after a model response: free, and the
 * only time they change, since each response brings the rate-limit headers.
 * Several responses close together are read once.
 */
function refreshUsageSoon($: Engine): void {
  if (isRefreshDue) return
  isRefreshDue = true
  $.clock.after(USAGE_REFRESH_MS, () => void refreshUsage($).catch(() => undefined))
}

async function refreshUsage($: Engine): Promise<void> {
  isRefreshDue = false
  const usage = await $.session.usage()
  if (usage.cost) {
    const usd = usage.cost.usd
    await update($, costUsd, () => usd)
  }
  await applyLimits($, usage.rateLimits)
  await applyContext($, usage.context)
}

async function applyContext($: Engine, fill: { tokens?: number; window: number }): Promise<void> {
  const next: ContextFill = { tokens: fill.tokens ?? null, window: fill.window }
  const prev = await read($, context)
  if (prev.tokens === next.tokens && prev.window === next.window) return
  await update($, context, () => next)
}

function sumTokens(all: Iterable<Tokens>): Tokens {
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

async function applyLimits($: Engine, rateLimits: readonly SessionRateLimit[]): Promise<void> {
  if (rateLimits.length === 0) return
  await setLimits(
    $,
    rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
  )
}

// When the limits last came in (a response's headers or the app's usage card),
// and the reading last kept for the next session to start from.
let limitsAt = 0
let limitsKept = ''

/** Shows a fresh reading of the limits and keeps it for sessions that start before their first response. */
async function setLimits($: Engine, read: LimitRow[]): Promise<void> {
  const rank = (kind: string) => (ORDER.includes(kind) ? ORDER.indexOf(kind) : ORDER.length)
  const rows = [...read].sort((a, b) => rank(a.kind) - rank(b.kind))
  limitsAt = await $.clock.now()
  await update($, limits, () => rows)
  const kept = JSON.stringify(rows)
  if (kept === limitsKept) return
  limitsKept = kept
  await $.store.set('limits', { rows, at: limitsAt } satisfies KeptLimits)
}

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
const GET_USAGE = 'mcp__ccd_session_mgmt__get_usage'
const PLAN_POLL_MS = 60_000
const PLAN_KINDS: readonly (readonly [RegExp, string])[] = [
  [/^5-hour/i, 'five_hour'],
  [/^weekly\W+all models/i, 'seven_day'],
  [/^weekly\W+opus/i, 'seven_day_opus'],
  [/^weekly\W+sonnet/i, 'seven_day_sonnet'],
]
// Off once the tool turns out missing (the terminal) or broken.
let hasPlanTool = true

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

/** Reads the limits from the app when no reading came in for a while (an idle or new session). */
async function readPlan($: Engine): Promise<void> {
  if (!hasPlanTool || (await $.clock.now()) - limitsAt < PLAN_POLL_MS) return
  if (!shownFrom(options, await read($, localShown)).limits) return
  try {
    if (!(await mayCall($, GET_USAGE, {}))) return
    const got = await $.tool.call({ tool: GET_USAGE } as Parameters<Engine['tool']['call']>[0])
    if (got.isError === true || got.deny !== undefined) {
      hasPlanTool = false
      return
    }
    const rows = planRows(got.text ?? '')
    if (rows.length > 0) await setLimits($, rows)
  } catch {
    hasPlanTool = false
  }
}

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

// The options this load got; a change in /config or Settings reloads the module with new ones.
let options: Readonly<Record<string, unknown>> = {}

/**
 * Shows or hides a part: written to the plugin's own row in settings (every
 * copy loaded, an installed one and one under development alike), which
 * reloads the module with the new options. Where no row takes it, the choice
 * is kept in this plugin's store instead.
 */
async function setShown($: Engine, part: Part, value: boolean): Promise<void> {
  const field = SETTINGS.find(s => s.part === part)?.field ?? ''
  const own = new RegExp(`^usage-band(@[^.]+)?\\.${field}$`)
  const rows = (await $.config.list().catch(() => [])).filter(r => own.test(r.key) && !r.isLocked)
  let isSet = false
  for (const row of rows) {
    const done = await $.config.set({ key: row.key, value }).catch(() => ({ deny: 'failed' }))
    if (done.deny === undefined) isSet = true
  }
  const kept = ((await $.store.get('shown')) ?? {}) as Partial<Shown>
  const next: Partial<Shown> = { ...kept }
  if (isSet) delete next[part]
  else next[part] = value
  await $.store.set('shown', next)
  // Drawn at once; the reload the setting brings draws the same.
  await update($, localShown, () => (isSet ? { ...next, [part]: value } : next))
}

export const register: Register = (on, given) => {
  options = given ?? {}
  on('command.run', { command: 'usage-band' }, async $ => {
    const now = await update($, panel, p => (p === 'settings' ? '' : 'settings'))
    return { text: now === 'settings' ? 'Usage band settings are open above the prompt.' : 'Usage band settings closed.' }
  })

  on('session.start', async ($, e, next) => {
    // No `isInteractive` guard: the desktop app hosts its sessions as an SDK
    // host, where it is false, and the band still draws there.
    const result = await next(e)

    const id = await $.session.id()
    const current = await read($, sessionId)
    if (current !== id) {
      // A resumed session picks up what it saved; one after /clear starts over.
      // The first start this session sees (`current` unset) keeps what the
      // other hooks already counted: that is this session's own. A hot reload
      // keeps everything.
      const saved = (await $.store.get(`s:${id}`)) as Saved | undefined
      await update($, sessionId, () => id)
      await update($, thinkReady, () => false)
      await update($, stagesUsed, () => saved?.stagesUsed ?? [])
      await update($, tasks, () => saved?.tasks ?? [])
      if (saved !== undefined) {
        await update($, tokens, () => saved.tokens)
        await update($, limits, () => [])
      } else if (current !== '') {
        await update($, tokens, () => ZERO)
        await update($, limits, () => [])
      }
      await prune($)
    }

    const tick = async () => {
      const t = await $.clock.now()
      await update($, now, () => t)
      await readPlan($).catch(() => undefined)
    }
    await tick()
    $.clock.every(TICK_MS, () => void tick())

    const usage = await $.session.usage()
    await update($, costUsd, () => usage.cost?.usd ?? null)
    await applyLimits($, usage.rateLimits)
    if ((await read($, limits)).length === 0) {
      const t = await $.clock.now()
      const kept = (await $.store.get('limits')) as KeptLimits | undefined
      await update($, limits, () => keptLimits(kept, t))
    }
    await applyContext($, usage.context)
    if (compactAt === undefined) {
      const local = await $.session.usage({ breakdown: 'summary' }).catch(() => null)
      compactAt = local?.context.breakdown?.autoCompactThreshold ?? undefined
    }

    await $.command.register({ name: 'usage-band', description: 'Choose what the usage band shows' }).catch(() => undefined)
    const kept = ((await $.store.get('shown')) ?? {}) as Partial<Shown>
    await update($, localShown, () => kept)

    available = new Map((await $.command.list()).map(c => [c.name, c.source]))
    if (shownFrom(options, kept).buttons) {
      // The panels' contents; with the buttons hidden nobody opens them.
      await publishSkills($, ((await $.store.get('recentSkills')) ?? []) as UsedSkill[])
      $.clock.after(0, () => void scanHistory($).catch(() => undefined))
      $.clock.after(0, () => void scanProject($).catch(() => undefined))
      $.clock.after(0, () => void scanStages($).catch(() => undefined))
    }

    if (!(await read($, thinkReady))) {
      // What this session saved, else what its transcript shows (a session from
      // before this mod, or one it loaded into midway).
      const saved = (await $.store.get(`s:${id}`)) as Saved | undefined
      const ms = saved?.thinkMs ?? (await transcriptThinkMs($, id).catch(() => 0))
      const t = await $.clock.now()
      await update($, thinkMs, () => ms)
      await update($, countedUntil, () => t)
      await update($, thinkReady, () => true)
    }

    // A run a reload cut off has no fork left to answer it.
    for (const spec of [RECAP, PR]) {
      if ((await readRun($, spec.key)).status === 'running') {
        await writeRun($, spec.key, { ...IDLE, status: 'error', text: 'The run was cut off by a reload. Run it again.' })
      }
    }
    return result
  })

  // A command the person types counts as it is sent (`/implement phase 5`, or
  // on a line of its own below other text), not only once a scan reads it.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    const typed = stagesInMessages([{ role: 'user', text: e.text, toolUses: [] }])
    if (typed.length > 0) await markStages($, typed)
    await markTasks($, linearLinks(e.text))
    return result
  })

  // The session's title gets the linked issues' ids before it, as the prompt
  // that links one is sent (a title can be set only here and at the start).
  on('classic.UserPromptSubmit', async ($, e, next) => {
    permissionMode = e.permission_mode ?? permissionMode
    if (e.session_title !== undefined) titleKnown = e.session_title
    const result = await next(e)
    const all = mergeTasks(await read($, tasks), linearLinks(e.prompt))
    const title = titledWith(all.map(t => t.id), e.session_title, all[0]?.title ?? '')
    return title === undefined ? result : { ...result, sessionTitle: title }
  })

  // A resumed session that linked issues gets its title prefixed again.
  on('classic.SessionStart', async ($, e, next) => {
    permissionMode = e.permission_mode ?? permissionMode
    const result = await next(e)
    const saved = (await $.store.get(`s:${e.session_id}`)) as Saved | undefined
    const known = saved?.tasks ?? []
    const title = titledWith(known.map(t => t.id), e.session_title, known[0]?.title ?? '')
    return title === undefined ? result : { ...result, sessionTitle: title }
  })

  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    await recordSkills($, [{ name: e.skill, at: await $.clock.now() }])
    const stage = stageOf(e.skill)
    if (stage !== undefined) await markStages($, [stage])
    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.cost) {
      const usd = e.cost.usd
      await update($, costUsd, () => usd)
    }
    await applyLimits($, e.rateLimits)
    await applyContext($, e.context)
    return next(e)
  })

  // turn.start is the main thread's alone: a subagent's run raises none.
  on('turn.start', async ($, e, next) => {
    const t = await $.clock.now()
    await update($, turnStartedAt, () => t)
    return next(e)
  })

  // Each model response, main or a subagent's: its tokens show at once and the
  // usage figures (limits, cost) are read again, both free of tokens.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (usage !== null) {
      inFlight.set(e.turnId, addUsage(inFlight.get(e.turnId) ?? ZERO, usage))
      await update($, liveTokens, () => sumTokens(inFlight.values()))
    }
    refreshUsageSoon($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // The turn's own total replaces what its responses added on the way.
    const usage = e.usage
    const partial = inFlight.get(e.turnId)
    inFlight.delete(e.turnId)
    await update($, liveTokens, () => sumTokens(inFlight.values()))
    if (usage) await update($, tokens, t => addUsage(t, usage))
    else if (partial) await update($, tokens, t => sumTokens([t, partial]))
    if (e.agentId === undefined) {
      lastTurnEndedAt = await $.clock.now()
      $.clock.after(0, () => void scanStages($).catch(() => undefined))
      $.clock.after(0, () => void ensureTitle($).catch(() => undefined))
      await update($, turnStartedAt, () => 0)
      if (await read($, thinkReady)) {
        const t = await $.clock.now()
        const since = await read($, countedUntil)
        const add = Math.max(0, Math.min(e.durationMs, t - since))
        await update($, thinkMs, ms => ms + add)
        await update($, countedUntil, () => t)
      }
    }
    await persist($)
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    const usage = 'usage' in result ? result.usage : undefined
    if (usage) {
      await update($, tokens, t => addUsage(t, usage))
      await persist($)
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: RECAP_PANE }, async ($, e) => {
    const run = await read($, retro)
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    let spark: RenderElement
    // The spark animates (SMIL) only drawn interactive; the terminal has no Svg
    // and cycles Claude Code's thinking glyphs instead.
    if (e.surface === 'terminal') spark = <Text color={SPARK_HEX} bold>{SPINNER[await read($, spin)] ?? '✻'}</Text>
    else {
      const { Svg } = $.ui.resolve(e)
      spark = <Svg source={sparkSvg(18)} alt="Claude is thinking" width={18} height={18} isInteractive />
    }
    return skillPaneBody($, RECAP, run, { Box, Text, Button, Markdown }, spark)
  })

  on('ui.render', { component: 'Pane', requestId: PR_PANE }, async ($, e) => {
    const run = await read($, prRun)
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    let spark: RenderElement
    if (e.surface === 'terminal') spark = <Text color={SPARK_HEX} bold>{SPINNER[await read($, spin)] ?? '✻'}</Text>
    else {
      const { Svg } = $.ui.resolve(e)
      spark = <Svg source={sparkSvg(18)} alt="Claude is thinking" width={18} height={18} isInteractive />
    }
    return skillPaneBody($, PR, run, { Box, Text, Button, Markdown }, spark)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const t = sumTokens([await read($, tokens), await read($, liveTokens)])
    const rows = await read($, limits)
    const usd = await read($, costUsd)
    // `now` ticks each minute from session.start; until then, the wall clock.
    const at = (await read($, now)) || Date.now()
    const open = await read($, panel)
    const isOpen = open === 'hot'
    const used = await read($, stagesUsed)
    const linked = await read($, tasks)
    const pr = await read($, prRun)
    const recent = await read($, skills)
    const project = await read($, projectSkills)
    const run = await read($, retro)
    const thought = await read($, thinkMs)
    const turnStart = await read($, turnStartedAt)
    const counted = await read($, countedUntil)
    // The turn under way counts too, by the minute tick.
    const live = turnStart > 0 ? Math.max(0, at - Math.max(turnStart, counted)) : 0
    const shown = shownFrom(options, await read($, localShown))
    const isTop = shown.limits || shown.context || shown.session
    const isBottom = linked.length > 0 || shown.buttons || open === 'settings'
    // Everything hidden: the band steps aside (/usage-band brings Settings back).
    if (!isTop && !isBottom) return next(e)
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    // Opens `which`, closing any other; pressed again, closes it.
    const toggle = (which: Panel, onOpen?: () => Promise<void>) => async () => {
      const now = await update($, panel, p => (p === which ? '' : which))
      if (now === which && onOpen) await onOpen()
    }
    const panelBg = e.surface === 'terminal' ? {} : { backgroundColor: PANEL_BG_HEX }
    const stageIcon = (status: StageStatus): RenderElement => {
      if (e.surface === 'terminal') {
        const color = status === 'done' ? 'success' : 'inactive'
        return <Text color={color} bold={status === 'done'}>{STAGE_GLYPHS[status]}</Text>
      }
      const { Svg } = $.ui.resolve(e)
      const alt = status === 'done' ? 'done' : status === 'skipped' ? 'ignored' : 'not reached'
      return <Svg source={stageIconSvg(status, STAGE_ICON_PX)} alt={alt} width={STAGE_ICON_PX} height={STAGE_ICON_PX} />
    }
    const stagesPanel = (): RenderElement => {
      const statuses = stageStatuses(used)
      const done = statuses.filter(s => s === 'done').length
      const skipped = statuses.filter(s => s === 'skipped').length
      return (
        <Box key="stages" flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} marginTop={1} {...panelBg}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold>Workflow stage</Text>
            <Text dimColor>{`${done} of ${STAGES.length} used${skipped > 0 ? ` · ${skipped} ignored` : ''}`}</Text>
          </Box>
          {STAGES.map((stage, i) => {
            const status = statuses[i] ?? 'ahead'
            return (
              <Box key={`stage-${stage.skill}`} flexDirection="row" alignItems="center" gap={1}>
                <Box width={2}>
                  <Text dimColor>{String(i + 1)}</Text>
                </Box>
                <Box key={`stage-icon-${stage.skill}-${status}`} width={2} alignItems="center">
                  {stageIcon(status)}
                </Box>
                <Box width={17}>
                  <Text bold={status === 'done'} dimColor={status === 'skipped'}>{`/${stage.skill}`}</Text>
                </Box>
                <Text dimColor wrap="truncate-end">
                  {status === 'skipped' ? `ignored · ${stage.hint}` : stage.hint}
                </Text>
              </Box>
            )
          })}
        </Box>
      )
    }
    const width = Math.max(8, Math.min(30, e.props.bodyColumns - 51))
    const totalIn = t.input + t.cacheRead + t.cacheWrite
    const ctx = await read($, context)
    const ctxTokens = ctx.tokens ?? 0
    const zone = contextZone(ctxTokens, ctx.window, compactAt)
    const ctxPct = ctx.window > 0 ? (ctxTokens / ctx.window) * 100 : 0

    const contextBar = (): RenderElement => {
      if (e.surface === 'terminal') {
        const c = cells(ctxPct, width)
        const tick = ctx.window > SMART_MAX ? Math.round((SMART_MAX / ctx.window) * width) : -1
        const rest = '─'.repeat(c.rest).split('')
        if (tick >= c.used && tick - c.used < rest.length) rest[tick - c.used] = '┆'
        return (
          <Box flexDirection="row">
            <Text color={ZONE_HEX[zone]}>{'━'.repeat(c.used)}</Text>
            <Text color={TRACK_HEX}>{rest.join('')}</Text>
          </Box>
        )
      }
      const { Svg } = $.ui.resolve(e)
      const px = width * 8
      return (
        <Svg
          source={contextBarSvg(ctxTokens, ctx.window, px, compactAt)}
          alt={`context: ${fmtCompact(ctxTokens)} of ${fmtCompact(ctx.window)}, ${ZONE_LABEL[zone]}`}
          width={px}
          height={BAR_HEIGHT}
        />
      )
    }

    const drawBar = (r: LimitRow): RenderElement => {
      if (e.surface === 'terminal') return textBar(Box, Text, r, width)
      const { Svg } = $.ui.resolve(e)
      const px = width * 8
      return (
        <Svg
          source={barSvg(r.percentUsed, px)}
          alt={`${LABELS[r.kind] ?? r.kind}: ${Math.round(r.percentUsed)}% used`}
          width={px}
          height={BAR_HEIGHT}
        />
      )
    }

    const settingsPanel = (): RenderElement => (
      <Box key="settings" flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} marginTop={1} {...panelBg}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>Settings</Text>
          <Box flexDirection="row" gap={1}>
            <Text dimColor>also in /config · /usage-band</Text>
            <Button key="settings-close" label="Close" onPress={() => update($, panel, () => '' as Panel)} />
          </Box>
        </Box>
        {SETTINGS.map(s => (
          <Box key={`setting-${s.part}`} flexDirection="row">
            <Button
              key={`show-${s.part}`}
              label={`${shown[s.part] ? '☑' : '☐'} ${s.label}`}
              onPress={() => setShown($, s.part, !shown[s.part])}
            />
          </Box>
        ))}
      </Box>
    )
    const limitRows = shown.limits ? rows : []

    return (
      <Box flexDirection="column">
        {shown.limits && rows.length === 0 ? (
          <Text dimColor>5h / weekly limits appear after the first API response</Text>
        ) : null}
        {/* Two columns, so the right-hand parts (resets, thinking) start at one
            place whatever each row's left part measures. */}
        <Box flexDirection="row">
          <Box flexDirection="column">
            {limitRows.map(r => limitLine(Box, Text, r, drawBar(r)))}
            {shown.context ? (
              <Box key="context" flexDirection="row" alignItems="center" gap={1}>
                <Box width={11}>
                  <Text bold>context</Text>
                </Box>
                {contextBar()}
                <Box width={4}>
                  <Text color={ZONE_HEX[zone]} bold>{`${Math.round(ctxPct)}%`}</Text>
                </Box>
              </Box>
            ) : null}
            {shown.session ? (
              <Box key="session" flexDirection="row" alignItems="center" gap={1}>
                <Box width={11}>
                  <Text bold>session</Text>
                </Box>
                <Text color="success" bold>↑</Text>
                <Text bold>{fmtTokens(totalIn)}</Text>
                <Text dimColor>{t.cacheRead > 0 ? `in (cache ${fmtTokens(t.cacheRead)})` : 'in'}</Text>
                <Text color="error" bold>↓</Text>
                <Text bold>{fmtTokens(t.output)}</Text>
                <Text dimColor>out</Text>
                <Text bold color="success">{usd === null ? '$ —' : `$${usd.toFixed(2)}`}</Text>
              </Box>
            ) : null}
          </Box>
          <Box flexDirection="column" marginLeft={2}>
            {limitRows.map(r =>
              sideLine(
                Box,
                Text,
                `reset-${r.kind}`,
                'resets',
                <Text bold>{fmtResetAt(r.resetsAt, at)}</Text>,
                <Text dimColor>{fmtResetIn(r.resetsAt, at)}</Text>,
              ),
            )}
            {shown.context
              ? sideLine(
                  Box,
                  Text,
                  'zone',
                  'zone',
                  <Text color={ZONE_HEX[zone]} bold>{ZONE_LABEL[zone]}</Text>,
                  <Text dimColor>{ctx.tokens === null ? '—' : `${fmtCompact(ctxTokens)} / ${fmtCompact(ctx.window)}`}</Text>,
                )
              : null}
            {shown.session
              ? sideLine(
                  Box,
                  Text,
                  'thinking',
                  'thinking',
                  <Text bold>{fmtMinutes(thought + live)}</Text>,
                  <Text color={SPARK_HEX}>✻</Text>,
                )
              : null}
          </Box>
        </Box>
        {isTop && isBottom ? (
          <Text color="subtle" wrap="truncate-end">
            {'─'.repeat(Math.max(1, e.props.bodyColumns))}
          </Text>
        ) : null}
        {linked.length > 0 ? (
          <Box key="tasks" flexDirection="column" paddingX={2} paddingY={1}>
            {linked.map(task => (
              <Box key={`task-${task.id}`} flexDirection="row" gap={1}>
                <Text color="suggestion" bold>{task.id}</Text>
                <Link href={task.url} label={task.title || task.url} />
              </Box>
            ))}
          </Box>
        ) : null}
        {shown.buttons ? (
          <Box key="buttons" flexDirection="row" justifyContent="flex-end">
            <Box flexDirection="row" gap={1}>
              <Button
                key="stages-toggle"
                label={open === 'stages' ? 'Workflow stage ▴' : 'Workflow stage ▾'}
                onPress={toggle('stages', () => scanStages($).catch(() => undefined))}
              />
              <Button
                key="retro-toggle"
                label={run.status === 'running' ? `${RECAP_TITLE} ✻` : `${RECAP_TITLE} ▸`}
                onPress={() => togglePane($, RECAP)}
              />
              <Button
                key="pr-toggle"
                label={pr.status === 'running' ? 'Generate PR description ✻' : 'Generate PR description ▸'}
                onPress={() => togglePane($, PR)}
              />
              <Button
                key="hot-toggle"
                label={isOpen ? 'Hot commands ▴' : 'Hot commands ▾'}
                // The project's skills may have changed since the last look.
                onPress={toggle('hot', () => scanProject($).catch(() => undefined))}
              />
              <Button key="settings-toggle" label={open === 'settings' ? '⚙ ▴' : '⚙ ▾'} onPress={toggle('settings')} />
            </Box>
          </Box>
        ) : null}
        {open === 'settings' ? settingsPanel() : null}
        {shown.buttons && open === 'stages' ? stagesPanel() : null}
        {shown.buttons && isOpen ? (
          <Box
            key="hot"
            flexDirection="column"
            borderStyle="round"
            borderColor="subtle"
            paddingX={1}
            marginTop={1}
            {...panelBg}
          >
            <Text bold>Hot commands</Text>
            <Text dimColor>Recently used</Text>
            {recent.length === 0 ? (
              <Text dimColor>No skills used yet</Text>
            ) : (
              <Box flexDirection="row" flexWrap="wrap" gap={1}>
                {recent.map(name => (
                  <Button key={`skill-${name}`} label={`/${name}`} onPress={() => insertSkill($, name)} />
                ))}
              </Box>
            )}
            <Box marginTop={1}>
              <Text dimColor>This project</Text>
            </Box>
            {project.length === 0 ? (
              <Text dimColor>No skills in this project</Text>
            ) : (
              <Box flexDirection="row" flexWrap="wrap" gap={1}>
                {project.map(name => (
                  <Button key={`project-${name}`} label={`/${name}`} onPress={() => insertSkill($, name)} />
                ))}
              </Box>
            )}
          </Box>
        ) : null}
      </Box>
    )
  })
}
