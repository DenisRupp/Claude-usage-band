// Session Recap and PR description: what the background run is given and how it is asked.

import type { BoxProps, ButtonProps, ElementConstructor, MarkdownProps, RenderElement, TextProps, UiPressArgument } from 'claude-code'
import type { RetroRun } from '../types'
import { SPARK_HEX } from './theme'

// The terminal's thinking glyphs, as Claude Code's own spinner cycles them.
export const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
export const SPIN_MS = 120
export const RETRO_SKILL = 'retro'
// Session Recap's output shows in a pane: a sidebar where the surface docks one.
export const RECAP_TITLE = 'Session Recap'
export const RECAP_COLUMNS = 60
// The diff the PR description is written from: every file, each cut to a few
// thousand characters, the whole to a budget; noise (lockfiles, builds) left out.
const DIFF_MAX = 60_000
const DIFF_FILE_MAX = 4_000
export const DIFF_NOISE = ['*.lock', '*-lock.json', '*.lockb', '*.min.*', '*.map', '*.snap', 'dist/*', 'build/*']
export const GLOSSARY_MAX = 12_000
// Past this since the last turn the conversation's cache entry has likely
// lapsed: a fork would bill the whole conversation afresh, so the PR run
// goes without it, from the skill and the branch's changes alone.
export const FORK_WARM_MS = 50 * 60_000
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

/** A run not started. */
export const IDLE: RetroRun = { status: 'idle', text: '', startedAt: 0, finishedAt: 0 }

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

/** A skill run in the background whose output shows in a sidebar pane. */
export type SkillPane = {
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

export function failure(reason: string): string {
  if (reason === 'nothing-to-fork') return 'Nothing to look back on yet: this conversation has no reply so far.'
  if (reason === 'empty-reply') return 'The model returned nothing.'
  if (reason === 'aborted') return 'The run was cancelled.'
  return `The model call failed (${reason}).`
}

/** A skill pane's body: the run's scope, then the spark, its error, or its answer with Copy and Run again. */
export function skillPaneBody(
  spec: SkillPane,
  run: RetroRun,
  els: {
    Box: ElementConstructor<BoxProps>
    Text: ElementConstructor<TextProps>
    Button: ElementConstructor<ButtonProps>
    Markdown: ElementConstructor<MarkdownProps>
  },
  spark: RenderElement,
  act: { copy: (press: UiPressArgument) => void; runAgain: () => void },
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
                onPress={act.copy}
              />
            ) : null}
            <Button key={`${spec.key}-run`} label="Run again" onPress={act.runAgain} />
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
