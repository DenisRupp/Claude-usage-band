// Thinking time: a turn's length, read from a transcript.

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
