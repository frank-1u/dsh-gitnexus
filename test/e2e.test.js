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
function harness(config = {}, next = async () => ({ kind: 'accept' }), tools) {
  const listeners = new Map()
  // Resolve through the published schema so the adapter sees the same defaults
  // the DSH loader applies (enableAugment, enableStaleNotice, TTLs, ...).
  apply(
    {
      on: (event, listener) => listeners.set(event, listener),
      logger: { info() {}, warn() {} },
      ...(tools ? { tools } : {}),
    },
    Config({ cliCommand: fixture('gitnexus-stub.mjs'), augmentTimeoutMs: 20000, staleTimeoutMs: 10000, ...config }),
  )
  const listener = listeners.get('tools/post-execute')
  assert.equal(typeof listener, 'function', 'adapter must register a tools/post-execute listener')
  return (execution, result = OK) => listener(execution, result, next)
}

const execution = (cwd, name, args) => ({
  name,
  arguments: args,
  signal: new AbortController().signal,
  agent: { session: { header: { cwd } } },
})

const hasContext = decision => Array.isArray(decision?.additionalContexts) && decision.additionalContexts.length > 0
const contextText = decision => JSON.stringify(decision?.additionalContexts ?? [])

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

test('adapter: keeps downstream additional contexts behind its own', async () => {
  const downstream = { content: [{ type: 'text', text: 'downstream' }], source: { kind: 'plugin', plugin: 'other' } }
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

const staleTest = (title, body) =>
  test(title, async t => {
    if (!gitPathFormat) return t.skip('git without --path-format=absolute')
    return body()
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
