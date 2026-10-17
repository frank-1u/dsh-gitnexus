import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, Config } from '../lib/index.js'
import { prepareCliRunner, resolveOnPath, splitCommandLine } from '../lib/runner.js'

const root = new URL('..', import.meta.url)
const repoRoot = fileURLToPath(root)

// A cliCommand may be an absolute Node script; quote it so a checkout path
// containing spaces still splits into a single program token.
const fixture = name => '"' + fileURLToPath(new URL('fixtures/' + name, import.meta.url)) + '"'

// The staleness fixtures own their `.gitnexus` directory; drop ambient storage
// overrides so the fixture path is what actually gets read.
delete process.env.GITNEXUS_STORAGE_PATH
delete process.env.GITNEXUS_STORAGE_ROOT

const OK = { isError: false, value: { kind: 'foreground', exitCode: 0 }, content: [] }
const FAILED = { isError: false, value: { kind: 'foreground', exitCode: 1 }, content: [] }

function runs(command, args, options = {}) {
  try {
    execFileSync(command, args, { stdio: 'ignore', ...options })
    return true
  } catch {
    return false
  }
}

const gitPathFormat = runs('git', ['rev-parse', '--path-format=absolute', '--show-toplevel'], { cwd: repoRoot })

/** Boot the adapter against a fake Cordis ctx and return its post-execute dispatcher. */
function harness(config = {}, next = async () => ({ kind: 'accept' }), tools, tuiStatus) {
  const listeners = new Map()
  // Resolve through the published schema so the adapter sees the same defaults
  // the DSH loader applies (enableAugment, enableStaleNotice, TTLs, ...).
  apply(
    {
      on: (event, listener) => listeners.set(event, listener),
      logger: { info() {}, warn() {} },
      ...(tools ? { tools } : {}),
      ...(tuiStatus ? { get: name => (name === 'tuiStatus' ? tuiStatus : undefined) } : {}),
    },
    Config({ cliCommand: fixture('gitnexus-stub.mjs'), augmentTimeoutMs: 20000, staleTimeoutMs: 10000, ...config }),
  )
  const listener = listeners.get('tools/post-execute')
  assert.equal(typeof listener, 'function', 'adapter must register a tools/post-execute listener')
  return (execution, result = OK) => listener(execution, result, next)
}

/** Record every keyed TUI status write without implementing the host's store. */
function statusSink() {
  const writes = []
  return {
    writes,
    set(key, text, identity) {
      writes.push({ key, text, identity })
      return () => {}
    },
  }
}


const execution = (cwd, name, args) => ({
  name,
  arguments: args,
  signal: new AbortController().signal,
  agent: { session: { header: { cwd } } },
})

const hasContext = decision => Array.isArray(decision?.additionalContexts) && decision.additionalContexts.length > 0
const contextText = decision => JSON.stringify(decision?.additionalContexts ?? [])

// The stub appends `cwd=<process.cwd()>` to its `[GitNexus]` line, so the
// assertions observe the directory GitNexus really ran in. Compare real paths:
// a macOS temp directory is reached through the /private symlink.
const reportedCwd = decision => {
  for (const message of decision?.additionalContexts ?? []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      const match = /\bcwd=([^\n]+)\s*$/.exec(block.text)
      if (match) return match[1]
    }
  }
  return undefined
}

