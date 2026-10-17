import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isPlainObject } from './patterns.js'

const SHELL_TOOLS = new Set(['bash', 'pwsh'])
const SEARCH_TOOLS = new Set(['grep', 'glob'])

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
 * Each segment carries `trailingSeparator`: the separator that follows the
 * segment (`&&`, `||`, `;`, CR or newline), or null on the last segment; the
 * resolver's `||` bail reads it. Quotes are tracked only so a separator inside
 * a quoted target stays literal.
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
      segments.push({ text: current, trailingSeparator: '&&' })
      current = ''
      index += 1
      continue
    }
    if (char === '|' && command[index + 1] === '|') {
      segments.push({ text: current, trailingSeparator: '||' })
      current = ''
      index += 1
      continue
    }
    if (char === ';' || char === '\n' || char === '\r') {
      segments.push({ text: current, trailingSeparator: char })
      current = ''
      continue
    }
    current += char
  }
  segments.push({ text: current, trailingSeparator: null })
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
    // One quoted string, closed exactly once with nothing but spaces after it.
    const end = text.indexOf(quote, 1)
    if (end === -1 || text.slice(end + 1).trim() !== '') return null
    target = text.slice(1, end)
    if (target === '' || /[\0\r\n]/.test(target)) return null
    // A single-quoted word is fully literal in POSIX shells: `$`, backticks and
    // backslashes are ordinary characters, so only NUL/CR/LF are rejected (above).
    // A double-quoted word still expands `$` and backticks and lets a backslash
    // escape; on win32 pwsh a backslash is a separator, so it is allowed there.
    if (quote === '"' && (target.includes('$') || target.includes('`') || (!windows && target.includes('\\')))) return null
  } else {
    if (/\s/.test(text) || (windows ? UNSAFE_BARE_WINDOWS : UNSAFE_BARE).test(text)) return null
    target = text
    bare = true
  }

  // `cd -`, `cd --` and `cd -P` are options/failures, never directories.
  if (target.startsWith('-')) return null

  if (bare && target.startsWith('~')) {
    if (target === '~') return homeDirectory
    if (target.startsWith('~/')) return path.resolve(homeDirectory, '.' + target.slice(1))
    return null // `~user` is not modelled
  }

  return target
}

/**
 * Pure Shell-Declared Directory resolver: apply a command's leading literal
 * `cd` chain on top of a base directory. `(args, baseDirectory, options)` fully
 * determines the result, where `options` carries `homeDirectory` and `windows`;
 * no I/O and no shell execution.
 */
function resolveShellDeclaredDirectory(args, baseDirectory, options) {
  const { command } = args
  if (typeof command !== 'string' || !command.trim()) return baseDirectory

  let directory = baseDirectory
  for (const segment of splitSegments(command)) {
    const text = segment.text.trim()
    if (!text) continue
    const match = /^cd(?:\s+([\s\S]*))?$/.exec(text)
    if (!match) break
    const target = parseCdTarget(match[1] ?? '', options)
    if (target == null) return baseDirectory
    directory = path.resolve(directory, target)
    // `cd a || cd b` picks a directory only when a failed; never guess which
    // side ran, so the whole chain is void.
    if (segment.trailingSeparator === '||') return baseDirectory
  }
  return directory
}

/**
 * Declared Search Path: the directory a search tool's `path` argument scopes the
 * search to. It resolves against the session cwd; a directory is itself, a
 * regular file resolves to its parent directory, and anything else — a missing,
 * unreadable or non-file/non-directory path — is ignored in favour of the
 * session cwd. The resolved directory must also be readable and searchable, so
 * the answer is one the search itself could have used. A failed stat or access
 * check must never fail the call, so every I/O error is a fallback, not a throw.
 */
function resolveDeclaredSearchPath(args, sessionCwd) {
  if (typeof args.path !== 'string' || !args.path) return sessionCwd

  const declared = path.resolve(sessionCwd, args.path)
  try {
    const stats = fs.statSync(declared)
    const directory = stats.isDirectory() ? declared : stats.isFile() ? path.dirname(declared) : null
    if (directory) {
      // An existing directory can still be unreadable or unsearchable. A root
      // the search itself could not have read is not the directory it used.
      fs.accessSync(directory, fs.constants.R_OK | fs.constants.X_OK)
      return directory
    }
  } catch {
    // ENOENT/EACCES/ENOTDIR: the search still ran somewhere, but the adapter
    // cannot tell where; the session cwd stays the only safe answer.
  }
  return sessionCwd
}

/**
 * Resolve the Augment Root for one tool call: the directory GitNexus runs in.
 * Shell tools contribute their declared workdir with the command's leading
 * literal `cd` chain overlaid; search tools contribute their declared `path`;
 * every other call uses the session cwd.
 */
export function resolveAugmentRoot(execution) {
  const sessionCwd = sessionDirectory(execution)
  const args = isPlainObject(execution?.arguments) ? execution.arguments : {}

  if (SHELL_TOOLS.has(execution?.name)) {
    const base = declaredWorkdir(args, sessionCwd)
    return resolveShellDeclaredDirectory(args, base, {
      homeDirectory: os.homedir(),
      windows: execution?.name === 'pwsh' && process.platform === 'win32',
    })
  }

  if (SEARCH_TOOLS.has(execution?.name)) return resolveDeclaredSearchPath(args, sessionCwd)

  return sessionCwd
}
