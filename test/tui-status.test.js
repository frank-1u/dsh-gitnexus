import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TUI_STATUS_KEY,
  clipStatusText,
  contextLabel,
  createHookStatus,
  failureLabel,
  freshnessLabel,
  formatCharCount,
  runningLabel,
  staleLabel,
} from '../lib/tui-status.js'

function fakeTui() {
  const writes = []
  let token = 0
  let current
  return {
    writes,
    get current() {
      return current?.text
    },
    set(key, text, identity) {
      const write = { token: ++token, key, text, identity }
      writes.push(write)
      current = write
      return () => {
        if (current === write) current = undefined
      }
    },
  }
}

/** Deterministic timer queue: one `advance` fires everything due, including timers rescheduled at the same instant. */
function fakeClock() {
  let now = 0
  let nextId = 1
  const timers = new Map()
  return {
    setTimeout(fn, ms) {
      const id = nextId++
      timers.set(id, { at: now + Math.max(0, ms), fn })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    advance(ms) {
      now += ms
      let ran = true
      while (ran) {
        ran = false
        for (const [id, timer] of [...timers]) {
          if (timer.at > now) continue
          timers.delete(id)
          timer.fn()
          ran = true
        }
      }
    },
    get pending() {
      return timers.size
    },
  }
}

function statusWith(clock, tui, options = {}) {
  return createHookStatus({
    service: () => tui,
    identity: { plugin: 'dsh-gitnexus' },
    lingerMs: 500,
    runningDelayMs: 250,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
    ...options,
  })
}

test('publishes the running label only after the delay, then lingers the outcome', () => {
  const clock = fakeClock()
  const tui = fakeTui()
  const status = statusWith(clock, tui)

  const end = status.begin(runningLabel('extractSearchPattern'))
  assert.equal(tui.writes.length, 0, 'a short run must not flash the line')
  clock.advance(249)
  assert.equal(tui.writes.length, 0)
  clock.advance(1)
  assert.equal(tui.current, 'GitNexus · searching graph for "extractSearchPattern"')

  end(contextLabel(1234))
  assert.equal(tui.current, 'GitNexus ✓ context +1.2k')
  clock.advance(499)
  assert.equal(tui.current, 'GitNexus ✓ context +1.2k')
  clock.advance(1)
  assert.equal(tui.current, undefined)

  assert.equal(tui.writes[0].key, TUI_STATUS_KEY)
  assert.equal(tui.writes[0].identity.plugin, 'dsh-gitnexus')
})

test('a run that finishes before the delay and has no outcome writes nothing', () => {
  const clock = fakeClock()
  const tui = fakeTui()
  const status = statusWith(clock, tui)

  status.begin(runningLabel('foo'))('')
  clock.advance(10000)
  assert.equal(tui.writes.length, 0)
  assert.equal(clock.pending, 0)
})

test('concurrent work keeps the latest label and the final outcome', () => {
  const clock = fakeClock()
  const tui = fakeTui()
  const status = statusWith(clock, tui)

  const first = status.begin(runningLabel('first'))
  const second = status.begin(runningLabel('second'))
  clock.advance(250)
  assert.equal(tui.current, 'GitNexus · searching graph for "second" (+1)')

  first(contextLabel(10))
  assert.equal(tui.current, 'GitNexus · searching graph for "second"')
  second(contextLabel(20))
  assert.equal(tui.current, 'GitNexus ✓ context +20')
})

test('show waits for running work, then lingers its own ttl', () => {
  const clock = fakeClock()
  const tui = fakeTui()
  const status = statusWith(clock, tui)

  const end = status.begin(runningLabel('first'))
  clock.advance(250)
  status.show(staleLabel({ indexedCommit: '1111111aaa', currentCommit: '2222222bbb' }), 100)
  assert.equal(tui.current, 'GitNexus · searching graph for "first"')

  end('')
  assert.equal(tui.current, 'GitNexus ⚠ index stale (1111111 → 2222222)')
  clock.advance(99)
  assert.equal(tui.current, 'GitNexus ⚠ index stale (1111111 → 2222222)')
  clock.advance(1)
  assert.equal(tui.current, undefined)
})

test('a missing or throwing service is inert', () => {
  const clock = fakeClock()
  const logged = []
  const missing = createHookStatus({
    service: () => undefined,
    identity: 'ctx',
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
  })
  assert.doesNotThrow(() => missing.begin('GitNexus · one')('GitNexus ✓ one'))

  const broken = createHookStatus({
    service: () => {
      throw new Error('no tui here')
    },
    identity: 'ctx',
    logger: (...args) => logged.push(args),
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
  })
  assert.doesNotThrow(() => broken.begin('GitNexus · one')('GitNexus ✓ one'))
  assert.equal(logged.length > 0, true)
})

test('a service without set is ignored', () => {
  const clock = fakeClock()
  const status = createHookStatus({
    service: () => ({ subscribe() {} }),
    identity: 'ctx',
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
  })
  assert.doesNotThrow(() => status.begin('GitNexus · one')('GitNexus ✓ one'))
})

test('dispose clears the visible contribution and its timer', () => {
  const clock = fakeClock()
  const tui = fakeTui()
  const status = statusWith(clock, tui)

  status.begin(runningLabel('first'))
  clock.advance(250)
  assert.equal(typeof tui.current, 'string')

  status.dispose()
  assert.equal(tui.current, undefined)
  assert.equal(clock.pending, 0)
})

test('status labels stay on one bounded line', () => {
  const longPattern = 'x'.repeat(200)
  const label = runningLabel(longPattern)
  assert.equal(label.includes('\n'), false)
  assert.equal(label.length < 200, true)
  assert.match(label, /…"$/)

  assert.equal(contextLabel(999), 'GitNexus ✓ context +999')
  assert.equal(contextLabel(1234), 'GitNexus ✓ context +1.2k')
  assert.equal(failureLabel('augment timed out'), 'GitNexus ✗ augment timed out')
  assert.equal(failureLabel(''), 'GitNexus ✗ augment failed')
  assert.equal(freshnessLabel(), 'GitNexus · checking index freshness')
  assert.equal(clipStatusText('a\nb\tc'), 'a b c')
  assert.equal(formatCharCount(-1), '0')
})
