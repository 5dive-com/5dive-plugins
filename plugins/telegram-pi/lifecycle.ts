// plugins/*/lifecycle.ts — orphan watchdog, shutdown wiring, and a start/exit
// record for a plugin MCP server that ends in a long-lived timer.
//
// WHY THIS IS A MODULE AND NOT A SNIPPET (DIVE-3751 → DIVE-3752):
// [[bun-run-does-not-forward-sigterm-so-mcp-servers-orphan]] compiled this class
// on 2026-08-16 (DIVE-3486). It was then INSTALLED IN EXACTLY ONE PLUGIN.
// `plugins/telegram/server.ts` carried the remedy; `plugins/buzz/server.ts`
// carried none of it and leaked one poller per restart for six days — 22
// reparented processes on one seat, all healthy, none wedged, every one of them
// killable with a plain SIGTERM. That signature is a missing handler, not a hung
// poll. Compiling a lesson is not applying it; a shared module is.
//
// WHY IT IS DUPLICATED PER PLUGIN DIRECTORY:
// `.claude-plugin/marketplace.json` publishes `./plugins/<name>` as the unit and
// Claude Code caches it at `<cache>/5dive-plugins/<plugin>/<version>/`, so an
// import reaching outside the plugin directory resolves here and NOT on a
// customer box. The copies are therefore byte-identical by construction and
// `test/lifecycle-parity.test.ts` fails if they drift.
//
// WHY THE DECISIONS ARE PURE:
// repo CI runs a bare `bun test` with no plugin dependencies installed, so
// anything importing `@modelcontextprotocol/sdk` or `@noble/curves` is
// unexecutable there. This file imports node builtins ONLY, which is what lets
// the watchdog's decision function and the record format be actually executed by
// CI instead of grepped for.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ── the orphan decision, as a pure function ─────────────────────────────────

// MEASURED 2026-08-26, and it is why this module is not a copy of the telegram
// snippet: under Bun, `process.ppid` is CACHED AT BOOT AND NEVER REFRESHED.
// A grandchild whose parent was SIGKILLed reported, every 500ms for six
// seconds, `process.ppid = <the dead parent>` while `ps` showed its real ppid
// was 1:
//
//     t=2s   cached=54284  realPpid=54284  bootAlive=true
//     t=2.5s cached=54284  realPpid=1      bootAlive=false    ← parent killed
//     t=5.5s cached=54284  realPpid=1      bootAlive=false
//
// So `process.ppid !== bootPpid` — the load-bearing clause of the watchdog in
// `plugins/telegram/server.ts`, and the clause the compiled wiki page credits
// for telegram's zero orphans — CANNOT EVER FIRE under Bun. Telegram's zero
// orphans came from its stdin `end`/`close` handlers, not from that comparison.
// That matters because the page's own reason for having the ppid clause is that
// "stdin events don't reliably fire when the parent chain is severed": in
// exactly the case the clause exists to cover, neither signal worked.
//
// Two readings do work, and both flipped at the instant of severance above:
//   * the kernel's own answer — `PPid:` in /proc/self/status;
//   * whether the boot parent is still a process at all — kill(pid, 0).
// The probe is injected rather than read here so this decision stays pure and
// repo CI (a bare `bun test`, no plugin deps) can execute it.

export type OrphanProbe = {
  platform: string
  /** ppid captured at boot. */
  bootPpid: number
  /** The ppid RIGHT NOW, read from the OS — never `process.ppid`. */
  currentPpid: number
  /** Whether the boot parent is still a live process. */
  bootParentAlive: boolean
  stdinDestroyed: boolean
  stdinReadableEnded: boolean
}

export function isOrphaned(p: OrphanProbe): boolean {
  // EOF on the MCP stdio transport: the ordinary, clean case, and the only one
  // that works on win32.
  if (p.stdinDestroyed || p.stdinReadableEnded) return true
  // Reparenting is not observable on win32, so it must not be trusted there.
  if (p.platform === 'win32') return false
  // Reparented (to init, or to whatever subreaper claimed us).
  if (p.currentPpid !== p.bootPpid) return true
  // Belt and braces: if /proc is unreadable, currentPpid falls back to the
  // stale cached value and the clause above goes quiet. The parent being gone
  // is then the only reading left, and it is enough.
  return !p.bootParentAlive
}

/**
 * The real ppid, from the kernel. Falls back to the (possibly stale) cached
 * `process.ppid` when /proc is unavailable — the liveness clause covers that.
 */
export function readRealPpid(): number {
  try {
    const m = readFileSync('/proc/self/status', 'utf8').match(/^PPid:\s*(\d+)/m)
    if (m) return parseInt(m[1], 10)
  } catch {}
  return process.ppid
}

/** True if `pid` is still a process. EPERM means alive-but-not-ours. */
export function isBootParentAlive(pid: number): boolean {
  if (!pid || pid <= 1) return true // no meaningful parent to lose
  try {
    process.kill(pid, 0)
    return true
  } catch (err: unknown) {
    return (err as { code?: string })?.code === 'EPERM'
  }
}

