// Linear issues a conversation links: their ids, titles, and the session's title.

import type { LinearTask } from '../types'
import type { MessageRow } from './stages'

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

// A Linear issue link: linear.app/<workspace>/issue/<ID>/<slug of its title>.
const LINEAR_LINK = /https?:\/\/linear\.app\/([\w.-]+)\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/([A-Za-z0-9%._~-]+))?/g
const ISSUE_ID = /^[A-Z][A-Z0-9]*-\d+$/
// The ids this mod puts before a session's title: `DUP-1, DUP-2 | ` (`·` before 1.5), or the ids alone.
const TITLE_PREFIX = /^[A-Z][A-Z0-9]*-\d+(?:,\s*[A-Z][A-Z0-9]*-\d+)*\s*[|·]\s*/
const TITLE_SEPARATOR = ' | '
const TITLE_IDS_ONLY = /^[A-Z][A-Z0-9]*-\d+(?:,\s*[A-Z][A-Z0-9]*-\d+)*$/

/** A title from a link's slug: `close-the-stuck-vs-slow-gap` → `Close the stuck vs slow gap`. */
function slugTitle(slug: string | undefined): string {
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

// The desktop app's own tools for this session's title.
export const GET_SESSION = 'mcp__ccd_session_mgmt__get_session'
export const SET_TITLE = 'mcp__ccd_session_mgmt__set_session_title'
