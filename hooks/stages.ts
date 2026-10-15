// Workflow stage: a task's phases, and which of them a conversation ran.

import { SLASH_COMMAND } from './skills'

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

export type MessageRow = {
  role: string
  text: string
  toolUses: readonly { tool: string; input: Record<string, unknown>; text?: string }[]
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