// ── the record: a channel start failure must not be encoded as `nothing` ────

// DIVE-3810 added 'auth': a channel whose CREDENTIAL died mid-run is neither
// started, exited nor crashed — the process is healthy and every other
// surface reads healthy with it — so without an event of its own that state
// is recorded as `nothing`, which is the failure this file exists to refuse.
export type LifecycleEvent = 'start' | 'exit' | 'crash' | 'auth'

/**
 * One line, one event, parseable and human-readable.
 *
 * [[no-beacon-has-three-states-and-only-the-process-table-separates-them]]:
 * the DIVE-1434 canary reads only the heartbeat's mtime, so `no beacon` reports
 * one string for three distinguishable failures — the channel never started, a
 * dependency step ate the poller, or the poller is up and not bumping. An absent
 * beacon cannot separate them; a record that says which one happened can.
 */
export function lifecycleLine(
  ev: LifecycleEvent,
  channel: string,
  reason: string,
  at: Date,
  pid: number,
  ppid: number,
): string {
  // No newlines or tabs from `reason` — one event must stay one line.
  const clean = reason.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300) || '-'
  return `${at.toISOString()}\t${ev}\t${channel}\tpid=${pid}\tppid=${ppid}\t${clean}`
}

/** Keep the newest `keep` lines. Bounded, because nothing rotates this file. */
export function trimRecords(existing: string, keep: number): string {
  const lines = existing.split('\n').filter(l => l.length > 0)
  return lines.slice(Math.max(0, lines.length - keep)).join('\n')
}

export const RECORD_FILE = 'lifecycle.log'
const RECORD_KEEP = 200

/**
 * Append one record line. Never throws: a plugin must not die because its own
 * diary is unwritable, and a shutdown path in particular must still exit.
 */
export function recordLifecycle(
  stateDir: string,
  ev: LifecycleEvent,
  channel: string,
  reason: string,
  now: Date = new Date(),
): void {
  const line = lifecycleLine(ev, channel, reason, now, process.pid, process.ppid)
  try {
    mkdirSync(stateDir, { recursive: true })
    const path = join(stateDir, RECORD_FILE)
    appendFileSync(path, line + '\n')
    // Bound it lazily — only pay the read/rewrite when it has actually grown.
    let body = ''
    try { body = readFileSync(path, 'utf8') } catch { return }
    if (body.split('\n').length > RECORD_KEEP * 2) {
      writeFileSync(path, trimRecords(body, RECORD_KEEP) + '\n')
    }
  } catch {
    // fall through — stderr below is the last resort
  }
  // Also to stderr, which is where a live session's own logs go.
  try { process.stderr.write(`${channel} channel: ${ev}: ${reason}\n`) } catch {}
}

// ── the wiring ──────────────────────────────────────────────────────────────

export type LifecycleOpts = {
  /** Plugin name, used in the record and the stderr prefix. */
  channel: string
  /** Directory the record is written to — normally the channel's state dir. */
  stateDir: string
  /** Plugin-specific cleanup (drop a pid file, stop a bot). May be async. */
  cleanup?: () => void | Promise<void>
  /** Hard backstop: exit this long after cleanup starts, no matter what. */
  forceExitMs?: number
  /** Watchdog cadence. */
  watchdogMs?: number
}

/**
 * Install the whole lifecycle: a start record, an idempotent shutdown bound to
 * every signal and stdin EOF, and the orphan watchdog.
 *
 * Returns the shutdown function so a caller can trigger it from its own paths.
 */
export function installLifecycle(opts: LifecycleOpts): (reason: string) => void {
  const { channel, stateDir, cleanup, forceExitMs = 2000, watchdogMs = 5000 } = opts
  const bootPpid = process.ppid

  recordLifecycle(stateDir, 'start', channel, `boot ok (bootPpid=${bootPpid})`)

  let shuttingDown = false
  const shutdown = (reason: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    recordLifecycle(stateDir, 'exit', channel, reason)
    // Force-exit backstop first: if cleanup hangs (a poll in flight, a relay
    // socket that will not close) we must still stop being a process. Without
    // this, "we called shutdown" and "we exited" are different claims.
    const t = setTimeout(() => process.exit(0), forceExitMs)
    t.unref?.()
    void (async () => {
      try { await cleanup?.() } catch {}
      process.exit(0)
    })()
  }

  process.stdin.on('end', () => shutdown('stdin end'))
  process.stdin.on('close', () => shutdown('stdin close'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGHUP', () => shutdown('SIGHUP'))

  const wd = setInterval(() => {
    const currentPpid = readRealPpid()
    const orphaned = isOrphaned({
      platform: process.platform,
      bootPpid,
      currentPpid,
      bootParentAlive: isBootParentAlive(bootPpid),
      stdinDestroyed: process.stdin.destroyed,
      stdinReadableEnded: process.stdin.readableEnded,
    })
    if (orphaned) shutdown(`orphaned (bootPpid=${bootPpid} ppid=${currentPpid})`)
  }, watchdogMs)
  // unref: the watchdog must never be the reason this process stays alive.
  wd.unref?.()

  return shutdown
}
