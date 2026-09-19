import assert from 'node:assert/strict'
import test from 'node:test'
import { extractExitCode, extractSearchPattern, isGitMutationCommand, isSafePattern } from '../lib/patterns.js'

test('extracts native grep patterns', () => {
  assert.equal(extractSearchPattern({ name: 'grep', arguments: { pattern: 'createUser' } }), 'createUser')
})

test('extracts useful glob stems', () => {
  assert.equal(extractSearchPattern({ name: 'glob', arguments: { pattern: 'src/**\/UserService.ts' } }), 'UserService')
})

test('extracts shell rg patterns and skips value flags', () => {
  assert.equal(extractSearchPattern({ name: 'bash', arguments: { command: 'rg --glob "*.ts" paymentService' } }), 'paymentService')
})

test('rejects short and unsafe patterns', () => {
  assert.equal(extractSearchPattern({ name: 'grep', arguments: { pattern: 'ab' } }), null)
  assert.equal(isSafePattern('valid'), true)
  assert.equal(isSafePattern('bad\npattern'), false)
})

test('detects successful git mutations', () => {
  assert.equal(isGitMutationCommand('git commit -m test'), true)
  assert.equal(isGitMutationCommand('git status'), false)
  assert.equal(extractExitCode({ isError: false, value: { kind: 'foreground', exitCode: 0 } }), 0)
  assert.equal(extractExitCode({ isError: false, content: [{ type: 'text', text: 'done\n[exit code: 1]' }] }), 1)
})
