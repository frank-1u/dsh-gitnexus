import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveAugmentRoot } from './augment-root.js'
import { extractExitCode, extractSearchPattern, isGitMutationCommand, isPlainObject, isSafePattern } from './patterns.js'
import { cliFallbackGuidance, extractAugmentContext } from './status.js'
import { contextLabel, createHookStatus, failureLabel, freshnessLabel, runningLabel, staleLabel } from './tui-status.js'
import { prepareCliRunner, runWithRunner } from './runner.js'
import { resolveRepositoryState, staleMetadataMessage } from './repository.js'

export const name = 'gitnexus-context-injector'

// The tool registry is what tells the MCP surface is live: dsh-mcp-client
// registers every remote tool under `mcp__<serverName>__<tool>`. Optional
// consumption is not expressible in cordis `inject`, and DSH always provides
// `tools` in profiles this adapter targets, so declare it required.
export const inject = ['tools']

export const Config = Schema.object({
  cliCommand: Schema.string().default('gitnexus'),
  enableAugment: Schema.boolean().default(true),
  enableStaleNotice: Schema.boolean().default(true),
  enableCliFallbackHint: Schema.boolean().default(true),
  enableTuiStatus: Schema.boolean().default(true),
  tuiStatusLingerMs: Schema.number().default(4000),
  augmentTimeoutMs: Schema.number().default(7000),
  staleTimeoutMs: Schema.number().default(3000),
  cliHintTtlMs: Schema.number().default(1800000),
  contextMaxChars: Schema.number().default(12000),
  cacheTtlMs: Schema.number().default(300000),
  staleNoticeTtlMs: Schema.number().default(600000),
  maxConcurrent: Schema.number().default(2),
  debug: Schema.boolean().default(false),
})

// Session format v4 requires a producer-owned source kind: the retired V3
// wrapper `{ kind: 'plugin', plugin }` fails admission at adoption time, which
// failed the whole round. `plugin:<name>` is the host's canonical producer
// kind for a third-party plugin.
const PLUGIN_SOURCE = { kind: `plugin:${name}` }

const MCP_TOOL_PREFIX = 'mcp__gitnexus__'

function now() {
  return Date.now()
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
  const hintCache = new Map()
  let active = 0

  const debug = (...args) => {
    if (config.debug) ctx.logger.info(`dsh-gitnexus:`, ...args)
  }

  // A TUI profile provides `ctx.tuiStatus`; the contribution is resolved on
  // every write so a later-mounting TUI row is picked up too. Other profiles
  // have no such service and the controller stays inert.
  const hookStatus = config.enableTuiStatus
    ? createHookStatus({
        service: () => {
          try {
            return typeof ctx.get === 'function' ? ctx.get('tuiStatus') : undefined
          } catch {
            return undefined
          }
        },
        identity: ctx,
        lingerMs: config.tuiStatusLingerMs,
        logger: (...args) => debug('tui status:', ...args),
      })
    : undefined

  if (hookStatus && typeof ctx.effect === 'function') {
    ctx.effect(() => () => hookStatus.dispose())
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

    const cwd = resolveAugmentRoot(execution)
    const key = JSON.stringify([cwd, pattern])
    const cached = cacheValue(augmentCache, key, config.cacheTtlMs)
    if (cached !== undefined) return cached
    if (augmentInFlight.has(key)) return await augmentInFlight.get(key)

    const work = withSlot(async () => {
      const finish = hookStatus?.begin(runningLabel(pattern))
      let failure = ''
      try {
        const result = await runWithRunner(runner, ['augment', '--', pattern], {
          cwd,
          timeoutMs: config.augmentTimeoutMs,
          signal: execution.signal,
        })
        if (result.error) {
          failure = 'augment failed to start'
          debug(`augment launch failed for ${pattern}:`, String(result.error))
          return ''
        }
        if (result.timedOut) {
          failure = 'augment timed out'
          debug(`augment timed out for ${pattern}`)
          return ''
        }
        if (result.status !== 0) {
          failure = `augment failed (exit ${result.status})`
          debug(`augment exited with ${result.status} for ${pattern}`)
          return ''
        }
        const value = extractAugmentContext(result.stderr, config.contextMaxChars)
        finish?.(value ? contextLabel(value.length) : '')
        return value
      } catch (error) {
        failure = 'augment failed'
        throw error
      } finally {
        if (failure) finish?.(failureLabel(failure))
      }
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

    const cwd = resolveAugmentRoot(execution)

    // Keep this path cheap: read git and GitNexus registry metadata directly.
    // `gitnexus status --json` can spend several seconds opening the graph DB
    // and scanning content drift, which is too slow for a post-tool listener.
    return await withSlot(async () => {
      const finish = hookStatus?.begin(freshnessLabel())
      let status = ''
      try {
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
        status = staleLabel(state)
        return message
      } finally {
        finish?.(status)
      }
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

  async function cliFallbackHint() {
    if (!config.enableCliFallbackHint) return ''

    const cached = cacheValue(hintCache, 'mcp-registered', config.cliHintTtlMs)
    if (cached !== undefined) return cached ? '' : cliFallbackGuidance()

    let registered = true
    try {
      const schemas = await ctx.tools.schemas()
      registered = schemas.some(schema => String(schema?.name ?? '').startsWith(MCP_TOOL_PREFIX))
    } catch (error) {
      // An unreadable registry is not evidence the MCP surface is absent; only
      // a definite miss points the agent at the CLI.
      debug('tool registry check failed:', String(error))
    }
    setCacheValue(hintCache, 'mcp-registered', registered, config.cliHintTtlMs)
    return registered ? '' : cliFallbackGuidance()
  }

  ctx.on('tools/post-execute', async (execution, result, next) => {
    // Start our bounded side channel while downstream listeners run. The tool itself has already dispatched.
    const augmentPromise = augment({ ...execution, result })
    const stalePromise = staleNotice({ ...execution, result })
    const downstream = await next()
    const values = await Promise.all([augmentPromise, stalePromise])
    const contexts = values.map(context).filter(Boolean)

    if (contexts.length === 0) return downstream

    // The adapter has no standalone model-visible channel, so the CLI fallback
    // hint rides the first injected context — the moment the agent first uses
    // a search or git mutation — instead of adding noise to every tool result.
    const hint = await cliFallbackHint()
    if (hint) contexts.unshift(context(hint))

    return {
      ...downstream,
      additionalContexts: [...contexts, ...(downstream.additionalContexts ?? [])],
    }
  })
}
