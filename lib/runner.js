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

function nodeEnvironment() {
  return { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
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

export function prepareCliRunner(command) {
  const tokens = splitCommandLine(command)
  if (tokens === null) throw new Error(`dsh-gitnexus: invalid cliCommand: ${command}`)

  const [configuredProgram, ...leadingArgs] = tokens
  const resolved = resolveOnPath(configuredProgram)
  if (!resolved) throw new Error(`dsh-gitnexus: cannot resolve cliCommand executable: ${configuredProgram}`)

  if (isJavaScriptFile(resolved)) {
    return { program: process.execPath, args: [resolved, ...leadingArgs] }
  }
  if (isWindowsScript(resolved)) {
    const packageCli = inferGitNexusCliFromScript(resolved)
    if (fs.existsSync(packageCli)) {
      return { program: process.execPath, args: [packageCli, ...leadingArgs] }
    }
    throw new Error(`dsh-gitnexus: Windows command wrapper has no bundled GitNexus CLI: ${resolved}`)
  }
  return { program: resolved, args: leadingArgs }
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
        env: nodeEnvironment(),
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
