import path from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { extractExitCode, extractSearchPattern, isGitMutationCommand, isPlainObject, isSafePattern } from './patterns.js'
import { extractAugmentContext } from './status.js'
import { prepareCliRunner, runWithRunner } from './runner.js'
import { resolveRepositoryState, staleMetadataMessage } from './repository.js'

export const name = 'gitnexus-context-injector'

export const Config = Schema.object({
  cliCommand: Schema.string().default('gitnexus'),
  enableAugment: Schema.boolean().default(true),
  enableStaleNotice: Schema.boolean().default(true),
  augmentTimeoutMs: Schema.number().default(7000),
  staleTimeoutMs: Schema.number().default(3000),
  contextMaxChars: Schema.number().default(12000),
  cacheTtlMs: Schema.number().default(300000),
  staleNoticeTtlMs: Schema.number().default(600000),
  maxConcurrent: Schema.number().default(2),
  debug: Schema.boolean().default(false),
})

const PLUGIN_SOURCE = { kind: 'plugin', plugin: name }

function now() {
  return Date.now()
}

function executionCwd(execution) {
  const sessionCwd = execution?.agent?.session?.header?.cwd
  const fallback = typeof sessionCwd === 'string' ? sessionCwd : process.cwd()
  const args = isPlainObject(execution?.arguments) ? execution.arguments : {}

  if ((execution?.name === 'bash' || execution?.name === 'pwsh') && typeof args.workdir === 'string' && args.workdir) {
    return path.isAbsolute(args.workdir) ? path.resolve(args.workdir) : path.resolve(fallback, args.workdir)
  }
  return path.resolve(fallback)
}

function cacheValue(cache, key, ttlMs) {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (now() >= entry.expiresAt) {
    cache.delete(key)
    return undefined
  }
  return entry.value
}

function setCacheValue(cache, key, value, ttlMs) {
  if (cache.size > 500) cache.clear()
  cache.set(key, { value, expiresAt: now() + Math.max(0, ttlMs) })
}

export function apply(ctx, config) {
  const runner = prepareCliRunner(config.cliCommand)
  const augmentCache = new Map()
  const augmentInFlight = new Map()
  const staleNoticeSeen = new Map()
  let active = 0

  const debug = (...args) => {
    if (config.debug) ctx.logger.info(`dsh-gitnexus:`, ...args)
  }

  async function withSlot(work) {
    if (active >= Math.max(1, config.maxConcurrent)) return undefined
    active += 1
    try {
      return await work()
    } finally {
      active -= 1
    }
  }

  async function augment(execution) {
    if (!config.enableAugment) return ''
    const pattern = extractSearchPattern(execution)
    if (!isSafePattern(pattern)) return ''

    const cwd = executionCwd(execution)
    const key = JSON.stringify([cwd, pattern])
    const cached = cacheValue(augmentCache, key, config.cacheTtlMs)
    if (cached !== undefined) return cached
    if (augmentInFlight.has(key)) return await augmentInFlight.get(key)

    const work = withSlot(async () => {
      const result = await runWithRunner(runner, ['augment', '--', pattern], {
        cwd,
        timeoutMs: config.augmentTimeoutMs,
        signal: execution.signal,
      })
      if (result.error) {
        debug(`augment launch failed for ${pattern}:`, String(result.error))
        return ''
      }
      if (result.timedOut) {
        debug(`augment timed out for ${pattern}`)
        return ''
      }
      if (result.status !== 0) {
        debug(`augment exited with ${result.status} for ${pattern}`)
        return ''
      }
      return extractAugmentContext(result.stderr, config.contextMaxChars)
    }).finally(() => augmentInFlight.delete(key))

    augmentInFlight.set(key, work)
    const value = await work.catch(error => {
      debug(`augment failed for ${pattern}:`, String(error))
      return ''
    })
    setCacheValue(augmentCache, key, value, config.cacheTtlMs)
    return value
  }

  async function staleNotice(execution) {
    if (!config.enableStaleNotice) return ''
    const args = isPlainObject(execution.arguments) ? execution.arguments : {}
    if (!isGitMutationCommand(args.command)) return ''
    if (extractExitCode(execution.result) !== 0) return ''

    const cwd = executionCwd(execution)

    // Keep this path cheap: read git and GitNexus registry metadata directly.
    // `gitnexus status --json` can spend several seconds opening the graph DB
    // and scanning content drift, which is too slow for a post-tool listener.
    return await withSlot(async () => {
      const state = await resolveRepositoryState(cwd, config.staleTimeoutMs)
      const message = staleMetadataMessage(state)
      if (!message) return ''

      // Dedupe on the state the notice describes, not on elapsed time. A time
      // window suppresses the second of two quick commits, leaving the agent
      // holding a HEAD that has already been superseded.
      const signature = `${state.indexedCommit}|${state.currentCommit}`
      const seen = staleNoticeSeen.get(cwd)
      if (seen && seen.signature === signature && now() - seen.at < Math.max(0, config.staleNoticeTtlMs)) return ''

      staleNoticeSeen.set(cwd, { signature, at: now() })
      return message
    }).catch(error => {
      debug('stale check failed:', String(error))
      return ''
    })
  }

  function context(text) {
    if (!text) return undefined
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: PLUGIN_SOURCE,
    })
  }

  ctx.on('tools/post-execute', async (execution, result, next) => {
    // Start our bounded side channel while downstream listeners run. The tool itself has already dispatched.
    const augmentPromise = augment({ ...execution, result })
    const stalePromise = staleNotice({ ...execution, result })
    const downstream = await next()
    const values = await Promise.all([augmentPromise, stalePromise])
    const contexts = values.map(context).filter(Boolean)

    if (contexts.length === 0) return downstream
    return {
      ...downstream,
      additionalContexts: [...contexts, ...(downstream.additionalContexts ?? [])],
    }
  })
}
