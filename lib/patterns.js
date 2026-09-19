/** Pure extraction rules shared by the adapter and its tests. */

const SHELL_TOOLS = new Set(['bash', 'pwsh'])
const FLAGS_WITH_VALUES = new Set([
  '-e',
  '-f',
  '-m',
  '-A',
  '-B',
  '-C',
  '-g',
  '--glob',
  '-t',
  '--type',
  '--include',
  '--exclude',
])

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function extractShellPattern(command) {
  if (typeof command !== 'string' || !/\brg\b|\bgrep\b/.test(command)) return null

  const tokens = command.split(/\s+/)
  let foundCommand = false
  let skipNext = false

  for (const token of tokens) {
    if (skipNext) {
      skipNext = false
      continue
    }
    if (!foundCommand) {
      if (/\brg$|\bgrep$/.test(token)) foundCommand = true
      continue
    }
    if (token.startsWith('-')) {
      if (FLAGS_WITH_VALUES.has(token)) skipNext = true
      continue
    }
    const cleaned = token.replace(/['"]/g, '')
    return cleaned.length >= 3 ? cleaned : null
  }
  return null
}

// Stem of one glob path segment, or null when the segment names no word.
//
// Wildcards are dropped and the last extension is cut, so `*.test.js` yields
// `test`. A segment that is nothing but an extension (`*.ts`, `*.json`) offers
// no stem: the CLI returns nothing for a bare extension, so it stays
// unresolved rather than spending a call on one.
function segmentStem(segment) {
  const bare = segment.replace(/\*/g, '')
  const dot = bare.lastIndexOf('.')
  const stem = (dot === -1 ? bare : bare.slice(0, dot)).replace(/^\.+/, '')
  return /^[A-Za-z][A-Za-z0-9_-]{2,}$/.test(stem) ? stem : null
}

export function extractSearchPattern(execution) {
  const name = execution?.name
  const args = isPlainObject(execution?.arguments) ? execution.arguments : {}

  if (name === 'grep') {
    return typeof args.pattern === 'string' && args.pattern.length >= 3 ? args.pattern : null
  }

  if (name === 'glob') {
    const raw = typeof args.pattern === 'string' ? args.pattern : ''
    // Only the last segment names the files being selected. Keying on an
    // earlier one searches for a directory instead (packages/foo/Bar.ts -> foo).
    return segmentStem(raw.split('/').filter(Boolean).at(-1) ?? '')
  }

  if (SHELL_TOOLS.has(name)) return extractShellPattern(args.command)
  return null
}

export function isGitMutationCommand(command) {
  return typeof command === 'string' && /\bgit\s+(commit|merge|rebase|cherry-pick|pull)(\s|$)/.test(command)
}

export function extractExitCode(result) {
  if (!result || result.isError) return null
  const value = result.value
  if (isPlainObject(value)) {
    if (value.kind === 'foreground' && Number.isInteger(value.exitCode)) return value.exitCode
    if (value.kind === 'background') return null
  }

  const text = Array.isArray(result.content)
    ? result.content
        .filter(block => isPlainObject(block) && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n')
    : ''
  const matches = [...text.matchAll(/\[exit code: (\d+)\]/g)]
  if (matches.length === 0) return null
  const parsed = Number.parseInt(matches.at(-1)[1], 10)
  return Number.isInteger(parsed) ? parsed : null
}

export function isSafePattern(pattern) {
  return (
    typeof pattern === 'string' &&
    pattern.length >= 3 &&
    pattern.length <= 512 &&
    !/[\0\r\n]/.test(pattern)
  )
}
