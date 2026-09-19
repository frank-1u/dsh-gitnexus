import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('..', import.meta.url)
const patch = fs.readFileSync(fileURLToPath(new URL('cordis.patch.yml', root)), 'utf8')

test('bundle registers the native adapter and GitNexus MCP together', () => {
  assert.match(patch, /- id: gitnexus-context-injector\n\s+name: dsh-gitnexus/)
  assert.match(patch, /- id: mcp-gitnexus\n\s+name: '@deepseek-ai\/dsh-mcp-client'/)
  assert.match(patch, /serverName: gitnexus/)
  assert.match(patch, /command: gitnexus/)
  assert.match(patch, /args: \[mcp\]/)
})
