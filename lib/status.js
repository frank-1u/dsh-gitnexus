/** Parsing helpers for `gitnexus status --json`. */

function tryParse(value) {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

export function parseStatusOutput(output) {
  const lines = String(output ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = tryParse(lines[index])
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.schemaVersion === 1) {
      return parsed
    }
  }
  return null
}

export function staleStatusMessage(status) {
  if (!status || status.error !== undefined || status.status !== 'stale') return null

  const indexed = typeof status.index?.commit === 'string' ? status.index.commit.slice(0, 7) : 'unknown'
  const current = typeof status.current?.commit === 'string' ? status.current.commit.slice(0, 7) : 'unknown'
  const branch = typeof status.branch === 'string' ? ` on branch ${status.branch}` : ''

  return (
    `GitNexus index is stale${branch} (last indexed: ${indexed}; current HEAD: ${current}). ` +
    'Run `gitnexus analyze --index-only` to update the knowledge graph without rewriting agent docs.'
  )
}

export function extractAugmentContext(stderr, maxChars = 12000) {
  const output = String(stderr ?? '').trim()
  const marker = output.indexOf('[GitNexus]')
  if (marker === -1) return ''

  let context = output.slice(marker).trim()
  if (context.length > maxChars) {
    context = `${context.slice(0, maxChars)}\n[GitNexus context truncated at ${maxChars} characters]`
  }
  return context
}
