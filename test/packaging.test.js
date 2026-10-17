import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const manifest = JSON.parse(read('package.json'))

// Every harness package this adapter imports at runtime is a peer: DSH compares
// module identity (Context.is, rootFibers, typert activation storage), so a
// second installed copy silently breaks the host. Regression guard for the
// 0.4.0 install that vendored @deepseek-ai/dsh-llm and @deepseek-ai/schemastery.
const HOST_PACKAGES = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm', '@deepseek-ai/schemastery']

test('no harness runtime package is a regular dependency', () => {
  const dependencies = Object.keys(manifest.dependencies ?? {})
  const vendored = dependencies.filter(name => name.startsWith('@deepseek-ai/') || HOST_PACKAGES.includes(name))
  assert.deepEqual(vendored, [], `vendored harness runtime: ${vendored.join(', ')}`)
})

test('every imported harness package is an optional peer', () => {
  for (const name of HOST_PACKAGES) {
    assert.ok(manifest.peerDependencies?.[name], `${name} must be a peerDependency`)
    assert.equal(manifest.peerDependenciesMeta?.[name]?.optional, true, `${name} must be optional`)
  }
})

test('the package is a plain dependency, not a profile bundle', () => {
  // dsh-tui 0.16.0 installs its root-capability guard before a third-party
  // bundle's backend assembly runs, so any third-party `dsh.profile.bundles`
  // entry aborts startup with "root.effect is unavailable from a plugin
  // activation". See docs/adr/0003-gitnexus-row-in-profile-patch.md. Restore
  // dsh.bundle only once the host defers that guard first.
  assert.equal(manifest.dsh?.bundle, undefined)
  const row = read('cordis.patch.yml')
  assert.match(row, /- id: gitnexus-context-injector/)
  // The row lives in the user's patch layer; it must go inert when the package
  // is uninstalled instead of failing the whole startup.
  assert.match(row, /disabled: !!js/)
})

test('the published tarball never contains node_modules', t => {
  let packed
  try {
    const raw = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    packed = JSON.parse(raw)[0].files.map(file => file.path)
  }
  catch (error) {
    t.skip(`npm pack --dry-run unavailable: ${error.message}`)
    return
  }
  assert.ok(packed.length > 0)
  const leaked = packed.filter(file => file.split('/').includes('node_modules'))
  assert.deepEqual(leaked, [])
  assert.ok(packed.includes('cordis.patch.yml'))
  assert.ok(packed.includes('package.json'))
})
