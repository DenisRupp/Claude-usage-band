import type { ConfigRow, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { barSvg, cells, contextBarSvg, sparkSvg } from '../hooks/draw'
import { fmtCompact, fmtMinutes, fmtResetAt, fmtResetIn, fmtTokens } from '../hooks/format'
import { issueTitles, linearLinks, mergeTasks, tasksInMessages, titledWith } from '../hooks/linear'
import { diffExcerpt, skillForkPrompt } from '../hooks/runs'
import { shownFrom } from '../hooks/settings'
import { mergeRecent, referencedSkills, scanTranscript, skillName, stripFrontmatter } from '../hooks/skills'
import { stageOf, stageStatuses, stagesInMessages } from '../hooks/stages'
import { contextZone } from '../hooks/theme'
import { transcriptTurnMs } from '../hooks/thinking'
import { keptLimits, planRows } from '../hooks/usage'

const FIVE_RESET = '2026-10-09T15:00:00.000Z'
const WEEK_RESET = '2026-10-13T09:00:00.000Z'
const NOW = Date.parse('2026-10-09T12:00:00.000Z')

const BAND = {
  plugin: 'usage-band',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

describe('pure helpers', () => {
  test('bars and numbers', async () => {
    expect(cells(50, 20)).toEqual({ used: 10, rest: 10 })
    expect(cells(1, 20)).toEqual({ used: 1, rest: 19 })
    expect(cells(0, 20)).toEqual({ used: 0, rest: 20 })
    expect(cells(120, 10)).toEqual({ used: 10, rest: 0 })
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(45_200)).toBe('45.2k')
    expect(fmtTokens(1_234_567)).toBe('1.23M')
  })

  test('reset times', async () => {
    expect(fmtResetIn(FIVE_RESET, NOW)).toBe('in 3h 0m')
    expect(fmtResetIn(WEEK_RESET, NOW)).toBe('in 3d 21h')
    expect(fmtResetIn('2026-10-09T12:12:30.000Z', NOW)).toBe('in 12m')
    const local = new Date(FIVE_RESET)
    const hhmm = `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`
    expect(fmtResetAt(FIVE_RESET, NOW)).toBe(hhmm)
    expect(fmtResetAt(WEEK_RESET, NOW)).toMatch(/^[A-Z][a-z]{2} \d\d:\d\d$/)
  })

  test('recent skills from transcripts, newest first', async () => {
    const jsonl = [
      '{"type":"assistant","timestamp":"2026-10-08T10:00:00.000Z","message":{"content":[{"type":"tool_use","id":"t1","name":"Skill","input":{"skill":"grilling"}}]}}',
      '{"type":"user","timestamp":"2026-10-09T09:00:00.000Z","message":{"content":"<command-name>/code-review</command-name>"}}',
      '{"type":"user","timestamp":"2026-10-09T09:30:00.000Z","message":{"content":"<command-name>/model</command-name>"}}',
      '{"type":"user","timestamp":"2026-10-09T09:40:00.000Z","message":{"content":"plain text"}}',
    ].join('\n')
    const found = scanTranscript(jsonl)
    expect(found.map(f => `${f.name}:${f.isCommand}`)).toEqual(['grilling:false', 'code-review:true', 'model:true'])
    const merged = mergeRecent([{ name: 'grilling', at: 1 }, { name: 'tdd', at: 5 }], found)
    expect(merged.map(u => u.name)).toEqual(['model', 'code-review', 'grilling', 'tdd'])
  })

  test('svg bars show the limit alone, a tiny use still visible', async () => {
    expect(cells(1, 200, 5, 0.5)).toEqual({ used: 5, rest: 195 })
    expect(cells(52, 200, 5, 0.5)).toEqual({ used: 104, rest: 96 })
    const svg = barSvg(52, 200)
    expect(svg).toContain('width="200" height="5"')
    // Claude Code's context bar palette: its track, its blue over it; one segment.
    expect(svg).toContain('<rect width="200" height="5" rx="2.5" fill="#4F4D49"/>')
    expect(svg).toContain('<rect width="104" height="5" rx="2.5" fill="#4E85DE"/>')
    expect(svg.match(/<rect /g)).toHaveLength(2)
    expect(barSvg(0, 200).match(/<rect /g)).toHaveLength(1)
  })
})

test('the band shows the limits, tokens and cost', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on, { last: { five_hour: { pct: 40, resetsAt: FIVE_RESET } } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [], cost: { usd: 0 } },
  }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.list', () => ({
    value: [
      { name: 'tdd', description: '', source: 'plugin' },
      { name: 'model', description: '', source: 'builtin' },
    ],
  }))
  on('fs.exists', () => ({ value: false }))
  mock.env(on, { HOME: '/home/test' })
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('prompt.read', () => ({ value: { text: '/old fix the bug', cursor: 0 } }))
  const filled: string[] = []
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })

  // As the desktop app starts it: an SDK host, not interactive, drawing nowhere yet.
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /first API response/ })).toBeDefined()
    await ui.unmount()
  }

  await $.turn.complete({
    answer: 'hi',
    durationMs: 10,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: {
      model: 'claude-opus-5-5',
      input_tokens: 1000,
      output_tokens: 45_200,
      cache_read_input_tokens: 1_100_000,
      cache_creation_input_tokens: 20_000,
    },
  })
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 18, resetsAt: WEEK_RESET },
      { kind: 'five_hour', percentUsed: 52, resetsAt: FIVE_RESET },
    ],
    cost: { usd: 3.4219 },
    changed: ['rateLimits', 'cost'],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '5h' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '52%' })).toBeDefined()
    // No session share beside a limit any more: the bar is the limit alone.
    expect(await ui.find({ type: 'Text', text: /^\+[\d.]+%$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'in 3h 0m' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'in 3d 21h' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: fmtResetAt(FIVE_RESET, NOW) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1.12M' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '45.2k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$3.42' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /this session/ })).toBeUndefined()
    // resets and thinking are rows of one right-hand column, so they line up.
    const side = await ui.findAll({ type: 'Box' })
    const column = side.find(b => {
      const keys = b.children.map(c => (c as { props?: { key?: string } } | null)?.props?.key)
      return keys.includes('reset-five_hour') && keys.includes('reset-seven_day') && keys.includes('thinking')
    })
    expect(column).toBeDefined()
    // Two limit bars and the context bar.
    if (surface === 'desktop') expect(await ui.findAll({ type: 'Svg' })).toHaveLength(3)
    await ui.unmount()
  }
})