const realDirectory = value => {
  try {
    return fs.realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

function assertRanIn(decision, directory) {
  const actual = reportedCwd(decision)
  assert.ok(actual, 'the augment fixture must report its working directory')
  assert.equal(realDirectory(actual), realDirectory(directory), `GitNexus ran in ${actual}, expected ${directory}`)
}

// Every shell-resolution exercise runs against this throwaway tree so the
// expected absolute directories are independent of the checkout.
// Its path acts as the session CWD.
const augmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gitnexus-augment-root-'))
after(() => fs.rmSync(augmentRoot, { recursive: true, force: true }))
const inRoot = (...segments) => path.join(augmentRoot, ...segments)
fs.mkdirSync(inRoot('repo', 'nested'), { recursive: true })
fs.mkdirSync(inRoot('absolute'), { recursive: true })
fs.mkdirSync(inRoot('with space'), { recursive: true })
// Single-quoted targets are literal, so `$` and a backslash name real directories.
fs.mkdirSync(inRoot('literal$dir'), { recursive: true })
fs.mkdirSync(inRoot('with\\backslash'), { recursive: true })
fs.mkdirSync(inRoot('home', 'repo'), { recursive: true })
// A regular file inside the tree: a search `path` that names it resolves to
// its parent directory instead of the session cwd.
fs.writeFileSync(inRoot('repo', 'nested', 'target.txt'), 'needle\n')

// `~` expands against the home directory of the process that runs the adapter.
// Point it at the sandbox for the duration of one exercise and restore it.
async function withHome(home, body) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    return await body()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const shell = (command, workdir) => ({ ...(workdir === undefined ? {} : { workdir }), command })

test('runner: resolves an absolute Node CLI script to the current node binary', () => {
  const resolved = prepareCliRunner(fixture('gitnexus-stub.mjs'))
  assert.equal(resolved.program, process.execPath)
  assert.deepEqual(resolved.args, [fileURLToPath(new URL('fixtures/gitnexus-stub.mjs', import.meta.url))])
})

test('runner: rejects an unresolvable command', () => {
  assert.equal(resolveOnPath('dsh-gitnexus-definitely-missing-binary'), null)
  assert.throws(() => prepareCliRunner('dsh-gitnexus-definitely-missing-binary'))
})

test('runner: keeps a quoted Windows path in one token', () => {
  assert.deepEqual(splitCommandLine('node --flag "C:\\Program Files\\app.js"'), ['node', '--flag', 'C:\\Program Files\\app.js'])
})

test('runner: prefers a real Node over the Electron binary', () => {
  const electronHost = { electron: true, execPath: 'D:\Program Files\DSH Desktop\DSH Desktop.exe' }
  const resolved = prepareCliRunner(fixture('gitnexus-stub.mjs'), electronHost)
  assert.equal(resolved.electronRunAsNode, false)
  assert.notEqual(resolved.program, electronHost.execPath)
  assert.match(path.basename(resolved.program), /^node(\.exe)?$/i)
})

test('runner: keeps process.execPath when the host is not Electron', () => {
  const resolved = prepareCliRunner(fixture('gitnexus-stub.mjs'), { electron: false, execPath: process.execPath })
  assert.equal(resolved.program, process.execPath)
  assert.equal(resolved.electronRunAsNode, false)
})

test('adapter: attaches GitNexus context after a native grep', async () => {
  const decision = await harness()(execution(repoRoot, 'grep', { pattern: 'extractSearchPattern' }))
  assert.equal(decision.kind, 'accept')
  assert.ok(hasContext(decision))
  assert.match(contextText(decision), /\[GitNexus\]/)
})

test('adapter: stamps injected contexts with a producer-owned source kind', async () => {
  // The retired `{ kind: 'plugin', plugin }` wrapper fails format v4 admission,
  // which failed the whole round the moment an injected context was persisted.
  const decision = await harness()(execution(repoRoot, 'grep', { pattern: 'extractSearchPattern' }))
  assert.ok(hasContext(decision))
  for (const message of decision.additionalContexts) {
    assert.equal(typeof message.source?.kind, 'string')
    assert.ok(message.source.kind.length > 0)
    assert.notEqual(message.source.kind, 'plugin')
    assert.equal(message.source.plugin, undefined)
  }
})

test('adapter: keeps downstream additional contexts behind its own', async () => {
  const downstream = { content: [{ type: 'text', text: 'downstream' }], source: { kind: 'plugin:other' } }
  const fire = harness({}, async () => ({ kind: 'accept', additionalContexts: [downstream] }))
  const decision = await fire(execution(repoRoot, 'grep', { pattern: 'extractSearchPattern' }))
  assert.equal(decision.additionalContexts.length, 2)
  assert.deepEqual(decision.additionalContexts.at(-1), downstream)
})

test('adapter: ignores short patterns and non-search tools', async () => {
  const fire = harness()
  assert.equal(hasContext(await fire(execution(repoRoot, 'grep', { pattern: 'ab' }))), false)
  assert.equal(hasContext(await fire(execution(repoRoot, 'read', { file_path: 'README.md' }))), false)
})

test('adapter: honours enableAugment=false', async () => {
  const fire = harness({ enableAugment: false })
  assert.equal(hasContext(await fire(execution(repoRoot, 'grep', { pattern: 'extractSearchPattern' }))), false)
})

test('adapter: points at the local CLI when no mcp__gitnexus__ tools are registered', async () => {
  const fire = harness({}, undefined, { schemas: async () => [{ name: 'grep' }, { name: 'mcp__other__query' }] })
  const decision = await fire(execution(repoRoot, 'grep', { pattern: 'extractSearchPattern' }))
  assert.ok(hasContext(decision), 'augment context still injects')
  assert.match(contextText(decision), /gitnexus query/)
  assert.doesNotMatch(contextText(decision), /mcp__gitnexus__/)
})

test('adapter: stays silent about the CLI when GitNexus MCP tools are registered', async () => {
  const fire = harness({}, undefined, { schemas: async () => [{ name: 'grep' }, { name: 'mcp__gitnexus__query' }] })
  const decision = await fire(execution(repoRoot, 'grep', { pattern: 'extractSearchPattern' }))
  assert.ok(hasContext(decision), 'augment context still injects')
  assert.doesNotMatch(contextText(decision), /gitnexus query/)
})

test('adapter: an unreadable tool registry never triggers the CLI hint', async () => {
  const fire = harness({}, undefined, { schemas: async () => { throw new Error('registry down') } })
  const decision = await fire(execution(repoRoot, 'grep', { pattern: 'extractSearchPattern' }))
  assert.ok(hasContext(decision), 'augment context still injects')
  assert.doesNotMatch(contextText(decision), /gitnexus query/)
})

test('adapter: a failing GitNexus CLI never turns the tool result into an error', async () => {
  const fire = harness({ cliCommand: fixture('gitnexus-failing.mjs') })
  assert.deepEqual(await fire(execution(repoRoot, 'grep', { pattern: 'extractSearchPattern' })), { kind: 'accept' })
})

test('status: publishes the injected context through tuiStatus', async () => {
  const tui = statusSink()
  const fire = harness({ tuiStatusLingerMs: 5 }, undefined, undefined, tui)
  const decision = await fire(execution(repoRoot, 'grep', { pattern: 'extractSearchPattern' }))
  assert.ok(hasContext(decision))
  assert.ok(tui.writes.length > 0)
  assert.ok(tui.writes.every(write => write.key === 'gitnexus'))
  assert.ok(tui.writes.every(write => write.identity !== undefined))
  assert.match(tui.writes.at(-1).text, /^GitNexus ✓ context \+/)
})

test('status: reports a failed augment without changing the tool result', async () => {
  const tui = statusSink()
  const fire = harness({ cliCommand: fixture('gitnexus-failing.mjs'), tuiStatusLingerMs: 5 }, undefined, undefined, tui)
  assert.deepEqual(await fire(execution(repoRoot, 'grep', { pattern: 'extractSearchPattern' })), { kind: 'accept' })
  assert.equal(tui.writes.at(-1).text, 'GitNexus ✗ augment failed (exit 3)')
})

test('status: enableTuiStatus=false leaves the line untouched', async () => {
  const tui = statusSink()
  const fire = harness({ enableTuiStatus: false }, undefined, undefined, tui)
  const decision = await fire(execution(repoRoot, 'grep', { pattern: 'extractSearchPattern' }))
  assert.ok(hasContext(decision))
  assert.equal(tui.writes.length, 0)
})

test('status: a tuiStatus without set is ignored', async () => {
  const fire = harness({}, undefined, undefined, {})
  const decision = await fire(execution(repoRoot, 'grep', { pattern: 'extractSearchPattern' }))
  assert.ok(hasContext(decision))
})

test('augment root: a leading literal cd selects the GitNexus directory', async () => {
  const decision = await harness()(execution(augmentRoot, 'bash', { command: 'cd repo && grep needle' }))
  assert.ok(hasContext(decision))
  assertRanIn(decision, inRoot('repo'))
})

test('augment root: a relative workdir chooses the GitNexus directory', async () => {
  const decision = await harness()(execution(augmentRoot, 'bash', shell('grep needle', 'repo')))
  assert.ok(hasContext(decision))
  assertRanIn(decision, inRoot('repo'))
})

test('augment root: an absolute workdir chooses the GitNexus directory', async () => {
  const decision = await harness()(execution(augmentRoot, 'bash', shell('grep needle', inRoot('absolute'))))
  assert.ok(hasContext(decision))
  assertRanIn(decision, inRoot('absolute'))
})

test('augment root: a leading cd is applied on top of a declared workdir', async () => {
  const decision = await harness()(execution(augmentRoot, 'bash', shell('cd nested && grep needle', 'repo')))
  assert.ok(hasContext(decision))
  assertRanIn(decision, inRoot('repo', 'nested'))
})

test('augment root: cd separated by ; or a newline is applied', async () => {
  const fire = harness()
  assertRanIn(await fire(execution(augmentRoot, 'bash', { command: 'cd repo; grep needle' })), inRoot('repo'))
  assertRanIn(await fire(execution(augmentRoot, 'bash', { command: 'cd repo\ngrep needle' })), inRoot('repo'))
})

test('augment root: consecutive leading cd segments are applied in order', async () => {
  const decision = await harness()(execution(augmentRoot, 'bash', { command: 'cd repo && cd nested && grep needle' }))
  assert.ok(hasContext(decision))
  assertRanIn(decision, inRoot('repo', 'nested'))
})

test('augment root: a quoted target may contain spaces', async () => {
  const decision = await harness()(execution(augmentRoot, 'bash', { command: 'cd "with space" && grep needle' }))
  assert.ok(hasContext(decision))
  assertRanIn(decision, inRoot('with space'))
})

test('augment root: ~ expands to the home directory', async () => {
  const home = inRoot('home')
  const fire = harness()
  const decision = await withHome(home, () => fire(execution(augmentRoot, 'bash', { command: 'cd ~/repo && grep needle' })))
  assert.ok(hasContext(decision))
  assertRanIn(decision, inRoot('home', 'repo'))
  // The same target with a doubled slash must still land under home, not at /repo.
  assertRanIn(await withHome(home, () => fire(execution(augmentRoot, 'bash', { command: 'cd ~//repo && grep needle' }))), inRoot('home', 'repo'))
})

test('augment root: variable expansion and history cd fall back to the session cwd', async () => {
  const fire = harness()
  assertRanIn(await fire(execution(augmentRoot, 'bash', { command: 'cd $TARGET && grep needle' })), augmentRoot)
  assertRanIn(await fire(execution(augmentRoot, 'bash', { command: 'cd - && grep needle' })), augmentRoot)
  assertRanIn(await fire(execution(augmentRoot, 'bash', { command: 'cd `pwd` && grep needle' })), augmentRoot)
})

test('augment root: redirection after a target falls back to the session cwd', async () => {
  const fire = harness()
  assertRanIn(await fire(execution(augmentRoot, 'bash', { command: 'cd repo > /dev/null && grep needle' })), augmentRoot)
  assertRanIn(await fire(execution(augmentRoot, 'bash', { command: 'cd repo>log && grep needle' })), augmentRoot)
})

test('augment root: an || branch falls back to the session cwd', async () => {
  const decision = await harness()(execution(augmentRoot, 'bash', { command: 'cd repo || cd absolute && grep needle' }))
  assert.ok(hasContext(decision))
  assertRanIn(decision, augmentRoot)
})

test('augment root: a partial chain is discarded whole', async () => {
  const fire = harness()
  assertRanIn(await fire(execution(augmentRoot, 'bash', { command: 'cd repo && cd $TARGET && grep needle' })), augmentRoot)
  assertRanIn(await fire(execution(augmentRoot, 'bash', { command: 'cd repo && cd - && grep needle' })), augmentRoot)
})

test('augment root: an unresolvable cd falls back to the declared workdir', async () => {
  const decision = await harness()(execution(augmentRoot, 'bash', shell('cd $TARGET && grep needle', 'repo')))
  assert.ok(hasContext(decision))
  assertRanIn(decision, inRoot('repo'))
})

test('augment root: a cd after another command is ignored', async () => {
  const decision = await harness()(execution(augmentRoot, 'bash', { command: 'echo start && cd repo && grep needle' }))
  assert.ok(hasContext(decision))
  assertRanIn(decision, augmentRoot)
})

test('augment root: pushd and Set-Location end the chain', async () => {
  const fire = harness()
  assertRanIn(await fire(execution(augmentRoot, 'bash', { command: 'pushd repo && grep needle' })), augmentRoot)
  assertRanIn(await fire(execution(augmentRoot, 'pwsh', { command: 'Set-Location repo; grep needle' })), augmentRoot)
})

test('augment root: ~user, globs and unquoted backslashes fall back to the session cwd', async () => {
  const fire = harness()
  assertRanIn(await fire(execution(augmentRoot, 'bash', { command: 'cd ~nobody/repo && grep needle' })), augmentRoot)
  assertRanIn(await fire(execution(augmentRoot, 'bash', { command: 'cd repo* && grep needle' })), augmentRoot)
  assertRanIn(await fire(execution(augmentRoot, 'bash', { command: 'cd repo\\ dir && grep needle' })), augmentRoot)
  assertRanIn(await fire(execution(augmentRoot, 'bash', { command: 'cd repo & grep needle' })), augmentRoot)
})

test('augment root: a single-quoted target is fully literal', async () => {
  const fire = harness()
  assertRanIn(await fire(execution(augmentRoot, 'bash', { command: "cd 'literal$dir' && grep needle" })), inRoot('literal$dir'))
  assertRanIn(await fire(execution(augmentRoot, 'bash', { command: "cd 'with\\backslash' && grep needle" })), inRoot('with\\backslash'))
})

test('augment root: a double-quoted target with expansion or escapes falls back to the session cwd', async () => {
  const fire = harness()
  assertRanIn(await fire(execution(augmentRoot, 'bash', { command: 'cd "$TARGET" && grep needle' })), augmentRoot)
  assertRanIn(await fire(execution(augmentRoot, 'bash', { command: 'cd "a\\ b" && grep needle' })), augmentRoot)
})

test('augment root: cd with no target or an option falls back to the session cwd', async () => {
  const fire = harness()
  assertRanIn(await fire(execution(augmentRoot, 'bash', { command: 'cd && grep needle' })), augmentRoot)
  assertRanIn(await fire(execution(augmentRoot, 'bash', { command: 'cd -- repo && grep needle' })), augmentRoot)
})

test('augment root: a grep path directory chooses the GitNexus directory', async () => {
  const fire = harness()
  // Relative paths resolve against the session cwd; an absolute path is used
  // as declared. Both name a directory, which is the root itself.
  assertRanIn(await fire(execution(augmentRoot, 'grep', { pattern: 'needle', path: 'repo' })), inRoot('repo'))
  assertRanIn(await fire(execution(augmentRoot, 'grep', { pattern: 'needle', path: inRoot('absolute') })), inRoot('absolute'))
})

test('augment root: a grep path file resolves to its parent directory', async () => {
  const decision = await harness()(execution(augmentRoot, 'grep', { pattern: 'needle', path: path.join('repo', 'nested', 'target.txt') }))
  assert.ok(hasContext(decision))
  assertRanIn(decision, inRoot('repo', 'nested'))
})

test('augment root: a glob path directory chooses the GitNexus directory', async () => {
  // `src/*repo.mjs` leaves a stem of 3+ characters, so the search itself is
  // interesting; the directory under test comes from `path`.
  const decision = await harness()(execution(augmentRoot, 'glob', { pattern: 'src/*repo.mjs', path: inRoot('absolute') }))
  assert.ok(hasContext(decision))
  assertRanIn(decision, inRoot('absolute'))
})

test('augment root: a missing search path falls back to the session cwd', async () => {
  const decision = await harness()(execution(augmentRoot, 'grep', { pattern: 'needle', path: 'missing-repo' }))
  assert.ok(hasContext(decision))
  assertRanIn(decision, augmentRoot)
})

test('augment root: a search path below a regular file falls back to the session cwd', async () => {
  const decision = await harness()(execution(augmentRoot, 'grep', { pattern: 'needle', path: path.join('repo', 'nested', 'target.txt', 'child') }))
  assert.ok(hasContext(decision))
  assertRanIn(decision, augmentRoot)
})

test('augment root: an unreadable search path falls back to the session cwd', async t => {
  const unreadable = inRoot('unreadable')
  fs.mkdirSync(unreadable, { recursive: true })
  fs.writeFileSync(path.join(unreadable, 'target.txt'), 'needle\n')
  try {
    fs.chmodSync(unreadable, 0o000)
    let denied = false
    // Both facts matter: the directory itself is unreadable, and traversal into
    // it is denied. A filesystem that enforces neither cannot exercise this case.
    try {
      fs.accessSync(unreadable, fs.constants.R_OK | fs.constants.X_OK)
    } catch {
      denied = true
    }
    try {
      fs.statSync(path.join(unreadable, 'target.txt'))
    } catch {
      denied = true
    }
    if (!denied) return t.skip('filesystem permissions do not deny access')
    const fire = harness()
    assertRanIn(await fire(execution(augmentRoot, 'grep', { pattern: 'needle', path: 'unreadable' })), augmentRoot)
    assertRanIn(await fire(execution(augmentRoot, 'grep', { pattern: 'needle', path: path.join('unreadable', 'target.txt') })), augmentRoot)
  } finally {
    fs.chmodSync(unreadable, 0o755)
  }
})

test('augment root: an empty search path uses the session cwd', async () => {
  const fire = harness()
  assertRanIn(await fire(execution(augmentRoot, 'grep', { pattern: 'needle', path: '' })), augmentRoot)
  assertRanIn(await fire(execution(augmentRoot, 'glob', { pattern: 'src/*repo.mjs' })), augmentRoot)
})

const repo = { dir: null, head: null }
if (gitPathFormat) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gitnexus-e2e-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init')
  git('config', 'user.email', 'e2e@example.com')
  git('config', 'user.name', 'dsh-gitnexus e2e')
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'fixture\n')
  git('add', '.')
  git('commit', '-m', 'fixture')
  fs.mkdirSync(path.join(dir, '.gitnexus'), { recursive: true })
  repo.dir = dir
  repo.head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()
  after(() => fs.rmSync(dir, { recursive: true, force: true }))
}

