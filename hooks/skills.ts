// Hot commands: the skills the person used, read from transcripts and SKILL.md files.

import type { UsedSkill } from '../types'

const RECENT_KEEP = 30
export const HOT_SHOWN = 12
export const SCAN_FILES = 25
export const SCAN_MAX_BYTES = 4 * 1024 * 1024
export const SCAN_FLAG = 'skillsScan:v1'

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

const SKILL_TOOL = /"name":"Skill","input":\{"skill":"([^"]+)"/g
export const SLASH_COMMAND = /<command-name>\/?([^<\s]+)<\/command-name>/g
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
