import assert from 'node:assert/strict'
import test from 'node:test'
import { extractAugmentContext, parseStatusOutput, staleStatusMessage } from '../lib/status.js'
import { staleMetadataMessage } from '../lib/repository.js'

test('parses the last status JSON document', () => {
  const status = parseStatusOutput('banner\n{"schemaVersion":1,"status":"stale","branch":"main","index":{"commit":"1111111"},"current":{"commit":"2222222"}}\n')
  assert.equal(status.status, 'stale')
  assert.equal(staleStatusMessage(status).includes('main'), true)
  assert.equal(staleStatusMessage(status).includes('1111111'), true)
})

test('ignores non-stale and error statuses', () => {
  assert.equal(staleStatusMessage({ schemaVersion: 1, status: 'up-to-date' }), null)
  assert.equal(staleStatusMessage({ schemaVersion: 1, error: 'not-indexed' }), null)
})

test('extracts only GitNexus context and truncates it', () => {
  const stderr = 'noise before marker\n[GitNexus] useful context'
  assert.equal(extractAugmentContext(stderr), '[GitNexus] useful context')
  assert.equal(extractAugmentContext('no marker'), '')
  assert.equal(extractAugmentContext(`[GitNexus] ${'x'.repeat(20)}`, 10).includes('truncated'), true)
})

test('builds stale messages from lightweight registry metadata', () => {
  assert.equal(staleMetadataMessage({ branch: 'main', currentCommit: '2222222', indexedCommit: '1111111' }).includes('main'), true)
  assert.equal(staleMetadataMessage({ currentCommit: '2222222', indexedCommit: '2222222' }), null)
})
