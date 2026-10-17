import assert from 'node:assert/strict'
import test from 'node:test'
import { extractExitCode, extractSearchPattern, isGitMutationCommand, isSafePattern } from '../lib/patterns.js'

test('extracts native grep patterns', () => {
  assert.equal(extractSearchPattern({ name: 'grep', arguments: { pattern: 'createUser' } }), 'createUser')
})

test('extracts useful glob stems', () => {
  assert.equal(extractSearchPattern({ name: 'glob', arguments: { pattern: 'src/**\/UserService.ts' } }), 'UserService')
})

test('derives a stem from globs that only name an extension', () => {
  assert.equal(extractSearchPattern({ name: 'glob', arguments: { pattern: '**/*.test.js' } }), 'test')
  assert.equal(extractSearchPattern({ name: 'glob', arguments: { pattern: 'packages/**/*.spec.tsx' } }), 'spec')
})

test('keys a literal glob path on its file stem, not a directory', () => {
  assert.equal(extractSearchPattern({ name: 'glob', arguments: { pattern: 'packages/foo/Bar.ts' } }), 'Bar')
  assert.equal(extractSearchPattern({ name: 'glob', arguments: { pattern: 'src/utils/helper.ts' } }), 'helper')
  assert.equal(extractSearchPattern({ name: 'glob', arguments: { pattern: 'apps/web/index.tsx' } }), 'index')
})

test('leaves a bare extension glob unresolved', () => {
  assert.equal(extractSearchPattern({ name: 'glob', arguments: { pattern: 'src/**/*.ts' } }), null)
  assert.equal(extractSearchPattern({ name: 'glob', arguments: { pattern: '**/*.json' } }), null)
  assert.equal(extractSearchPattern({ name: 'glob', arguments: { pattern: '**/*' } }), null)
  assert.equal(extractSearchPattern({ name: 'glob', arguments: { pattern: 'src/*' } }), null)
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