const writeIndex = commit =>
  fs.writeFileSync(path.join(repo.dir, '.gitnexus', 'gitnexus.json'), JSON.stringify({ lastCommit: commit, indexedAt: '2026-01-01T00:00:00.000Z' }))

// A second repository the session only reaches through `cd`, used to prove the
// stale notice follows the Augment Root instead of the session cwd.
const cdRepo = { dir: null, head: null }
if (gitPathFormat) {
  const dir = inRoot('cd-repo')
  fs.mkdirSync(dir, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init')
  git('config', 'user.email', 'e2e@example.com')
  git('config', 'user.name', 'dsh-gitnexus e2e')
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'fixture\n')
  git('add', '.')
  git('commit', '-m', 'fixture')
  fs.mkdirSync(path.join(dir, '.gitnexus'), { recursive: true })
  cdRepo.dir = dir
  cdRepo.head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()
}

const staleTest = (title, body) =>
  test(title, async t => {
    if (!gitPathFormat) return t.skip('git without --path-format=absolute')
    return body()
  })

staleTest('stale: a leading cd points the notice at that repository index', async () => {
  const indexed = 'b'.repeat(40)
  fs.writeFileSync(path.join(cdRepo.dir, '.gitnexus', 'gitnexus.json'), JSON.stringify({ lastCommit: indexed, indexedAt: '2026-01-01T00:00:00.000Z' }))
  // The session cwd is not a repository at all: a notice can only come from the
  // repository the command cd'd into.
  const decision = await harness()(execution(augmentRoot, 'pwsh', { command: 'cd cd-repo && git commit -m "fixture"' }))
  assert.match(contextText(decision), /index is stale/)
  assert.match(contextText(decision), /bbbbbbb/)
  assert.match(contextText(decision), new RegExp(cdRepo.head.slice(0, 7)))
})

