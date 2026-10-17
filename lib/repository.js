import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isPlainObject } from './patterns.js'

const GITNEXUS_DIRECTORY = '.gitnexus'
const BRANCHES_DIRECTORY = 'branches'
const STORAGE_SLOT_HASH_LENGTH = 12

function stripWindowsLongPath(value) {
  if (process.platform !== 'win32') return value
  if (/^\\\\\?\\UNC\\(?=[^\\])/i.test(value)) return `\\\\${value.slice(8)}`
  if (/^\\\\\?\\[A-Za-z]:\\/.test(value)) return value.slice(4)
  return value
}

function canonicalize(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) return null
  try {
    return stripWindowsLongPath(fs.realpathSync.native(path.resolve(value)))
  } catch {
    return stripWindowsLongPath(path.resolve(value))
  }
}

function samePath(left, right) {
  if (left == null || right == null) return false
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function git(cwd, args, timeoutMs) {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: Math.max(1, timeoutMs), windowsHide: true }, (error, stdout) => {
      resolve(error ? null : String(stdout ?? '').trim())
    })
  })
}

function readJsonFile(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isPlainObject(value) ? value : null
  } catch {
    return null
  }
}

function readIndexMetadata(storagePath) {
  return readJsonFile(path.join(storagePath, 'gitnexus.json')) ?? readJsonFile(path.join(storagePath, 'meta.json'))
}

function hasIndexSignal(storagePath) {
  try {
    return fs.existsSync(path.join(storagePath, 'gitnexus.json')) || fs.existsSync(path.join(storagePath, 'lbug'))
  } catch {
    return false
  }
}

function sanitizeSlotBasename(value) {
  const sanitized = value.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-').slice(0, 80)
  let end = sanitized.length
  while (end > 0) {
    const code = sanitized.charCodeAt(end - 1)
    if (code !== 0x20 && code !== 0x2e) break
    end -= 1
  }
  const candidate = sanitized.slice(0, end) || 'repository'
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(candidate) ? `repository-${candidate}` : candidate
}

function branchSlug(rawRef) {
  const sanitized = rawRef.replace(/^-+/, '').replace(/[^a-zA-Z0-9._-]/g, '_')
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i
  const safe = !sanitized || sanitized === '.' || sanitized === '..' || reserved.test(sanitized) ? 'unknown' : sanitized
  const hash = createHash('sha256').update(rawRef).digest('hex').slice(0, 8)
  return `${safe}-${hash}`
}

function storageSlotName(repoPath) {
  const canonical = canonicalize(repoPath)
  if (!canonical) return null
  const identity = process.platform === 'win32' ? canonical.toLowerCase() : canonical
  return `${sanitizeSlotBasename(path.basename(canonical))}-${createHash('sha256').update(identity).digest('hex').slice(0, STORAGE_SLOT_HASH_LENGTH)}`
}

function resolveStoragePath(entry, repoPath) {
  const envPath = process.env.GITNEXUS_STORAGE_PATH
  if (typeof envPath === 'string' && envPath && !envPath.includes('\0') && path.isAbsolute(envPath)) {
    return path.resolve(envPath)
  }

  const envRoot = process.env.GITNEXUS_STORAGE_ROOT
  if (typeof envRoot === 'string' && envRoot && !envRoot.includes('\0') && path.isAbsolute(envRoot)) {
    const slot = storageSlotName(repoPath)
    if (slot) return path.join(path.resolve(envRoot), slot)
  }
  if (isPlainObject(entry) && typeof entry.storagePath === 'string' && entry.storagePath && !entry.storagePath.includes('\0') && path.isAbsolute(entry.storagePath)) {
    return path.resolve(entry.storagePath)
  }
  return path.join(repoPath, GITNEXUS_DIRECTORY)
}

function registryEntries() {
  const home = process.env.GITNEXUS_HOME || path.join(os.homedir(), '.gitnexus')
  const value = readJsonFile(path.join(home, 'registry.json'))
  return Array.isArray(value) ? value.filter(isPlainObject) : []
}

/**
 * Resolve the lightweight GitNexus registry state used for a stale-index nudge.
 * Unlike `gitnexus status`, this never opens the graph database or scans content drift.
 */
export async function resolveRepositoryState(cwd, timeoutMs = 3000) {
  const rootOutput = await git(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel'], timeoutMs)
  if (!rootOutput || !path.isAbsolute(rootOutput)) return null
  const repoPath = canonicalize(rootOutput) ?? path.resolve(rootOutput)
  const [head, branch] = await Promise.all([
    git(repoPath, ['rev-parse', 'HEAD'], timeoutMs),
    git(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], timeoutMs),
  ])
  if (!head) return null

  const canonicalRepo = canonicalize(repoPath) ?? repoPath
  const entry = registryEntries().find(candidate => {
    const registeredPath = canonicalize(candidate.path)
    return registeredPath != null && samePath(registeredPath, canonicalRepo)
  })

  const storagePath = resolveStoragePath(entry, repoPath)
  const branchDirectory = branch ? path.join(storagePath, BRANCHES_DIRECTORY, branchSlug(branch)) : null
  const indexDirectory = branchDirectory && hasIndexSignal(branchDirectory) ? branchDirectory : storagePath
  const metadata = readIndexMetadata(indexDirectory)
  if (!metadata) return null

  return {
    repoPath,
    branch: branch || null,
    currentCommit: head,
    indexedCommit: typeof metadata.lastCommit === 'string' ? metadata.lastCommit : '',
    indexedAt: typeof metadata.indexedAt === 'string' ? metadata.indexedAt : '',
  }
}

export function staleMetadataMessage(state) {
  if (!state || !state.indexedCommit || state.currentCommit === state.indexedCommit) return null
  const indexed = state.indexedCommit.slice(0, 7)
  const current = state.currentCommit.slice(0, 7)
  const branch = state.branch ? ` on branch ${state.branch}` : ''
  return (
    `GitNexus index is stale${branch} (last indexed: ${indexed}; current HEAD: ${current}). ` +
    'Run `gitnexus analyze --index-only` to update the knowledge graph without rewriting agent docs.'
  )
}
