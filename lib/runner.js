import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const WINDOWS = process.platform === 'win32'

function pathEntries(value) {
  return String(value ?? '')
    .split(path.delimiter)
    .map(entry => entry.replace(/^"|"$/g, ''))
    .filter(Boolean)
}

function executableExtensions() {
  if (!WINDOWS) return ['']
  const extensions = String(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
  return ['.CMD', '.EXE', '.BAT', ...extensions]
    .filter((value, index, all) => all.indexOf(value) === index)
}

export function resolveOnPath(command) {
  if (typeof command !== 'string' || !command || command.includes('\0')) return null
  const target = command.replace(/"/g, '')
  if (target.includes('/') || target.includes('\\')) {
    return fs.existsSync(target) ? target : null
  }

  for (const directory of pathEntries(process.env.PATH)) {
    for (const extension of executableExtensions()) {
      const candidate = path.join(directory, `${target}${extension}`)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}

function isJavaScriptFile(file) {
  return /\.(cjs|mjs|js)$/i.test(file)
}

function isWindowsScript(file) {
  return WINDOWS && /\.(cmd|bat)$/i.test(file)
}

function inferGitNexusCliFromScript(script) {
  return path.join(path.dirname(script), 'node_modules', 'gitnexus', 'dist', 'cli', 'index.js')
}

/**
 * The Node host this plugin runs inside. Electron embeds its own Node build, so
 * `process.execPath` is the Electron binary and its `NODE_MODULE_VERSION`
 * does not match the system Node — a native addon (GitNexus ships LadybugDB)
 * aborts with "DLL initialization routine failed". Captured once so tests can
 * substitute a host.
 */
const HOST = Object.freeze({
  electron: typeof process.versions?.electron === 'string',
  execPath: process.execPath,
})

function sameProgram(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  return WINDOWS ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Only the Electron binary needs the flag that makes it behave as Node. */
function runnerEnvironment(runner) {
  return runner.electronRunAsNode === true ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
}

/** Split a configured command into an executable and leading arguments. */
export function splitCommandLine(line) {
  const value = String(line ?? '').trim()
  const tokens = []
  let current = ''
  let quote
  let escaped = false

  for (const character of value) {
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === '\\') {
      current += character
      escaped = true
      continue
    }
    if (character === quote) {
      quote = undefined
      continue
    }
    if (quote === undefined && (character === '"' || character === "'")) {
      quote = character
      continue
    }
    if (quote === undefined && /\s/.test(character)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += character
  }
  if (quote !== undefined) return null
  if (current) tokens.push(current)
  return tokens.length === 0 ? null : tokens
}

/**
 * Choose the Node executable for a JavaScript CLI entry point.
 *
 * Electron's `process.execPath` is the Electron binary, and
 * `ELECTRON_RUN_AS_NODE` only changes what that binary does — not the
 * `NODE_MODULE_VERSION` it reports. A GitNexus CLI hosted that way starts and
 * then dies loading its native addon, so `augment` exits non-zero and injects
 * nothing. Prefer a genuine Node: the shim's sibling `node.exe` first (npm's
 * own convention), then `node` on `PATH`, and the Electron binary only as a
 * last resort.
 */
export function resolveNodeProgram(script, host = HOST) {
  if (!host.electron) return { program: host.execPath, electronRunAsNode: false }

  const sibling = path.join(path.dirname(script), WINDOWS ? 'node.exe' : 'node')
  if (!sameProgram(sibling, host.execPath) && fs.existsSync(sibling)) {
    return { program: sibling, electronRunAsNode: false }
  }
  const onPath = resolveOnPath('node')
  if (onPath !== null && !sameProgram(onPath, host.execPath)) {
    return { program: onPath, electronRunAsNode: false }
  }
  return { program: host.execPath, electronRunAsNode: true }
}

export function prepareCliRunner(command, host = HOST) {
  const tokens = splitCommandLine(command)
  if (tokens === null) throw new Error(`dsh-gitnexus: invalid cliCommand: ${command}`)

  const [configuredProgram, ...leadingArgs] = tokens
  const resolved = resolveOnPath(configuredProgram)
  if (!resolved) throw new Error(`dsh-gitnexus: cannot resolve cliCommand executable: ${configuredProgram}`)

  if (isJavaScriptFile(resolved)) {
    return { ...resolveNodeProgram(resolved, host), args: [resolved, ...leadingArgs] }
  }
  if (isWindowsScript(resolved)) {
    const packageCli = inferGitNexusCliFromScript(resolved)
    if (fs.existsSync(packageCli)) {
      return { ...resolveNodeProgram(resolved, host), args: [packageCli, ...leadingArgs] }
    }
    throw new Error(`dsh-gitnexus: Windows command wrapper has no bundled GitNexus CLI: ${resolved}`)
  }
  return { program: resolved, args: leadingArgs, electronRunAsNode: false }
}

export function runWithRunner(runner, args, { cwd, timeoutMs = 7000, signal } = {}) {
  return new Promise(resolve => {
    const finalArgs = [...runner.args, ...args]
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let child

    try {
      child = spawn(runner.program, finalArgs, {
        cwd,
        env: runnerEnvironment(runner),
        windowsHide: true,
        signal,
      })
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: '', error, timedOut: false })
      return
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, Math.max(1, timeoutMs))

    function onAbort() {
      child.kill()
    }

    function finish(status) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ status, stdout, stderr, error: null, timedOut })
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.once('error', error => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (!settled) {
        settled = true
        resolve({ status: null, stdout, stderr, error, timedOut })
      }
    })
    child.once('close', status => finish(status))
  })
}