staleTest('stale: notices an index that no longer matches HEAD', async () => {
  writeIndex('0'.repeat(40))
  const decision = await harness()(execution(repo.dir, 'pwsh', { command: 'git commit -m "fixture"' }))
  assert.match(contextText(decision), /index is stale/)
  assert.match(contextText(decision), /gitnexus analyze --index-only/)
})

staleTest('stale: stays silent while the index matches HEAD', async () => {
  writeIndex(repo.head)
  assert.equal(hasContext(await harness()(execution(repo.dir, 'pwsh', { command: 'git commit -m "fixture"' }))), false)
})

staleTest('stale: stays silent when the git command failed', async () => {
  writeIndex('0'.repeat(40))
  assert.equal(hasContext(await harness()(execution(repo.dir, 'pwsh', { command: 'git commit -m "fixture"' }), FAILED)), false)
})

staleTest('stale: stays silent for non-mutating git commands', async () => {
  writeIndex('0'.repeat(40))
  assert.equal(hasContext(await harness()(execution(repo.dir, 'pwsh', { command: 'git status' }))), false)
})

staleTest('stale: honours enableStaleNotice=false', async () => {
  writeIndex('0'.repeat(40))
  const fire = harness({ enableStaleNotice: false })
  assert.equal(hasContext(await fire(execution(repo.dir, 'pwsh', { command: 'git commit -m "fixture"' }))), false)
})

