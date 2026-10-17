import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('..', import.meta.url)
const patch = fs.readFileSync(fileURLToPath(new URL('cordis.patch.yml', root)), 'utf8')

test('bundle registers only the native adapter row', () => {
  assert.match(patch, /- id: gitnexus-context-injector\n\s+name: dsh-gitnexus/)
  assert.match(patch, /cliCommand: gitnexus/)
})

test('bundle exposes the TUI hook-status defaults', () => {
  assert.match(patch, /enableTuiStatus: true/)
  assert.match(patch, /tuiStatusLingerMs: 4000/)
})

test('bundle no longer auto-registers the GitNexus MCP row', () => {
  // The MCP registration flaked in DSH Desktop ("connected but no tools
  // registered"). The adapter now detects the missing MCP surface and points
  // the agent at the local CLI instead (see lib/index.js).
  assert.doesNotMatch(patch, /mcp-gitnexus/)
  assert.doesNotMatch(patch, /dsh-mcp-client/)
})
