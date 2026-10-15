// The hooks: every call on the engine lives here, beside the code it needs.

import { atom, read, update, type EngineInterface, type Register, type RenderElement, type SessionRateLimit, type Timer } from 'claude-code'
import type { ContextFill, KeptLimits, LimitRow, LinearTask, Panel, RetroRun, Saved, Tokens, UsedSkill } from '../types'
import { bandView, isBandEmpty, type BandData } from './band'
import { sparkSvg } from './draw'
import { ZERO, addUsage, sumTokens } from './format'
import { GET_SESSION, SET_TITLE, exactTitlesInMessages, issueTitles, linearLinks, mergeTasks, tasksInMessages, titledWith } from './linear'
import { DIFF_NOISE, FORK_WARM_MS, GLOSSARY_MAX, IDLE, RECAP_COLUMNS, RECAP_TITLE, RETRO_SKILL, SPINNER, SPIN_MS, diffExcerpt, failure, skillForkPrompt, skillPaneBody, type SkillPane } from './runs'
import { SETTINGS, shownFrom, type Part, type Shown } from './settings'
import { HOT_SHOWN, SCAN_FILES, SCAN_FLAG, SCAN_MAX_BYTES, mergeRecent, referencedSkills, scanTranscript, skillName, stripFrontmatter } from './skills'
import { stageOf, stagesInMessages } from './stages'
import { ORDER, SPARK_HEX } from './theme'
import { transcriptTurnMs } from './thinking'
import { GET_USAGE, PLAN_POLL_MS, USAGE_REFRESH_MS, keptLimits, planRows } from './usage'

type Engine = EngineInterface

// The skill runs' panes: their ids here, where the hooks that draw them match them.
const RECAP_PANE = 'session-recap'
const PR_PANE = 'pr-description'

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

// The band's state: one atom per value, each declared in types/index.d.ts.
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
const retro = atom({ plugin: 'usage-band', key: 'retro' } as const, IDLE)
const spin = atom({ plugin: 'usage-band', key: 'spin' } as const, 0)
// Time Claude Code spent on this session's turns: the sum of each main-thread
// turn's length. `countedUntil` is the moment counted up to, so a turn that
// began before a reload or a backfill is not counted twice.
const thinkMs = atom({ plugin: 'usage-band', key: 'thinkMs' } as const, 0)
const thinkReady = atom({ plugin: 'usage-band', key: 'thinkReady' } as const, false)
const countedUntil = atom({ plugin: 'usage-band', key: 'countedUntil' } as const, 0)
const turnStartedAt = atom({ plugin: 'usage-band', key: 'turnStartedAt' } as const, 0)

const KEEP_SESSIONS = 40

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

/** Puts `/<skill> ` at the start of the prompt, over a slash command already there. */
async function insertSkill($: Engine, name: string): Promise<void> {
  const { text } = await $.prompt.read()
  const rest = text.replace(/^\/\S+\s*/, '')
  await $.prompt.fill({ text: `/${name} ${rest}`, mode: 'replace' })
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

// Conversation rows already scanned for stages and tasks.
let scanned = 0

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

let spinTimer: Timer | null = null
let activeRuns = 0
// When the main thread's last turn ended (ms; 0 before one this load saw).
let lastTurnEndedAt = 0
function startSpin($: Engine): void {
  if (activeRuns++ === 0) spinTimer = $.clock.every(SPIN_MS, () => void update($, spin, n => (n + 1) % SPINNER.length))
}

function stopSpin(): void {
  activeRuns = Math.max(0, activeRuns - 1)
  if (activeRuns > 0) return
  spinTimer?.cancel()
  spinTimer = null
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

let isRefreshDue = false
// The token count where auto-compaction runs, read once a load (a local estimate, no request).
let compactAt: number | undefined
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

// Off once the tool turns out missing (the terminal) or broken.
let hasPlanTool = true

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

// The band's clock: reset countdowns and live thinking time.
const TICK_MS = 15_000

// Tokens of the turns still running, by turn id.
const inFlight = new Map<string, Tokens>()

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
    return skillPaneBody(RECAP, run, { Box, Text, Button, Markdown }, spark, {
      copy: press => void $.ui.copy({ text: run.text, surface: press.surface }),
      runAgain: () => $.clock.after(0, () => void runSkill($, RECAP)),
    })
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
    return skillPaneBody(PR, run, { Box, Text, Button, Markdown }, spark, {
      copy: press => void $.ui.copy({ text: run.text, surface: press.surface }),
      runAgain: () => $.clock.after(0, () => void runSkill($, PR)),
    })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    // `now` ticks from session.start; until then, the wall clock.
    const at = (await read($, now)) || Date.now()
    const turnStart = await read($, turnStartedAt)
    const counted = await read($, countedUntil)
    // The turn under way counts too, by the clock's tick.
    const live = turnStart > 0 ? Math.max(0, at - Math.max(turnStart, counted)) : 0
    const d: BandData = {
      isTerminal: e.surface === 'terminal',
      columns: e.props.bodyColumns,
      limits: await read($, limits),
      tokens: sumTokens([await read($, tokens), await read($, liveTokens)]),
      costUsd: await read($, costUsd),
      at,
      thinkMs: (await read($, thinkMs)) + live,
      context: await read($, context),
      compactAt,
      panel: await read($, panel),
      stagesUsed: await read($, stagesUsed),
      tasks: await read($, tasks),
      recap: await read($, retro),
      pr: await read($, prRun),
      recentSkills: await read($, skills),
      projectSkills: await read($, projectSkills),
      shown: shownFrom(options, await read($, localShown)),
    }
    if (isBandEmpty(d)) return next(e)
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const Svg = e.surface === 'terminal' ? undefined : $.ui.resolve(e).Svg
    return bandView(d, { Box, Text, Button, Link, Svg }, {
      toggle: async which => {
        const open = await update($, panel, p => (p === which ? '' : which))
        // An opened panel reads what it shows afresh: the stages run, the project's skills.
        if (open === 'stages') await scanStages($).catch(() => undefined)
        if (open === 'hot') await scanProject($).catch(() => undefined)
      },
      togglePane: which => togglePane($, which === 'pr' ? PR : RECAP),
      insertSkill: name => insertSkill($, name),
      setShown: (part, value) => setShown($, part, value),
      closePanel: () => update($, panel, () => '' as Panel),
    })
  })
}