staleTest('stale: reports a second commit that lands inside the notice TTL', async () => {
  writeIndex('0'.repeat(40))
  // The production default is a 10 minute TTL; two quick commits must both report.
  const fire = harness({ staleNoticeTtlMs: 600000 })
  const first = await fire(execution(repo.dir, 'pwsh', { command: 'git commit -m "fixture"' }))
  assert.match(contextText(first), /index is stale/)

  execFileSync('git', ['commit', '--allow-empty', '-m', 'move HEAD'], { cwd: repo.dir, stdio: 'ignore' })
  repo.head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.dir }).toString().trim()

  const second = await fire(execution(repo.dir, 'pwsh', { command: 'git commit -m "fixture"' }))
  assert.match(contextText(second), /index is stale/)
  // The second notice must name the new HEAD, not the superseded one.
  assert.match(contextText(second), new RegExp(repo.head.slice(0, 7)))
})

staleTest('stale: does not repeat an unchanged notice inside the TTL', async () => {
  writeIndex('0'.repeat(40))
  const fire = harness({ staleNoticeTtlMs: 600000 })
  assert.match(contextText(await fire(execution(repo.dir, 'pwsh', { command: 'git commit -m "fixture"' }))), /index is stale/)
  assert.equal(hasContext(await fire(execution(repo.dir, 'pwsh', { command: 'git commit -m "fixture"' }))), false)
})

staleTest('stale: publishes the stale index on the status line', async () => {
  writeIndex('0'.repeat(40))
  const tui = statusSink()
  const fire = harness({ tuiStatusLingerMs: 5 }, undefined, undefined, tui)
  await fire(execution(repo.dir, 'pwsh', { command: 'git commit -m "fixture"' }))
  assert.ok(tui.writes.some(write => /^GitNexus ⚠ index stale \(0{7} → /.test(write.text)))
})

test('real GitNexus: augment returns graph context for an indexed repository', async t => {
  let resolvable = true
  try {
    prepareCliRunner('gitnexus')
  } catch {
    resolvable = false
  }
  if (!resolvable) return t.skip('gitnexus CLI is not on PATH')
  if (!fs.existsSync(fileURLToPath(new URL('.gitnexus/gitnexus.json', root)))) return t.skip('repository has no GitNexus index')

  const fire = harness({ cliCommand: 'gitnexus', augmentTimeoutMs: 60000 })
  const decision = await fire(execution(repoRoot, 'grep', { pattern: 'extractSearchPattern' }))
  assert.ok(hasContext(decision))
  assert.match(contextText(decision), /\[GitNexus\]/)
})