test('Hot commands opens a panel of recent skills that fill the prompt', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-2' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('command.list', () => ({ value: [{ name: 'tdd', description: '', source: 'plugin' }] }))
  on('fs.exists', () => ({ value: false }))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('prompt.read', () => ({ value: { text: '/old fix the bug', cursor: 0 } }))
  const filled: string[] = []
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })

  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'Hot commands' })).toBeUndefined()
    await ui.press({ key: 'hot-toggle' })
    expect(await ui.find({ type: 'Text', text: 'No skills used yet' })).toBeDefined()
    await ui.press({ key: 'hot-toggle' })
    await ui.unmount()
  }

  await $.skill.prompt({ skill: 'tdd', text: 'x' })
  await $.skill.prompt({ skill: 'gone', text: 'x' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'hot-toggle' })
    expect(await ui.find({ type: 'Text', text: 'Hot commands' })).toBeDefined()
    expect(await ui.find({ key: 'skill-tdd' })).toBeDefined()
    expect(await ui.find({ key: 'skill-gone' })).toBeUndefined()
    await ui.press({ key: 'skill-tdd' })
    await ui.press({ key: 'hot-toggle' })
    await ui.unmount()
  }
  expect(filled).toEqual(['/tdd fix the bug', '/tdd fix the bug'])
})

test('the first start keeps the tokens counted before it', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const readings = { pct: 18 }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-3' }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: readings.pct, resetsAt: FIVE_RESET }],
    },
  }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  mock.env(on, { HOME: '/home/test' })

  const measure = (pct: number) =>
    $.session.measure({
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: pct, resetsAt: FIVE_RESET }],
      changed: ['rateLimits'],
    })

  // The mod counted before session.start ran in full (a load mid-session).
  await measure(18)
  await $.turn.complete({
    answer: 'a',
    durationMs: 1,
    isAborted: false,
    turnId: 't',
    reason: 'answer',
    usage: { model: 'm', input_tokens: 500, output_tokens: 700, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })
  readings.pct = 19
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await measure(21)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '21%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '700' })).toBeDefined()
  await ui.unmount()
})

test('a skill is named by its frontmatter, else its folder', async () => {
  expect(skillName('deploy', '---\nname: ship-it\ndescription: Ships it\n---\n# Body')).toBe('ship-it')
  expect(skillName('deploy', '---\nname: "quoted"\n---\n')).toBe('quoted')
  expect(skillName('review', '# No frontmatter')).toBe('review')
})

