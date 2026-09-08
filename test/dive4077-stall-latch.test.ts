// DIVE-4077 — a codex/grok/agy seat with Telegram could go PERMANENTLY deaf to
// its owner, across restarts, while /status still answered green.
//
// Two shipped defects, both customer-visible on every box running a codex agent
// with a channel:
//
//   1. THE LATCH. `stallAlerted` gated DELIVERY — while set, every inbound was
//      answered with a canned refusal and was NOT queued. The empty queue then
//      made the re-arm watchdog return at its `inboxQueue.length === 0` guard
//      before it could reach clearStallAlert(), so nothing could ever clear the
//      flag; and it was initialized from a stamp on disk, so a restart reloaded
//      it. The owner's last recourse put the agent straight back into refusing.
//   2. THE PANE IS NOT THE MODEL. On a codex seat with a channel the tmux pane
//      belongs to the telegram dispatcher (#770 / DIVE-4036), so the re-arm
//      keystrokes landed in the dispatcher's stdin, the kick could never be
//      observed, three unobservable kicks escalated a merely-BUSY agent to
//      "wedged", and the stall classifier scraped that same pane and printed the
//      dispatcher's own boot log to the owner as "last lines on its screen".
//      Delivery had the same hole: it routed on DISPATCHER_ADAPTER, an env var
//      set only on the instance dispatcher.ts spawns — never on the MCP bridge
//      that actually owns the Telegram token — so an inbound on a dispatcher
//      seat was parked for a wait_for_message that seat never calls.
//
// Static, like dive3786-honest-stall-cause.test.ts: importing a server
// long-polls Telegram. The one thing a static guard cannot grade is whether the
// new predicate reads the declaration CORRECTLY, so that is evaluated for real
// at the bottom.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PLUGINS = join(import.meta.dir, '..', 'plugins')
const FORKS = ['telegram-codex', 'telegram-grok', 'telegram-agy'] as const

const src = (fork: string) => readFileSync(join(PLUGINS, fork, 'server.ts'), 'utf8')

/** One top-level function body, from its `function` line to the closing brace in
 *  column 0. Fork-safe: an anchor that only exists in one fork must not silently
 *  slice to end-of-file and pass an assertion by accident. */
const fnBody = (s: string, anchor: string): string => {
  const i = s.indexOf(anchor)
  expect(i).toBeGreaterThan(-1)
  const end = s.indexOf('\n}\n', i)
  expect(end).toBeGreaterThan(i)
  return s.slice(i, end + 3)
}

