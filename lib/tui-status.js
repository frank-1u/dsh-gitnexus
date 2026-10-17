/**
 * TUI hook-status contribution for the adapter's post-execute work.
 *
 * Composed TUI profiles provide `ctx.tuiStatus`; the adapter publishes one
 * keyed contribution above the prompt. The line reports the adapter's own
 * work — the GitNexus subprocess and its outcome — not the model turn, in the
 * spirit of a Claude Code hook status. It appears only after the work has run
 * long enough to notice, keeps an outcome for a short linger, and leaves no
 * residue when the work produced nothing.
 *
 * Headless, Web and Desktop profiles have no `tuiStatus` service; every entry
 * point then no-ops so the adapter stays inert there.
 */

export const TUI_STATUS_KEY = 'gitnexus'

const MAX_TEXT_CELLS = 180
const MAX_PATTERN_CHARS = 48
const DEFAULT_RUNNING_DELAY_MS = 250

function oneLine(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Bound a contribution to one plain line the host can render without wrapping. */
export function clipStatusText(value, max = MAX_TEXT_CELLS) {
  const text = oneLine(value)
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function clipPattern(pattern) {
  const text = oneLine(pattern)
  return text.length <= MAX_PATTERN_CHARS ? text : `${text.slice(0, MAX_PATTERN_CHARS - 1)}…`
}

export function formatCharCount(chars) {
  const count = Number(chars)
  if (!Number.isFinite(count) || count <= 0) return '0'
  if (count < 1000) return String(Math.round(count))
  return `${Math.round(count / 100) / 10}k`
}

export function runningLabel(pattern) {
  return `GitNexus · searching graph for "${clipPattern(pattern)}"`
}

export function freshnessLabel() {
  return 'GitNexus · checking index freshness'
}

export function contextLabel(chars) {
  return `GitNexus ✓ context +${formatCharCount(chars)}`
}

export function failureLabel(reason) {
  return `GitNexus ✗ ${oneLine(reason) || 'augment failed'}`
}

export function staleLabel(state) {
  const indexed = typeof state?.indexedCommit === 'string' && state.indexedCommit ? state.indexedCommit.slice(0, 7) : 'unknown'
  const current = typeof state?.currentCommit === 'string' && state.currentCommit ? state.currentCommit.slice(0, 7) : 'unknown'
  return `GitNexus ⚠ index stale (${indexed} → ${current})`
}

/**
 * Create the keyed status controller.
 *
 * `service` is resolved on every write, so the contribution also works when
 * the TUI's extension row mounts after this plugin. A refused or throwing
 * service never propagates into the tool pipeline.
 *
 * `begin(label)` returns `end(outcome)`. While one or more operations run the
 * line shows the latest running label (with a `(+n)` suffix); when the last
 * one ends, the most recent outcome is painted and cleared after `lingerMs`.
 * `show(text)` publishes an outcome that is not a running operation, and
 * waits for running work to finish before taking the line.
 */
export function createHookStatus(options = {}) {
  const {
    service,
    identity,
    lingerMs = 4000,
    runningDelayMs = DEFAULT_RUNNING_DELAY_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    logger,
  } = options

  const running = new Map()
  let nextId = 1
  let disposer
  let timer
  let lastResult = ''
  let lastResultTtl = lingerMs
  let disposed = false

  function log(...args) {
    try {
      logger?.(...args)
    } catch {
      // A diagnostic hook must never break the status path.
    }
  }

  function cancelTimer() {
    if (timer === undefined) return
    try {
      clearTimer(timer)
    } catch (error) {
      log('status timer cancellation failed', error)
    }
    timer = undefined
  }

  function schedule(fn, delay) {
    cancelTimer()
    try {
      timer = setTimer(() => {
        timer = undefined
        fn()
      }, Math.max(0, delay))
      timer?.unref?.()
    } catch (error) {
      log('status timer failed', error)
    }
  }

  function currentService() {
    try {
      return service?.()
    } catch (error) {
      log('status service lookup failed', error)
      return undefined
    }
  }

  function paint(text) {
    if (disposed) return
    const tui = currentService()
    if (!tui || typeof tui.set !== 'function') return
    try {
      const next = text
        ? tui.set(TUI_STATUS_KEY, clipStatusText(text), identity)
        : tui.set(TUI_STATUS_KEY, undefined, identity)
      const previous = disposer
      disposer = typeof next === 'function' ? next : undefined
      if (previous) previous()
    } catch (error) {
      log('status write failed', error)
    }
  }

  function clear() {
    cancelTimer()
    lastResult = ''
    const previous = disposer
    disposer = undefined
    if (!previous) return
    try {
      previous()
    } catch (error) {
      log('status clear failed', error)
    }
  }

  function renderRunning() {
    if (disposed || running.size === 0) return
    const labels = [...running.values()]
    const latest = labels[labels.length - 1]
    paint(labels.length > 1 ? `${latest} (+${labels.length - 1})` : latest)
  }

  function finish(id, message) {
    if (disposed || !running.has(id)) return
    running.delete(id)
    const outcome = typeof message === 'string' ? clipStatusText(message) : ''
    if (outcome) {
      lastResult = outcome
      lastResultTtl = lingerMs
    }

    if (running.size > 0) {
      cancelTimer()
      renderRunning()
      return
    }

    cancelTimer()
    if (!lastResult) {
      clear()
      return
    }
    paint(lastResult)
    schedule(() => {
      if (disposed || running.size > 0) return
      clear()
    }, lastResultTtl)
  }

  function begin(label) {
    if (disposed) return () => {}
    const id = nextId++
    // A new batch supersedes the previous outcome; a `show` during the batch
    // still owns the line until the batch ends.
    if (running.size === 0) {
      lastResult = ''
      lastResultTtl = lingerMs
    }
    running.set(id, clipStatusText(label))
    if (running.size === 1) {
      cancelTimer()
      schedule(renderRunning, runningDelayMs)
    }
    let ended = false
    return message => {
      if (ended) return
      ended = true
      finish(id, message)
    }
  }

  function show(message, ttlMs = lingerMs) {
    if (disposed) return
    const text = typeof message === 'string' ? clipStatusText(message) : ''
    if (!text) return
    lastResult = text
    lastResultTtl = Math.max(0, ttlMs)
    if (running.size > 0) return
    cancelTimer()
    paint(text)
    schedule(() => {
      if (disposed || running.size > 0) return
      clear()
    }, lastResultTtl)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    running.clear()
    cancelTimer()
    const previous = disposer
    disposer = undefined
    try {
      previous?.()
    } catch {
      // The host is already tearing the contribution down.
    }
  }

  return { begin, show, clear, dispose }
}