test("This project lists the project's own skills, and they fill the prompt", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-4' }))
  on('session.cwd', () => ({ value: '/home/test/proj/app' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('command.list', () => ({ value: [] }))
  const SKILLS = '/home/test/proj/.claude/skills'
  on('fs.exists', ($, e) => ({ value: e.path === SKILLS }))
  on('fs.list', ($, e) => ({
    value:
      e.path === SKILLS
        ? [
            { name: 'deploy', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
            { name: 'review', kind: 'other', size: 0, mtimeMs: 0, isLink: true },
            { name: 'empty', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
            { name: 'notes.txt', kind: 'file', size: 3, mtimeMs: 0, isLink: false },
          ]
        : [],
  }))
  on('fs.read', ($, e) => {
    if (e.path === `${SKILLS}/deploy/SKILL.md`) return { value: '---\nname: ship-it\n---\nShip.' }
    if (e.path === `${SKILLS}/review/SKILL.md`) return { value: 'Review.' }
    return { deny: 'missing' }
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  const filled: string[] = []
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })

  await $.session.start({ cwd: '/home/test/proj/app', surface: null, isInteractive: false })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'hot-toggle' })
    expect(await ui.find({ type: 'Text', text: 'This project' })).toBeDefined()
    expect(await ui.find({ key: 'project-ship-it' })).toBeDefined()
    expect(await ui.find({ key: 'project-review' })).toBeDefined()
    expect(await ui.find({ key: 'project-empty' })).toBeUndefined()
    expect(await ui.find({ key: 'project-notes.txt' })).toBeUndefined()
    await ui.press({ key: 'project-ship-it' })
    await ui.press({ key: 'hot-toggle' })
    await ui.unmount()
  }
  expect(filled).toEqual(['/ship-it ', '/ship-it '])
})

test('a skill becomes a fork prompt, the skills it loads inlined', async () => {
  const md = '---\nname: retro\ndisable-model-invocation: true\n---\n\n1. Call the Skill tool with `writing-for-agents` for the guide.\n2. Review.'
  const body = stripFrontmatter(md)
  expect(body.startsWith('1. Call the Skill tool')).toBe(true)
  expect(referencedSkills(body)).toEqual(['writing-for-agents'])
  const prompt = skillForkPrompt('retro', body, [{ name: 'writing-for-agents', body: 'Be terse.' }])
  expect(prompt).toContain('/retro')
  expect(prompt).toContain('You cannot call tools')
  expect(prompt).toContain('<skill name="retro">\n1. Call the Skill tool')
  expect(prompt).toContain('<skill name="writing-for-agents">\nBe terse.\n</skill>')
  expect(sparkSvg(18)).toContain('animateTransform')
})

test('Session Recap opens a sidebar pane, runs /retro there in the background, then shows its output', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  // Anything that would write into the conversation trips these.
  const touched: string[] = []
  on('prompt.submit', ($, e) => {
    touched.push(`submit: ${e.text}`)
    throw new Error('the conversation was touched')
  })
  on('session.append', () => {
    touched.push('append')
    throw new Error('the conversation was touched')
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-5' }))
  on('session.cwd', () => ({ value: '/home/test/proj' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('command.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', ($, e) => {
    if (e.path === '/home/test/.claude/skills/retro/SKILL.md')
      return { value: '---\nname: retro\n---\nCall the Skill tool with `writing-for-agents` first.' }
    if (e.path === '/home/test/.claude/skills/writing-for-agents/SKILL.md') return { value: 'Be terse.' }
    return { deny: 'missing' }
  })
  // The panes the surface holds: what ui.open and ui.close do to them.
  const panes = new Map<string, { title: string; columns?: number }>()
  on('ui.panes', () => ({
    value: [...panes].map(([id, p]) => ({ id, title: p.title, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.open', ($, e) => {
    panes.set(e.id, { title: e.title ?? '', columns: e.columns })
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    panes.delete(e.id)
    return { value: undefined }
  })
  const prompts: string[] = []
  let answer: (text: string) => void = () => undefined
  on('model.fork', ($, e) => {
    prompts.push(e.prompt)
    return new Promise(resolve => {
      answer = text =>
        resolve({
          value: {
            isAnswered: true,
            text,
            usage: { input_tokens: 10, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        })
    })
  })

  await $.session.start({ cwd: '/home/test/proj', surface: null, isInteractive: false })
  await clock.settle()

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'retro-toggle' })
  await clock.settle()
  expect([...panes.keys()]).toEqual(['session-recap'])
  expect(panes.get('session-recap')?.title).toBe('Session Recap')
  // The band no longer holds the output.
  expect(await band.find({ type: 'Text', text: 'Thinking…' })).toBeUndefined()
  expect((await band.find({ key: 'retro-toggle' }))?.props['label']).toBe('Session Recap ✻')
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('<skill name="writing-for-agents">\nBe terse.\n</skill>')

  const PANE = {
    plugin: 'usage-band',
    component: 'Pane',
    requestId: 'session-recap',
    props: {
      title: 'Session Recap',
      isFocused: false,
      bodyColumns: 58,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  } as const
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desktop.find({ type: 'Text', text: 'Thinking…' })).toBeDefined()
  expect(await desktop.findAll({ type: 'Svg' })).toHaveLength(1)

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await terminal.find({ type: 'Text', text: '·' })).toBeDefined()
  await clock.advance(120)
  expect(await terminal.find({ type: 'Text', text: '✢' })).toBeDefined()
  await terminal.unmount()

  answer('## Findings\n\n1. Add a lint check.')
  await clock.settle()
  expect(await desktop.find({ type: 'Text', text: 'Thinking…' })).toBeUndefined()
  expect(await desktop.find({ key: 'retro-output' })).toBeDefined()
  expect(await desktop.find({ key: 'retro-run' })).toBeDefined()
  await desktop.unmount()
  // The fork's tokens count toward the session's.
  expect(await band.find({ type: 'Text', text: '300' })).toBeDefined()
  expect((await band.find({ key: 'retro-toggle' }))?.props['label']).toBe('Session Recap ▸')

  // Pressed again, the pane closes; reopened, the answer is there with no new run.
  await band.press({ key: 'retro-toggle' })
  expect(panes.size).toBe(0)
  await band.press({ key: 'retro-toggle' })
  await clock.settle()
  expect(panes.size).toBe(1)
  expect(prompts).toHaveLength(1)
  await band.unmount()

  expect(touched).toEqual([])
})

const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString()
const TRANSCRIPT = [
  { type: 'user', timestamp: at(0), message: { content: 'first prompt' } },
  { type: 'assistant', timestamp: at(30), message: { content: [] } },
  { type: 'user', timestamp: at(40), message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } },
  { type: 'assistant', timestamp: at(90), message: { content: [] } },
  { type: 'user', isMeta: true, timestamp: at(120), message: { content: 'a skill expanded' } },
  { type: 'user', timestamp: at(200), message: { content: [{ type: 'text', text: 'second' }] } },
  { type: 'assistant', timestamp: at(260), message: { content: [] } },
  { type: 'assistant', isSidechain: true, timestamp: at(400), message: { content: [] } },
  { type: 'system', timestamp: at(500) },
]
  .map(row => JSON.stringify(row))
  .join('\n')

test('turn time from a transcript: prompt to last reply, tools inside, side chains out', async () => {
  expect(transcriptTurnMs(TRANSCRIPT)).toBe(150_000)
  expect(transcriptTurnMs('not json\n')).toBe(0)
  expect(fmtMinutes(150_000)).toBe('2.5 min')
  expect(fmtMinutes(15 * 60_000)).toBe('15 min')
})

test('thinking time: the transcript before, then each turn once, live while one runs', async ($, on) => {
  const clock = mock.clock(on, { now: NOW + 600_000 })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  const PATH = '/home/test/.claude/projects/-home-test-proj/sess-6.jsonl'
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-6' }))
  on('session.cwd', () => ({ value: '/home/test/proj' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('command.list', () => ({ value: [] }))
  on('fs.exists', ($, e) => ({ value: e.path === PATH }))
  on('fs.read', ($, e) => (e.path === PATH ? { value: TRANSCRIPT } : { deny: 'missing' }))
  on('turn.start', () => ({ turnId: 't' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const complete = (durationMs: number) =>
    $.turn.complete({ answer: 'a', durationMs, isAborted: false, turnId: 't', reason: 'answer' })
  const shows = async (text: string) => {
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const found = await ui.find({ type: 'Text', text })
    await ui.unmount()
    return found !== undefined
  }

  await $.session.start({ cwd: '/home/test/proj', surface: null, isInteractive: false })
  await clock.settle()
  expect(await shows('2.5 min')).toBe(true)

  // A turn that began before the backfill counts only past it.
  await clock.advance(30_000)
  await complete(90_000)
  expect(await shows('3.0 min')).toBe(true)

  // A turn under way shows as of the clock's last tick (every 15 s); its end counts it once.
  await $.turn.start({ turnId: 't2', prompt: 'go' } as never)
  await clock.advance(60_000)
  expect(await shows('4.0 min')).toBe(true)
  await complete(60_000)
  expect(await shows('4.0 min')).toBe(true)

  // A subagent's turn is not the main thread's time.
  await $.turn.complete({ answer: 'a', durationMs: 600_000, isAborted: false, turnId: 's', agentId: 'sub', reason: 'answer' })
  expect(await shows('4.0 min')).toBe(true)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^─+$/ })).toBeDefined()
  expect(await ui.find({ key: 'retro-toggle' })).toBeDefined()
  expect(await ui.find({ key: 'hot-toggle' })).toBeDefined()
  await ui.unmount()
})

test('stages: used is done, an earlier one unused is skipped, a later one is ahead', async () => {
  expect(stageStatuses([])).toEqual(['ahead', 'ahead', 'ahead', 'ahead', 'ahead'])
  expect(stageStatuses(['implement'])).toEqual(['skipped', 'skipped', 'skipped', 'done', 'ahead'])
  expect(stageStatuses(['grill-with-docs', 'to-tickets'])).toEqual(['done', 'skipped', 'done', 'ahead', 'ahead'])
  expect(stageStatuses(['code-review', 'to-spec'])).toEqual(['skipped', 'done', 'skipped', 'skipped', 'done'])
  expect(stageOf('mattpocock-skills:code-review')).toBe('code-review')
  expect(stageOf('retro')).toBeUndefined()
  for (const alias of [
    'grill-with-docs',
    'grill-me',
    'grilling',
    'mattpocock-skills:grill-with-docs',
    'mattpocock-skills:grill-me',
    'mattpocock-skills:grilling',
    'matpocock-skill:grill-me',
  ]) {
    expect([alias, stageOf(alias)]).toEqual([alias, 'grill-with-docs'])
  }
  expect(stageOf('mattpocock-skills:to-tickets')).toBe('to-tickets')
  // A command on a line of its own, after an @-mention and a sentence, counts;
  // a session that fell back to `grilling` counts as the same stage.
  const dialog = [
    {
      role: 'user',
      text: '@"/Users/me/docs/integration.md"\nAdd the integration.\nAnalyse the project, then\n/mattpocock-skills:grill-with-docs \n where context is missing',
      toolUses: [],
    },
  ]
  expect(stagesInMessages(dialog)).toEqual(['grill-with-docs'])
  const fallback = [{ role: 'assistant', text: '', toolUses: [{ tool: 'Skill', input: { skill: 'mattpocock-skills:grilling' } }] }]
  expect(stagesInMessages(fallback)).toEqual(['grill-with-docs'])
  const rows = [
    { role: 'assistant', text: 'Next, /code-review.', toolUses: [{ tool: 'Skill', input: { skill: 'mattpocock-skills:to-spec' } }] },
    { role: 'user', text: '<command-message>grill-with-docs</command-message>\n<command-name>/grill-with-docs</command-name>', toolUses: [] },
    { role: 'user', text: '/implement the first ticket', toolUses: [] },
    { role: 'user', text: 'what does /to-tickets do?', toolUses: [] },
  ]
  expect(stagesInMessages(rows).sort()).toEqual(['grill-with-docs', 'implement', 'to-spec'])
})

test('Workflow stage paints what the conversation ran, in order', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-7' }))
  on('session.cwd', () => ({ value: '/home/test/proj' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('command.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  const conversation = [
    { role: 'user' as const, text: '<command-name>/grill-with-docs</command-name>', toolUses: [] },
    { role: 'assistant' as const, text: 'ok', toolUses: [{ tool_use_id: 'u', tool: 'Skill', input: { skill: 'to-tickets' } }] },
  ]
  on('session.messages', () => ({ value: conversation }))

  await $.session.start({ cwd: '/home/test/proj', surface: null, isInteractive: false })
  await clock.settle()

  // A stage's status, read off the icon beside its name.
  const pill = async (ui: { find: (q: { key: string }) => Promise<unknown> }, skill: string) => {
    for (const status of ['done', 'skipped', 'ahead'] as const) {
      if ((await ui.find({ key: `stage-icon-${skill}-${status}` })) !== undefined) return status
    }
    return 'missing'
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'Workflow stage' })).toBeUndefined()
    await ui.press({ key: 'stages-toggle' })
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: 'Workflow stage' })).toBeDefined()
    expect(await pill(ui, 'grill-with-docs')).toBe('done')
    expect(await pill(ui, 'to-spec')).toBe('skipped')
    expect(await pill(ui, 'to-tickets')).toBe('done')
    expect(await pill(ui, 'implement')).toBe('ahead')
    expect(await pill(ui, 'code-review')).toBe('ahead')
    expect(await ui.find({ type: 'Text', text: '2 of 5 used · 1 ignored' })).toBeDefined()
    // No filled pills: the name is plain text beside its icon.
    expect((await ui.find({ type: 'Text', text: '/grill-with-docs' }))?.props['color']).toBeUndefined()
    if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: '✓' })).toBeDefined()
    // Five stage icons, and the band's context bar.
    if (surface === 'desktop') expect(await ui.findAll({ type: 'Svg' })).toHaveLength(6)
    await ui.press({ key: 'stages-toggle' })
    await ui.unmount()
  }

  // A stage run later is picked up as it runs, and opening another panel closes this one.
  await $.skill.prompt({ skill: 'mattpocock-skills:code-review', text: 'x' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'stages-toggle' })
  await clock.settle()
  expect(await pill(ui, 'implement')).toBe('skipped')
  expect(await pill(ui, 'code-review')).toBe('done')
  await ui.press({ key: 'hot-toggle' })
  expect(await ui.find({ type: 'Text', text: 'Workflow stage' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Hot commands' })).toBeDefined()
  await ui.unmount()
})

test('a stage run while the panel stays open is caught: the prompt as sent, and the scan after each turn', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-8' }))
  on('session.cwd', () => ({ value: '/home/test/proj' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('command.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const conversation: { role: 'user' | 'assistant'; text: string; toolUses: { tool_use_id: string; tool: string; input: Record<string, unknown> }[] }[] = [
    { role: 'user', text: '/mattpocock-skills:grill-with-docs', toolUses: [] },
  ]
  on('session.messages', () => ({ value: conversation }))
  const status = async (skill: string) => {
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    // The panel is open from the first look on, as a person leaves it.
    if ((await ui.find({ type: 'Text', text: 'Workflow stage' })) === undefined) await ui.press({ key: 'stages-toggle' })
    await clock.settle()
    let found = 'missing'
    for (const s of ['done', 'skipped', 'ahead']) if ((await ui.find({ key: `stage-icon-${skill}-${s}` })) !== undefined) found = s
    await ui.unmount()
    return found
  }

  await $.session.start({ cwd: '/home/test/proj', surface: null, isInteractive: false })
  await clock.settle()
  expect(await status('grill-with-docs')).toBe('done')
  expect(await status('implement')).toBe('ahead')

  // Typed as the real dialog had it: the transcript's row is not needed for this.
  await $.prompt.submit({ text: '/implement фазу 5' } as never)
  await clock.settle()
  expect(await status('implement')).toBe('done')
  expect(await status('to-spec')).toBe('skipped')

  // A stage the model ran with the Skill tool turns up in the scan after its turn.
  conversation.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u', tool: 'Skill', input: { skill: 'mattpocock-skills:code-review' } }] })
  await $.turn.complete({ answer: 'a', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.settle()
  expect(await status('code-review')).toBe('done')
})

const DUP = 'https://linear.app/presidio/issue/DUP-983/close-the-stuck-vs-slow-export-gap'

test('Linear links: id, slug title, exact titles from Linear, and the session title', async () => {
  const links = linearLinks(`see ${DUP}?foo=1 and https://linear.app/presidio/issue/dup-7 again ${DUP}`)
  expect(links).toEqual([
    { id: 'DUP-983', title: 'Close the stuck vs slow export gap', url: DUP, isExact: false },
    { id: 'DUP-7', title: '', url: 'https://linear.app/presidio/issue/DUP-7', isExact: false },
  ])
  // list_issues and get_issue answer with `id` as the identifier; others say `identifier`.
  const listed = issueTitles('{"issues":[{"id":"DUP-983","title":"Close the \\"stuck vs. slow\\" export gap","url":"x"}],"hasNextPage":true}')
  expect(listed.get('DUP-983')).toBe('Close the "stuck vs. slow" export gap')
  expect(issueTitles('{"identifier":"ENG-1","id":"uuid","title":"T"}').get('ENG-1')).toBe('T')
  expect(issueTitles('not json').size).toBe(0)

  const exact = { id: 'DUP-983', title: 'Close the "stuck vs. slow" export gap', url: 'other', isExact: true }
  expect(mergeTasks(links, [exact])[0]).toEqual({ ...exact, url: DUP })
  expect(mergeTasks([exact], links)[0]).toEqual(exact)

  const rows = [
    { role: 'user', text: `do ${DUP}`, toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool: 'mcp__abc__get_issue', input: { id: 'DUP-983' }, text: '{"id":"DUP-983","title":"Exact one"}' }] },
    { role: 'assistant', text: `also ${'https://linear.app/presidio/issue/DUP-1/not-shared-by-person'}`, toolUses: [] },
  ]
  expect(tasksInMessages(rows)).toEqual([{ id: 'DUP-983', title: 'Exact one', url: DUP, isExact: true }])

  expect(titledWith([], 'Anything', '')).toBeUndefined()
  expect(titledWith(['DUP-983'], undefined, 'Close the gap')).toBe('DUP-983 | Close the gap')
  expect(titledWith(['DUP-983'], 'Export fixes', '')).toBe('DUP-983 | Export fixes')
  expect(titledWith(['DUP-983', 'DUP-7'], 'DUP-983 | Export fixes', '')).toBe('DUP-983, DUP-7 | Export fixes')
  expect(titledWith(['DUP-983'], 'DUP-983 | Export fixes', '')).toBeUndefined()
  expect(titledWith(['DUP-983'], 'DUP-983', 'Close the gap')).toBe('DUP-983 | Close the gap')
  // The app's generated title already names the team: the key is not repeated.
  expect(titledWith(['DUP-1008'], 'DUP backup та sync план', '')).toBe('DUP-1008 | backup та sync план')
  expect(titledWith(['DUP-1008'], 'DUP-1008: backup plan', '')).toBe('DUP-1008 | backup plan')
  // A title from before 1.5 (`·`) is moved to the new separator; a word that only looks like a key stays.
  expect(titledWith(['DUP-983'], 'DUP-983 · Export fixes', '')).toBe('DUP-983 | Export fixes')
  expect(titledWith(['DUP-983'], 'Duplicate exports', '')).toBe('DUP-983 | Duplicate exports')
})

test('a linked task shows under the divider as a link, its title fetched exactly, and the session renamed', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-9' }))
  on('session.cwd', () => ({ value: '/home/test/proj' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('command.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('session.messages', () => ({ value: [] }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('classic.UserPromptSubmit', () => ({}))
  on('tool.list', () => ({
    value: [
      { name: 'Read', description: '', mcp: false },
      { name: 'mcp__lin__get_issue', description: '', mcp: true },
      { name: 'mcp__lin__list_issue_statuses', description: '', mcp: true },
    ],
  }))
  on('tool.check', ($, e) => ({ decision: e.tool.startsWith('mcp__lin__') ? 'allow' : 'deny' }))
  const calls: string[] = []
  on('tool.call', ($, e) => {
    calls.push(`${e.tool} ${JSON.stringify((e as unknown as { id: string }).id)}`)
    return { result: {}, text: '{"id":"DUP-983","title":"Close the \\"stuck vs. slow\\" export gap","url":"x"}' }
  })

  await $.session.start({ cwd: '/home/test/proj', surface: null, isInteractive: false })
  await clock.settle()

  const prompt = `Let's do this one:\n${DUP}`
  await $.prompt.submit({ text: prompt } as never)
  const classic = await $.classic.UserPromptSubmit({ prompt, session_title: 'Export fixes' } as never)
  expect((classic as { sessionTitle?: string }).sessionTitle).toBe('DUP-983 | Export fixes')
  await clock.settle()
  expect(calls).toEqual(['mcp__lin__get_issue "DUP-983"'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'task-DUP-983' })).toBeDefined()
    const list = await ui.find({ key: 'tasks' })
    expect([list?.props['paddingX'], list?.props['paddingY']]).toEqual([2, 1])
    expect(await ui.find({ type: 'Text', text: 'DUP-983' })).toBeDefined()
    const link = await ui.find({ type: 'Link' })
    expect(link?.props['href']).toBe(DUP)
    expect(link?.props['label']).toBe('Close the "stuck vs. slow" export gap')
    await ui.unmount()
  }

  // Asked again, Linear is not called again: the title is kept.
  await $.prompt.submit({ text: `again ${DUP}` } as never)
  await clock.settle()
  expect(calls).toHaveLength(1)
})

test("Generate PR description runs /pr over the branch's changes in a sidebar, ready to copy", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-pr' }))
  on('session.cwd', () => ({ value: '/home/test/proj/app' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('command.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', ($, e) => {
    if (e.path === '/home/test/.claude/skills/pr/SKILL.md') return { value: '---\nname: pr\n---\nUse this template for writing the PR body.' }
    if (e.path === '/home/test/proj/GLOSSARY.md') return { value: 'Store: a Shopify shop.' }
    return { deny: 'missing' }
  })
  let isRepo = true
  const GIT: Record<string, string> = {
    'rev-parse --show-toplevel': '/home/test/proj\n',
    'rev-parse --abbrev-ref HEAD': 'feature/x\n',
    'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main\n',
    'merge-base HEAD origin/main': 'abc123def4567890\n',
    'log --no-merges --format=%h %s%n%b abc123def4567890..HEAD': 'a1b2c3 Add export retry\n',
    'status --short': '?? new-file.ts\n',
    'diff --stat abc123def4567890': ' src/export.ts | 12 ++++++\n',
  }
  const DIFF = 'diff --git a/src/export.ts b/src/export.ts\n+retry()\n'
  const diffArgs: string[] = []
  on('process.run', ($, e) => {
    const args = (e as unknown as { argv: string[] }).argv.slice(1).join(' ')
    if (args.startsWith('diff -U2 --no-color abc123def4567890 -- .')) diffArgs.push(args)
    const out = !isRepo ? undefined : args.startsWith('diff -U2 --no-color abc123def4567890 -- .') ? DIFF : GIT[args]
    return { value: { exitCode: out === undefined ? 128 : 0, stdout: out ?? '', stderr: out === undefined ? 'fatal: not a git repository' : '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const panes = new Map<string, string>()
  on('ui.panes', () => ({ value: [...panes].map(([id, title]) => ({ id, title, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.open', ($, e) => {
    panes.set(e.id, e.title ?? '')
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    panes.delete(e.id)
    return { value: undefined }
  })
  const prompts: string[] = []
  on('model.fork', ($, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: '## Summary\n\nRetry exports.', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  const copied: string[] = []
  on('ui.copy', ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  const completes: { model: string; prompt: string }[] = []
  on('model.complete', ($, e) => {
    completes.push({ model: e.model, prompt: e.prompt })
    return { value: { isAnswered: true, text: '## Summary\n\nCold run.', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })

  await $.session.start({ cwd: '/home/test/proj/app', surface: null, isInteractive: false })
  await clock.settle()
  // A turn just ended: the conversation's cache is warm, so the run forks over it.
  await $.turn.complete({ answer: 'a', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ key: 'pr-toggle' }))?.props['label']).toBe('Generate PR description ▸')
  await band.press({ key: 'pr-toggle' })
  await clock.settle()
  expect(panes.get('pr-description')).toBe('PR description')
  expect(prompts).toHaveLength(1)
  const prompt = prompts[0] ?? ''
  expect(prompt).toContain('/pr skill')
  expect(prompt).toContain('Reply with the PR body alone')
  expect(prompt).toContain('Branch feature/x, against origin/main (merge base abc123def456).')
  expect(prompt).toContain('a1b2c3 Add export retry')
  expect(prompt).toContain('?? new-file.ts')
  expect(prompt).toContain('+retry()')
  expect(prompt).toContain('Store: a Shopify shop.')
  // Lockfiles and builds are left out of the diff the model reads.
  expect(diffArgs[0]).toContain(':(exclude,glob)**/*-lock.json')
  expect(diffArgs[0]).toContain(':(exclude,glob)**/dist/*')

  const PANE = {
    plugin: 'usage-band',
    component: 'Pane',
    requestId: 'pr-description',
    props: { title: 'PR description', isFocused: false, bodyColumns: 58, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  } as const
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ key: 'pr-output' })).toBeDefined()
    await pane.press({ key: 'pr-copy' })
    await pane.unmount()
  }
  expect(copied).toEqual(['## Summary\n\nRetry exports.', '## Summary\n\nRetry exports.'])

  // An hour on, the cache has lapsed: the run goes without the conversation.
  await clock.advance(60 * 60_000)
  const cold = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await cold.press({ key: 'pr-run' })
  await clock.settle()
  expect(prompts).toHaveLength(1)
  expect(completes).toHaveLength(1)
  expect(completes[0]?.model).toBe('claude-opus-5-5')
  expect(completes[0]?.prompt).toContain('carry them out on what is gathered in <context> below')
  expect(completes[0]?.prompt).not.toContain('this conversation')
  expect(completes[0]?.prompt).toContain('+retry()')
  await cold.unmount()

  // Outside a repository the run fails with why, and no model call is made.
  isRepo = false
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'pr-run' })
  await clock.settle()
  expect(await pane.find({ type: 'Text', text: /Not a git repository/ })).toBeDefined()
  expect(prompts).toHaveLength(1)
  expect(completes).toHaveLength(1)
  await pane.unmount()
  await band.unmount()
})

test('in the desktop app the session is renamed through its own tools, after the turn, once', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-t' }))
  on('session.cwd', () => ({ value: '/home/test/proj' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('command.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('session.messages', () => ({ value: [] }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.UserPromptSubmit', () => ({}))
  on('tool.list', () => ({ value: [] }))
  // Allowed outright in this test: in auto mode an `ask` goes ahead too.
  on('tool.check', ($, e) => ({ decision: e.tool.startsWith('mcp__ccd_session_mgmt__') ? 'ask' : 'deny' }))
  let title = 'DUP backup та sync план'
  const sets: string[] = []
  on('tool.call', ($, e) => {
    const input = e as unknown as { tool: string; title?: string }
    if (input.tool === 'mcp__ccd_session_mgmt__get_session') return { result: {}, text: JSON.stringify({ sessionId: 'local_x', title }) }
    if (input.tool === 'mcp__ccd_session_mgmt__set_session_title') {
      sets.push(input.title ?? '')
      title = input.title ?? title
      return { result: {}, text: 'ok' }
    }
    return { deny: 'not here' }
  })
  const LINK = 'https://linear.app/presidio/issue/DUP-1008/dup-backup-and-sync-plan-sync-backups-only'

  await $.session.start({ cwd: '/home/test/proj', surface: null, isInteractive: false })
  await clock.settle()
  // Default mode: an `ask` is not taken, no dialog is opened for this.
  await $.classic.UserPromptSubmit({ prompt: `Read this task ${LINK}`, permission_mode: 'default' } as never)
  await $.prompt.submit({ text: `Read this task ${LINK}` } as never)
  await clock.settle()
  expect(sets).toEqual([])

  await $.classic.UserPromptSubmit({ prompt: 'go on', permission_mode: 'auto' } as never)
  await $.turn.complete({ answer: 'a', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.settle()
  expect(sets).toEqual(['DUP-1008 | backup та sync план'])

  // Already so: nothing more is set.
  await $.turn.complete({ answer: 'a', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.settle()
  expect(sets).toHaveLength(1)
})

test('a diff is cut per file and to a budget, every file named', async () => {
  const file = (name: string, size: number) => `diff --git a/${name} b/${name}\n${'+'.repeat(size)}\n`
  const diff = file('a.ts', 10) + file('big.ts', 50) + file('c.ts', 10) + file('d.ts', 10)
  const out = diffExcerpt(diff, 40, 160)
  expect(out).toContain('diff --git a/a.ts')
  expect(out).toContain('more characters of this file')
  expect(out).toContain('diff --git a/c.ts')
  expect(out).toContain('1 more files left out: d.ts')
  expect(diffExcerpt(file('a.ts', 5))).toBe(file('a.ts', 5))
})

test("tokens show as each response arrives, and the turn's own total replaces them", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  let usd = 0
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-live' }))
  on('session.cwd', () => ({ value: '/home/test/proj' }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 30, resetsAt: FIVE_RESET }], cost: { usd } },
  }))
  on('command.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const step = (out: number) => ({ input_tokens: 100, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' })
  let nextStep = step(1000)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: nextStep }
  })
  const shows = async (text: string) => {
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const found = await ui.find({ type: 'Text', text })
    await ui.unmount()
    return found !== undefined
  }
  const runStep = async (index: number) => {
    const stream = $.turn.step({ turnId: 't1', index, model: 'm', messageCount: 1 })
    for await (const _ of stream) {
      // The pieces of the response.
    }
  }

  await $.session.start({ cwd: '/home/test/proj', surface: null, isInteractive: false })
  await clock.settle()
  await runStep(0)
  nextStep = step(2000)
  await runStep(1)
  // Mid-turn: both responses' output counts already.
  expect(await shows('3.0k')).toBe(true)
  // The usage figures are read again right after: the cost moved with them.
  usd = 1.25
  await clock.advance(1_500)
  expect(await shows('$1.25')).toBe(true)
  // The turn ends with its own total, which replaces the two steps' (no double count).
  await $.turn.complete({ answer: 'a', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: step(3000) })
  expect(await shows('3.0k')).toBe(true)
  expect(await shows('6.0k')).toBe(false)
})

test('context zones: smart to 250k, then dumb, at the limit near the window or the auto-compact point', async () => {
  expect(contextZone(0, 1_000_000)).toBe('smart')
  expect(contextZone(249_999, 1_000_000)).toBe('smart')
  expect(contextZone(250_000, 1_000_000)).toBe('dumb')
  expect(contextZone(899_999, 1_000_000)).toBe('dumb')
  expect(contextZone(900_000, 1_000_000)).toBe('limit')
  // Auto-compaction earlier than 90% of the window marks the limit there.
  expect(contextZone(850_000, 1_000_000, 840_000)).toBe('limit')
  // A 200k window never leaves the smart zone before its limit.
  expect(contextZone(170_000, 200_000)).toBe('smart')
  expect(contextZone(185_000, 200_000)).toBe('limit')
  expect(fmtCompact(950)).toBe('950')
  expect(fmtCompact(132_400)).toBe('132k')
  expect(fmtCompact(1_000_000)).toBe('1M')
  expect(fmtCompact(1_250_000)).toBe('1.3M')
  const svg = contextBarSvg(300_000, 1_000_000, 200)
  expect(svg).toContain('fill="#E2B93B"')
  // The tick where the smart zone ends: 250k of 1M at 50 of 200 px.
  expect(svg).toContain('<rect x="50" width="1" height="5" fill="#97958E"/>')
  expect(contextBarSvg(100_000, 1_000_000, 200)).toContain('fill="#4A9C74"')
  expect(contextBarSvg(950_000, 1_000_000, 200)).toContain('fill="#F2464B"')
})

test('the band shows the context zone, its color and the fill', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-ctx' }))
  on('session.cwd', () => ({ value: '/home/test/proj' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('command.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  const zoneText = async (surface: 'terminal' | 'desktop') => {
    const ui = await $.ui.mount({ ...BAND, surface })
    const zone = await ui.find({ type: 'Text', text: /^(Smart zone|Dumb zone|Context limit)$/ })
    const fill = await ui.find({ type: 'Text', text: /^(\d+k? \/ 1M|—)$/ })
    await ui.unmount()
    return [zone?.text, zone?.props['color'], fill?.text]
  }
  const measure = (tokens: number) =>
    $.session.measure({ context: { window: 1_000_000, tokens, percent: tokens / 10_000 }, rateLimits: [], changed: ['context'] })

  await $.session.start({ cwd: '/home/test/proj', surface: null, isInteractive: false })
  await clock.settle()
  // Before the first response: the smart zone, no fill yet.
  expect(await zoneText('desktop')).toEqual(['Smart zone', '#4A9C74', '—'])

  await measure(132_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await zoneText(surface)).toEqual(['Smart zone', '#4A9C74', '132k / 1M'])
  }
  await measure(664_900)
  expect(await zoneText('desktop')).toEqual(['Dumb zone', '#E2B93B', '665k / 1M'])
  await measure(960_000)
  expect(await zoneText('terminal')).toEqual(['Context limit', '#F2464B', '960k / 1M'])
})

const PLAN = (five: number) =>
  JSON.stringify({
    plan: {
      status: 'ok',
      plan: 'Team',
      windows: [
        { label: '5-hour limit', percentUsed: five, resetsAt: FIVE_RESET, resetsIn: '3h 0m' },
        { label: 'Weekly · all models', percentUsed: 35, resetsAt: WEEK_RESET, resetsIn: '3d 21h' },
        { label: 'Extra usage', percentUsed: 1 },
      ],
    },
    context: { session: 'self', status: 'ok' },
  })

test("limits without a response: the app's usage card, else the last kept, a window past its reset shown reset", async () => {
  expect(planRows(PLAN(2))).toEqual([
    { kind: 'five_hour', percentUsed: 2, resetsAt: FIVE_RESET },
    { kind: 'seven_day', percentUsed: 35, resetsAt: WEEK_RESET },
  ])
  expect(planRows(JSON.stringify({ plan: { status: 'unavailable', note: 'try later' } }))).toEqual([])
  expect(planRows('not json')).toEqual([])

  const kept = {
    rows: [
      { kind: 'five_hour', percentUsed: 52, resetsAt: '2026-10-09T11:00:00.000Z' },
      { kind: 'seven_day', percentUsed: 18, resetsAt: WEEK_RESET },
    ],
    at: NOW - 3 * 3_600_000,
  }
  expect(keptLimits(kept, NOW)).toEqual([
    { kind: 'five_hour', percentUsed: 0 },
    { kind: 'seven_day', percentUsed: 18, resetsAt: WEEK_RESET },
  ])
  expect(keptLimits(undefined, NOW)).toEqual([])
})

test('a new session shows the limits before its first response, and follows them while idle', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-plan' }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.cwd', () => ({ value: '/home/test/proj' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('command.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('session.messages', () => ({ value: [] }))
  on('tool.list', () => ({ value: [] }))
  on('tool.check', ($, e) => ({ decision: e.tool === 'mcp__ccd_session_mgmt__get_usage' ? 'allow' : 'deny' }))
  let five = 2
  let calls = 0
  on('tool.call', ($, e) => {
    if ((e as unknown as { tool: string }).tool !== 'mcp__ccd_session_mgmt__get_usage') return { deny: 'not here' }
    calls++
    return { result: {}, text: PLAN(five) }
  })

  await $.session.start({ cwd: '/home/test/proj', surface: null, isInteractive: false })
  await clock.settle()
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /first API response/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '2%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '35%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'in 3h 0m' })).toBeDefined()
  await ui.unmount()
  expect(calls).toBe(1)

  // Idle, other sessions use the limits: read again once a minute, not each tick.
  five = 9
  await clock.advance(30_000)
  expect(calls).toBe(1)
  await clock.advance(45_000)
  expect(calls).toBe(2)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '9%' })).toBeDefined()
  await ui.unmount()

  // A response's own reading is fresher: no app read while they keep coming.
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 11, resetsAt: FIVE_RESET }],
    changed: ['rateLimits'],
  })
  await clock.advance(30_000)
  expect(calls).toBe(2)
})

test('a session with no reading starts from the last one kept', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, {
    limits: { rows: [{ kind: 'five_hour', percentUsed: 27, resetsAt: FIVE_RESET }], at: NOW - 60_000 },
  })
  mock.env(on, { HOME: '/home/test' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-kept' }))
  on('session.cwd', () => ({ value: '/home/test/proj' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('command.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('session.messages', () => ({ value: [] }))
  on('tool.list', () => ({ value: [] }))
  on('tool.check', () => ({ decision: 'deny' }))

  await $.session.start({ cwd: '/home/test/proj', surface: null, isInteractive: false })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '27%' })).toBeDefined()
  await ui.unmount()
})

/** A band with limits, a context fill and tokens, set up as a session starts. */
function bandSession(on: On, id: string) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: id }))
  on('session.cwd', () => ({ value: '/home/test/proj' }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { tokens: 132_000, window: 1_000_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 52, resetsAt: FIVE_RESET }],
      cost: { usd: 1.5 },
    },
  }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('session.messages', () => ({ value: [] }))
  on('tool.list', () => ({ value: [] }))
  on('tool.check', () => ({ decision: 'deny' }))
  return clock
}

test('settings: every part shows unless its option is false, a local choice over it', async () => {
  expect(shownFrom({})).toEqual({ limits: true, context: true, session: true, buttons: true })
  expect(shownFrom({ showLimits: false, showButtons: true })).toEqual({
    limits: false,
    context: true,
    session: true,
    buttons: true,
  })
  expect(shownFrom({ showLimits: false }, { limits: true, session: false }).limits).toBe(true)
  expect(shownFrom({ showLimits: false }, { limits: true, session: false }).session).toBe(false)
})

test(
  'the band draws only the parts the options show',
  { options: { showLimits: false, showButtons: false } },
  async ($, on) => {
    const clock = bandSession(on, 'sess-opt')
    await $.session.start({ cwd: '/home/test/proj', surface: null, isInteractive: false })
    await clock.settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: '5h' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /first API response/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'resets' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'context' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Smart zone' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'session' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'thinking' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'stages-toggle' })).toBeUndefined()
      expect(await ui.find({ type: 'Button', key: 'settings-toggle' })).toBeUndefined()
      await ui.unmount()
    }
  },
)

test(
  'with every part hidden the band steps aside, and /usage-band brings Settings back',
  { options: { showLimits: false, showContext: false, showSession: false, showButtons: false } },
  async ($, on) => {
    const clock = bandSession(on, 'sess-none')
    // The engine's own band beneath, empty.
    on('ui.render', ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box key="engine-band" />
    })
    await $.session.start({ cwd: '/home/test/proj', surface: null, isInteractive: false })
    await clock.settle()
    let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'context' })).toBeUndefined()
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await ui.unmount()

    const ran = await $.command.run({ command: 'usage-band', args: '' } as never)
    expect(ran.text).toContain('open')
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'Settings' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'show-limits' })).toBeDefined()
    await ui.unmount()
  },
)

