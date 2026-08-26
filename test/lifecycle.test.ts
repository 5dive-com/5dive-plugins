// DIVE-3752 — the orphan watchdog, the launcher's voice, and the de-silenced
// channel start.
//
// Three arms, because the row's suggested acceptance names two traps and the
// repo's own history names a third:
//
//   1. UNIT — the decision function and the record format, executed. These are
//      pure, so a bare `bun test` with no plugin dependencies installed can
//      actually run them.
//   2. STATIC — every plugin that ends in a long-lived timer has watchdog
//      coverage, and all copies of lifecycle.ts are byte-identical. Comments
//      are STRIPPED before the assertion: "a bare `does it have a process.on`
//      grep is satisfiable by a comment" (DIVE-3752 body), and
//      [[extracting-a-rule-to-test-it-does-not-arm-the-caller]] — a pure module
//      that no server calls is not installed.
//   3. END-TO-END — spawn a real process behind a real parent, sever the parent,
//      assert the child exits. Armed with a POSITIVE CONTROL: a test asserting
//      "it exits" passes trivially if the process never started, so we first
//      prove the child was ALIVE and heartbeating with the parent up.

import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  isOrphaned, lifecycleLine, trimRecords, recordLifecycle, RECORD_FILE,
  readRealPpid, isBootParentAlive,
} from '../plugins/buzz/lifecycle.ts'

const PLUGINS = join(import.meta.dir, '..', 'plugins')

// Every plugin whose server.ts ends in a long-lived timer, i.e. every plugin
// that can be left running after its parent dies. Enumerated, not globbed: a
// new plugin should FAIL this list until someone decides which column it is in.
const TIMER_PLUGINS = [
  'telegram', 'buzz', 'dashboard',
  'telegram-agy', 'telegram-codex', 'telegram-grok', 'telegram-pi', 'telegram-opencode',
] as const
// Nothing is exempt. `telegram` was, until its inline watchdog turned out to
// carry a clause that cannot fire under Bun (see ./lifecycle.ts) — a broken
// implementation is not a proven one, so it installs the module too.

function src(plugin: string, file = 'server.ts'): string {
  return readFileSync(join(PLUGINS, plugin, file), 'utf8')
}

// Strip // line comments and /* */ blocks so a rule can never be satisfied by
// prose about the rule. Deliberately crude: it may eat a `//` inside a string
// literal, which can only make an assertion STRICTER, never falsely green.
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

// ── 1. unit: the orphan decision ────────────────────────────────────────────

describe('isOrphaned', () => {
  const live = {
    platform: 'linux', bootPpid: 100, currentPpid: 100, bootParentAlive: true,
    stdinDestroyed: false, stdinReadableEnded: false,
  }

  test('a healthy child of a live boot parent is not orphaned', () => {
    expect(isOrphaned(live)).toBe(false)
  })

  test('reparenting is the clause stdin cannot provide', () => {
    // Both stdin clauses are false here — the severed-parent case the whole
    // module exists for — so the verdict must come from the ppid reading.
    expect(isOrphaned({ ...live, currentPpid: 1, bootParentAlive: false })).toBe(true)
  })

  test('a dead boot parent is enough on its own', () => {
    // The fallback that covers an unreadable /proc: `readRealPpid` then returns
    // the STALE cached ppid, so the reparenting clause goes quiet and this is
    // the only reading left.
    expect(isOrphaned({ ...live, currentPpid: 100, bootParentAlive: false })).toBe(true)
  })

  test('stdin EOF still counts, on any platform', () => {
    expect(isOrphaned({ ...live, stdinDestroyed: true })).toBe(true)
    expect(isOrphaned({ ...live, stdinReadableEnded: true })).toBe(true)
    expect(isOrphaned({ ...live, platform: 'win32', stdinDestroyed: true })).toBe(true)
  })

  test('on win32 reparenting is not observable, so it must not be trusted', () => {
    expect(isOrphaned({ ...live, platform: 'win32', currentPpid: 1, bootParentAlive: false })).toBe(false)
  })
})

