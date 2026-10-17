import os from 'node:os'
import path from 'node:path'
import { isPlainObject } from './patterns.js'

const SHELL_TOOLS = new Set(['bash', 'pwsh'])

/**
 * Session CWD: the directory the session was started in. It never changes when
 * a shell command runs `cd`, so it is only the fallback, never the answer for a
 * call that declares (or literally enters) another directory.
 */
function sessionDirectory(execution) {
  const cwd = execution?.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd) return path.resolve(cwd)
  return path.resolve(process.cwd())
}

/** Declared Workdir: a shell call's explicit base directory. */
function declaredWorkdir(args, sessionCwd) {
  if (typeof args.workdir !== 'string' || !args.workdir) return sessionCwd
  return path.isAbsolute(args.workdir) ? path.resolve(args.workdir) : path.resolve(sessionCwd, args.workdir)
}

/**
 * Split a command into segments at unquoted `&&`, `||`, `;`, CR and newline.
 * Quotes are tracked only so a separator inside a quoted target stays literal.
 */
function splitSegments(command) {
  const segments = []
  let current = ''
  let quote = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }
    if (char === '&' && command[index + 1] === '&') {
      segments.push({ text: current, separator: '&&' })
      current = ''
      index += 1
      continue
    }
    if (char === '|' && command[index + 1] === '|') {
      segments.push({ text: current, separator: '||' })
      current = ''
      index += 1
      continue
    }
    if (char === ';' || char === '\n' || char === '\r') {
      segments.push({ text: current, separator: char })
      current = ''
      continue
    }
    current += char
  }
  segments.push({ text: current, separator: null })
  return segments
}

// A bare target must be one literal word: no expansions, no glob/brace
// characters, no grouping, no redirection, no shell operators, no quotes.
// On win32 pwsh a backslash is a separator, so it is allowed there only.
const UNSAFE_BARE = /[$`\\*?[\]{}()&|;<>'"]/
const UNSAFE_BARE_WINDOWS = /[$`*?[\]{}()&|;<>'"]/

/**
 * Parse the target of one `cd` segment into a path, or null when it cannot be
 * resolved without running a shell. This is the conservative half of the
 * grammar: every rejected form voids the entire leading chain.
 */
function parseCdTarget(raw, { homeDirectory, windows }) {
  const text = raw.trim()
  if (!text) return null

  let target
  let bare = false
  const quote = text[0]

  if (quote === "'" || quote === '"') {
    // One single- or double-quoted string, no escapes, nothing after it.
    const end = text.indexOf(quote, 1)
    if (end === -1 || text.slice(end + 1).trim() !== '') return null
    target = text.slice(1, end)
    if (target === '' || /[\0\r\n]/.test(target)) return null
    if (!windows && target.includes('\\')) return null
    // Double quotes still expand `$` and backticks; single quotes do not, but
    // rejecting both keeps one rule for "quoted without expansion".
    if (target.includes('$') || target.includes('`')) return null
  } else {
    if (/\s/.test(text) || (windows ? UNSAFE_BARE_WINDOWS : UNSAFE_BARE).test(text)) return null
    target = text
    bare = true
  }

  // `cd -`, `cd --` and `cd -P` are options/failures, never directories.
  if (target.startsWith('-')) return null

  if (bare && target.startsWith('~')) {
    if (target === '~') return homeDirectory
    if (target.startsWith('~/')) return path.resolve(homeDirectory, target.slice(2))
    return null // `~user` is not modelled
  }

  return target
}

/**
 * Pure Shell-Declared Directory resolver: apply a command's leading literal
 * `cd` chain on top of a base directory. `(command, baseDirectory,
 * homeDirectory, options.windows)` fully determines the result; no I/O and no
 * shell execution.
 */
export function resolveShellDeclaredDirectory(command, baseDirectory, homeDirectory, { windows = false } = {}) {
  if (typeof command !== 'string' || !command.trim()) return baseDirectory

  let directory = baseDirectory
  for (const segment of splitSegments(command)) {
    const text = segment.text.trim()
    if (!text) continue
    const match = /^cd(?:\s+([\s\S]*))?$/.exec(text)
    if (!match) break
    const target = parseCdTarget(match[1] ?? '', { homeDirectory, windows })
    if (target == null) return baseDirectory
    directory = path.resolve(directory, target)
    // `cd a || cd b` picks a directory only when a failed; never guess which
    // side ran, so the whole chain is void.
    if (segment.separator === '||') return baseDirectory
  }
  return directory
}

/**
 * Search-tool hook (ticket #3): a declared `path` resolves against the session
 * cwd, a directory is itself, a file resolves to its parent directory, and any
 * stat failure falls back to the session cwd. Ticket #2 only reserves this
 * separated hook and deliberately keeps `grep`/`glob` on the session cwd.
 */
export function resolveDeclaredSearchPath(execution, sessionCwd) {
  void execution
  return sessionCwd
}

/**
 * Resolve the Augment Root for one tool call: the directory GitNexus runs in.
 * Shell tools contribute their declared workdir with the command's leading
 * literal `cd` chain overlaid; every other call uses the session cwd.
 */
export function resolveAugmentRoot(execution) {
  const sessionCwd = sessionDirectory(execution)
  const args = isPlainObject(execution?.arguments) ? execution.arguments : {}

  if (SHELL_TOOLS.has(execution?.name)) {
    const base = declaredWorkdir(args, sessionCwd)
    return resolveShellDeclaredDirectory(args.command, base, os.homedir(), {
      windows: execution?.name === 'pwsh' && process.platform === 'win32',
    })
  }

  return sessionCwd
}