test("Settings writes the plugin's own setting, and the band follows at once", async ($, on) => {
  const clock = bandSession(on, 'sess-set')
  const rows: ConfigRow[] = [
    { key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', provider: { plugin: 'engine', tier: 'core' }, isLocked: false },
    { key: 'usage-band.showContext', label: 'Context and zone', kind: 'boolean', value: true, provider: { plugin: 'usage-band', tier: 'user' }, isLocked: false },
  ]
  on('config.list', () => ({ value: rows }))
  const sets: { key: string; value: unknown }[] = []
  on('config.set', ($, e) => {
    sets.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  await $.session.start({ cwd: '/home/test/proj', surface: null, isInteractive: false })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: 'context' })).toBeDefined()
      await ui.press({ key: 'settings-toggle' })
      expect(await ui.find({ type: 'Text', text: 'Settings' })).toBeDefined()
      expect((await ui.find({ type: 'Button', key: 'show-context' }))?.props.label).toBe('☑ Context and zone')
      await ui.press({ key: 'show-context' })
      expect(sets).toEqual([{ key: 'usage-band.showContext', value: false }])
    }
    expect(await ui.find({ type: 'Text', text: 'context' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Smart zone' })).toBeUndefined()
    expect((await ui.find({ type: 'Button', key: 'show-context' }))?.props.label).toBe('☐ Context and zone')
    await ui.unmount()
  }

  // Where no settings row takes it, the choice is kept in the store.
  rows.length = 0
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'show-session' })
  expect(await ui.find({ type: 'Text', text: 'session' })).toBeUndefined()
  await ui.unmount()
  // and a session starting later reads it back.
  await $.session.start({ cwd: '/home/test/proj', surface: null, isInteractive: false })
  await clock.settle()
  const later = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await later.find({ type: 'Text', text: 'session' })).toBeUndefined()
  expect(await later.find({ type: 'Text', text: '5h' })).toBeDefined()
  await later.unmount()
})