// ── 1. THE LATCH — all three forks ──────────────────────────────────────────
describe.each(FORKS)('%s stall flag cannot be inherited from disk', (fork) => {
  test('the DELIVERY gate starts false on every boot', () => {
    const s = src(fork)
    expect(s).toMatch(/let stallAlerted = false/)
    // The regression: seeding the delivery gate from the stamp.
    expect(s).not.toMatch(/let stallAlerted = existsSync\(/)
  })

  test('ping dedup is a SEPARATE flag, and it is the one the stamp seeds', () => {
    const s = src(fork)
    expect(s).toMatch(/let stallPinged = existsSync\(LAST_STALL_ALERT_FILE\)/)
    expect(s).toMatch(/if \(stallAlerted \|\| stallPinged\) return/)
  })

  test('what refuses delivery is the live flag, never the persisted one', () => {
    // The refusal branch in enqueueInbound must consult stallAlerted only —
    // consulting stallPinged there would restore the across-restart latch.
    const s = src(fork)
    const body = fnBody(s, 'function enqueueInbound')
    expect(body).toMatch(/STALL_ALERT_DISABLED && stallAlerted/)
    expect(body).not.toMatch(/stallPinged/)
  })

  test('recovery clears both flags and the stamp', () => {
    const s = src(fork)
    const i = s.indexOf('function clearStallAlert')
    const body = s.slice(i, s.indexOf('\n}', i))
    expect(body).toMatch(/stallAlerted = false/)
    expect(body).toMatch(/stallPinged = false/)
    expect(body).toMatch(/unlinkSync\(LAST_STALL_ALERT_FILE\)/)
  })
})

// ── 2. THE PANE IS NOT THE MODEL — codex only ───────────────────────────────
// grok and agy keep a real CLI in the pane; only the codex fork has the
// app-server dispatcher shape, so only it carries this predicate.
describe('telegram-codex dispatcher seat', () => {
  const s = () => src('telegram-codex')

  test('the seat shape is READ from the launcher declaration, not re-derived', () => {
    const body = s().slice(s().indexOf('const PANE_IS_THE_MODEL'))
      .slice(0, s().slice(s().indexOf('const PANE_IS_THE_MODEL')).indexOf('})()') + 4)
    expect(body).toMatch(/\.5dive/)
    expect(body).toMatch(/delivery\.env/)
    expect(body).toMatch(/dispatcher-inbox/)
    // Re-deriving the seat's shape in a second place is the defect DIVE-4036
    // was filed for; the declaration exists so nobody has to.
    expect(body).not.toMatch(/agents\.d/)
    expect(body).not.toMatch(/AGENT_CHANNELS/)
  })

  test('the re-arm kick returns before it can type into the dispatcher', () => {
    const i = s().indexOf('function kickListenLoop(): void')
    const body = s().slice(i, s().indexOf('\n// ', i))
    const guard = body.indexOf('!PANE_IS_THE_MODEL')
    const keys = body.indexOf('kickListenLoopOnce')
    expect(guard).toBeGreaterThan(-1)
    expect(keys).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(keys)
  })

  test('the re-arm watchdog never starts on a dispatcher seat', () => {
    const i = s().indexOf('function startRearmWatchdog')
    const body = s().slice(i, s().indexOf('\n}', s().indexOf('setInterval', i)))
    const guard = body.indexOf('!PANE_IS_THE_MODEL')
    const timer = body.indexOf('setInterval')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(timer)
  })

  test('the stall classifier never captures a pane it does not own', () => {
    const i = s().indexOf('function detectStallCause')
    const body = s().slice(i, s().indexOf('\n// detectStallCause does', i))
    const guard = body.indexOf('!PANE_IS_THE_MODEL')
    const capture = body.indexOf('capture-pane')
    expect(guard).toBeGreaterThan(-1)
    expect(capture).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(capture)
  })

  test('delivery routes on the SEAT, not on how this process was spawned', () => {
    const body = fnBody(s(), 'function enqueueInbound')
    // The bug: gating the inbox path on DISPATCHER_ADAPTER, which is never set
    // on the MCP bridge that owns the Telegram token.
    expect(body).not.toMatch(/if \(DISPATCHER_ADAPTER\) \{/)
    expect(body).toMatch(/if \(!PANE_IS_THE_MODEL\) \{/)
    // …and it must come BEFORE the stall refusal, so a dispatcher seat can
    // never answer a canned refusal instead of delivering.
    expect(body.indexOf('!PANE_IS_THE_MODEL')).toBeLessThan(body.indexOf('stallAlerted'))
  })
})

// ── 3. THE PREDICATE ITSELF, evaluated ──────────────────────────────────────
// A static guard cannot tell a correct declaration reader from a broken regex,
// and a broken one reads as "the pane IS the model" — which is exactly the
// outage. So lift the real source of the IIFE out and run it against stubs.
describe('PANE_IS_THE_MODEL evaluates the declaration correctly', () => {
  const whole = src('telegram-codex')
  const start = whole.indexOf('const PANE_IS_THE_MODEL = (() => {')
  const end = whole.indexOf('})()', start) + 4
  const snippet = whole.slice(start, end)

  const evaluate = (opts: {
    adapter?: boolean
    env?: Record<string, string | undefined>
    declaration?: string | null
  }) => {
    const fn = new Function(
      'DISPATCHER_ADAPTER', 'process', 'readFileSync', 'join', 'homedir',
      snippet.replace('const PANE_IS_THE_MODEL = ', 'return '),
    )
    return fn(
      opts.adapter ?? false,
      { env: opts.env ?? {} },
      (_p: string) => {
        if (opts.declaration == null) throw new Error('ENOENT')
        return opts.declaration
      },
      (...parts: string[]) => parts.join('/'),
      () => '/home/agent-codex',
    ) as boolean
  }

  const DISPATCHER_DECL = [
    '# written by 5dive-agent-start; regenerated on every boot (DIVE-4036)',
    'AGENT_DELIVERY=dispatcher-inbox',
    'AGENT_DELIVERY_TYPE=codex',
    'AGENT_DELIVERY_CHANNELS=telegram',
    '',
  ].join('\n')

  test('a dispatcher declaration means the pane is NOT the model', () => {
    expect(evaluate({ declaration: DISPATCHER_DECL })).toBe(false)
  })

  test('a pane declaration means it still is', () => {
    expect(evaluate({ declaration: 'AGENT_DELIVERY=pane\nAGENT_DELIVERY_TYPE=codex\n' })).toBe(true)
  })

  test('a box too old to have the declaration keeps the historical behaviour', () => {
    // Reading a MISSING declaration as "dispatcher" would send every legacy
    // seat's messages into an inbox nothing drains — silent, and worse.
    expect(evaluate({ declaration: null })).toBe(true)
  })

  test('the adapter instance never takes the pane path', () => {
    expect(evaluate({ adapter: true, declaration: null })).toBe(false)
  })

  test('a dispatcher-launched process is recognised from its env alone', () => {
    expect(evaluate({ env: { CODEX_DISPATCHER_CHANNELS: 'telegram' }, declaration: null })).toBe(false)
  })

  test('the substring alone does not decide it — the KEY must match', () => {
    // "dispatcher-inbox" appearing in a comment or another key must not flip a
    // pane seat into the inbox path.
    expect(evaluate({
      declaration: '# the dispatcher-inbox path is not in use here\nAGENT_DELIVERY=pane\n',
    })).toBe(true)
  })
})