describe('the ppid reading is the KERNEL\'s, not Bun\'s cached one', () => {
  // MEASURED: under Bun `process.ppid` is captured at boot and never updated.
  // An orphan therefore compares a dead pid against itself and stays alive.
  // These two assertions are what stop that clause coming back.
  test('readRealPpid agrees with /proc for a live process', () => {
    expect(readRealPpid()).toBe(parseInt(
      readFileSync('/proc/self/status', 'utf8').match(/^PPid:\s*(\d+)/m)![1], 10))
  })

  test('isBootParentAlive is true for a live pid and false for a reaped one', () => {
    expect(isBootParentAlive(process.pid)).toBe(true)
    // pid 1 and 0 are "no meaningful parent to lose" — never report orphaned.
    expect(isBootParentAlive(1)).toBe(true)
    expect(isBootParentAlive(0)).toBe(true)
    // A pid that cannot exist.
    expect(isBootParentAlive(0x7ffffff0)).toBe(false)
  })

  test('no plugin compares process.ppid to a boot snapshot', () => {
    // The dead clause, as a regression guard across every plugin.
    for (const p of TIMER_PLUGINS) {
      const code = stripComments(src(p))
      expect(code).not.toMatch(/process\.ppid\s*!==/)
      expect(code).not.toMatch(/const\s+bootPpid\s*=\s*process\.ppid/)
    }
  })
})

// ── 1b. unit: the record ────────────────────────────────────────────────────

describe('the lifecycle record', () => {
  test('one event is one line, even when the reason contains newlines', () => {
    const l = lifecycleLine('crash', 'buzz', 'boom\nand\ttabs\r\n', new Date(0), 7, 8)
    expect(l.includes('\n')).toBe(false)
    expect(l).toBe('1970-01-01T00:00:00.000Z\tcrash\tbuzz\tpid=7\tppid=8\tboom and tabs')
  })

  test('an empty reason still produces a parseable line', () => {
    expect(lifecycleLine('exit', 'buzz', '   ', new Date(0), 1, 1).endsWith('\t-')).toBe(true)
  })

  test('a long reason is bounded, so one bad error cannot be the whole file', () => {
    const l = lifecycleLine('crash', 'buzz', 'x'.repeat(5000), new Date(0), 1, 1)
    expect(l.length).toBeLessThan(420)
  })

  test('trimRecords keeps the NEWEST lines', () => {
    const body = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n')
    expect(trimRecords(body, 3).split('\n')).toEqual(['line7', 'line8', 'line9'])
    expect(trimRecords('', 3)).toBe('')
    expect(trimRecords('a\n', 3)).toBe('a')
  })

  test('recordLifecycle creates the state dir and appends', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dive3752-'))
    try {
      const nested = join(dir, 'channels', 'buzz')
      recordLifecycle(nested, 'start', 'buzz', 'boot ok')
      recordLifecycle(nested, 'exit', 'buzz', 'SIGTERM')
      const body = readFileSync(join(nested, RECORD_FILE), 'utf8')
      const lines = body.split('\n').filter(Boolean)
      expect(lines.length).toBe(2)
      expect(lines[0]).toContain('\tstart\tbuzz\t')
      expect(lines[1]).toContain('\tSIGTERM')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an unwritable state dir does not throw — a diary must not kill a poller', () => {
    // A shutdown path that throws is a shutdown path that does not shut down.
    expect(() => recordLifecycle('/proc/definitely/not/writable', 'exit', 'buzz', 'x')).not.toThrow()
  })
})

// ── 2. static: it is INSTALLED, not merely available ────────────────────────

describe('the watchdog is installed in every plugin that can orphan', () => {
  test('all copies of lifecycle.ts are byte-identical', () => {
    // The marketplace publishes ./plugins/<name> as the unit and Claude Code
    // caches it per-plugin, so an import reaching outside the plugin directory
    // resolves in this repo and NOT on a customer box. Duplication is forced;
    // silent drift between the duplicates is not.
    const bodies = new Map<string, string>()
    for (const p of TIMER_PLUGINS) {
      const f = join(PLUGINS, p, 'lifecycle.ts')
      expect(existsSync(f)).toBe(true)
      bodies.set(p, readFileSync(f, 'utf8'))
    }
    expect(new Set(bodies.values()).size).toBe(1)
  })

  for (const p of TIMER_PLUGINS) {
    test(`${p}: has the ppid clause and a full handler set (comments stripped)`, () => {
      const code = stripComments(src(p))
      // The CALL, not the import: importing a module arms nobody
      // ([[extracting-a-rule-to-test-it-does-not-arm-the-caller]]).
      expect(code).toMatch(/installLifecycle\(\{/)
      expect(code).toContain(`channel: '${p}'`)
      expect(code).toContain('stateDir: STATE_DIR')
      // …and the module it calls is the one that binds the signals.
      const lc = stripComments(src(p, 'lifecycle.ts'))
      expect(lc).toContain("process.on('SIGTERM'")
      expect(lc).toContain("process.on('SIGHUP'")
      expect(lc).toMatch(/process\.stdin\.on\('end'/)
    })
  }
})

// ── 2b. static: the deafener cannot come back ───────────────────────────────

describe('the channel start is not gated on a network step', () => {
  const WITH_INSTALL = ['telegram', 'buzz', 'dashboard'] as const

  for (const p of TIMER_PLUGINS) {
    test(`${p}: the start script never guards the server behind &&`, () => {
      const pkg = JSON.parse(src(p, 'package.json')) as { scripts?: Record<string, string> }
      const start = pkg.scripts?.start ?? ''
      expect(start).toBeTruthy()
      // MEASURED (bun run --shell=bun): `false && echo X` exits 1 and never
      // echoes; `false; echo X` echoes and exits 0. So `&&` in front of the
      // server is exactly the mechanism by which a failed install becomes a
      // deaf seat with no error anyone reads.
      expect(start).not.toContain('&&')
      // …and the server is still actually started.
      expect(start).toMatch(/bun (start|server)\.ts/)
    })
  }

  for (const p of WITH_INSTALL) {
    test(`${p}: goes through start.ts, which can speak when server.ts cannot`, () => {
      const pkg = JSON.parse(src(p, 'package.json')) as { scripts?: Record<string, string> }
      expect(pkg.scripts?.start).toContain('bun start.ts')
      const boot = stripComments(src(p, 'start.ts'))
      expect(boot).toContain('recordLifecycle')
      expect(boot).toContain("await import('./server.ts')")
      // start.ts must import node builtins + lifecycle.ts ONLY: it has to load
      // in the one case server.ts cannot — deps missing.
      const imports = [...boot.matchAll(/from\s+'([^']+)'/g)].map(m => m[1])
      for (const i of imports) {
        expect(i === './lifecycle.ts' || i.startsWith('node:')).toBe(true)
      }
    })
  }
})

// ── 3. end-to-end: sever the parent, with a positive control ────────────────

describe('a severed parent actually kills the poller', () => {
  test('the child heartbeats while the parent lives, then exits when orphaned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dive3752-e2e-'))
    try {
      const beat = join(dir, 'beat')
      const harness = join(dir, 'harness.ts')
      // A faithful miniature of plugins/buzz/server.ts before this change: a
      // long-lived, NON-unref'd interval, plus the lifecycle we just installed.
      writeFileSync(harness, `
import { writeFileSync } from 'node:fs'
import { installLifecycle } from ${JSON.stringify(join(PLUGINS, 'buzz', 'lifecycle.ts'))}
installLifecycle({ channel: 'harness', stateDir: ${JSON.stringify(dir)}, watchdogMs: 500, forceExitMs: 200 })
// This is what keeps the process alive — the poller's own timer, unref'd by
// nobody. The watchdog is unref'd and must never be the thing holding it open.
setInterval(() => writeFileSync(${JSON.stringify(beat)}, String(Date.now())), 100)
`)
      // The grandchild shape that actually reproduces this: claude → bun run → us.
      // `bun harness.ts & wait` (not `exec`) so killing the shell leaves the bun
      // process reparented, which is the ONLY thing that changes its ppid.
      const parent = Bun.spawn(['bash', '-c', `bun ${harness} & echo $! > ${dir}/child.pid; wait`], {
        // A pipe we hold open: the real MCP stdio transport keeps stdin open, and
        // an 'ignore'd stdin would hit the EOF clause instantly and pass this
        // test for the wrong reason.
        stdin: 'pipe', stdout: 'ignore', stderr: 'ignore',
      })

      const wait = async (p: () => boolean, ms: number) => {
        const end = Date.now() + ms
        while (Date.now() < end) { if (p()) return true; await Bun.sleep(50) }
        return false
      }

      // ── POSITIVE CONTROL ──
      // Without this, "the child exited" is satisfied by a child that never ran.
      expect(await wait(() => existsSync(beat), 15_000)).toBe(true)
      const pid = parseInt(readFileSync(join(dir, 'child.pid'), 'utf8').trim(), 10)
      expect(pid).toBeGreaterThan(0)
      const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
      expect(alive()).toBe(true)
      // …and it is STILL beating a second later, i.e. the watchdog is not just
      // firing on boot for some unrelated reason.
      const first = statSync(beat).mtimeMs
      await Bun.sleep(1200)
      expect(statSync(beat).mtimeMs).toBeGreaterThan(first)
      expect(alive()).toBe(true)

      // ── sever the parent ──
      parent.kill('SIGKILL')
      await parent.exited

      // watchdogMs is 500 here (5000 in production); 15s is generous slack.
      // Before the /proc read replaced `process.ppid`, this line was the one
      // that failed — the child sat alive for the full 15s.
      expect(await wait(() => !alive(), 15_000)).toBe(true)

      // And it said why, rather than just vanishing.
      const rec = readFileSync(join(dir, RECORD_FILE), 'utf8')
      expect(rec).toContain('\tstart\tharness\t')
      expect(rec).toMatch(/\texit\tharness\t.*orphaned/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
