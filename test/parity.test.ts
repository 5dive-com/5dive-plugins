// Parity CI for the telegram-{codex,grok,agy} forks (DIVE-8).
//
// Why this exists: the forks are hand-maintained copies of the Claude `telegram`
// plugin, adapted for runtimes that lack Claude's channel-push (codex/grok/agy use
// a wait_for_message MCP loop + a re-arm watchdog). They are SUPPOSED to differ from
// the baseline in known ways, but to move in LOCKSTEP with each other. The recurring
// pain has been silent drift — one fork patched, the others not, and memory going
// stale on what actually shipped (see DIVE-8, DIVE-13).
//
// So this suite asserts three things, all by static-parsing the source (no servers
// booted — the servers long-poll Telegram on import, so importing them is unsafe):
//   1. Each fork matches a GOLDEN spec (command menu + order, access schema, MCP tools,
//      watchdog symbols).
//   2. Cross-fork consistency: codex ≡ grok ≡ agy on commands / access / MCP tools.
//   3. The fork-vs-baseline relationship is exactly the documented delta (forks add
//      wait_for_message; baseline has no watchdog; command menus differ by runtime
//      capability), so an accidental change to that delta trips CI.
//
// When DIVE-14 lands (turn-based liveness ported to agy), flip the `test.todo` at the
// bottom into a real assertion.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PLUGINS = join(import.meta.dir, '..', 'plugins')
const BASELINE = 'telegram'
const FORKS = ['telegram-codex', 'telegram-grok', 'telegram-agy'] as const

function read(plugin: string, file = 'server.ts'): string {
  return readFileSync(join(PLUGINS, plugin, file), 'utf8')
}

// ---- extractors (tolerant static parsers over the well-structured constants) ----

// Forks declare a static `const BOT_COMMANDS = [{ command, description }, ...]`.
function forkCommands(src: string): string[] {
  const block = src.match(/const BOT_COMMANDS[^=]*=\s*\[([\s\S]*?)\n\]/)
  if (!block) return []
  return [...block[1].matchAll(/command:\s*'([^']+)'/g)].map(m => m[1])
}

// Baseline derives its BotFather menu from COMMAND_REGISTRY via botFatherCommands(),
// which drops `hidden` entries. We replicate that filter here. The only single-quoted
// `name:`/`hidden:` literals in commands.ts live in the registry, so parsing the whole
// file is safe (the `name: string` in the CommandDef type has no quotes → no match).
function baselineMenuCommands(): string[] {
  const src = read(BASELINE, 'commands.ts')
  const names = [...src.matchAll(/name:\s*'([^']+)'/g)]
  const out: string[] = []
  for (let i = 0; i < names.length; i++) {
    const start = names[i].index!
    const end = i + 1 < names.length ? names[i + 1].index! : src.length
    if (!/hidden:\s*true/.test(src.slice(start, end))) out.push(names[i][1])
  }
  return out
}

// MCP tools are `{ name: 'x', description: ... }` objects inside the ListTools handler.
// Scope to that handler (up to the CallTool handler) and match name→description pairs,
// which inner inputSchema props never form.
function mcpTools(src: string): string[] {
  // Anchor on the handler, not the import line (both schema symbols are also imported).
  const start = src.indexOf('setRequestHandler(ListToolsRequestSchema')
  if (start < 0) return []
  let block = src.slice(start)
  const end = block.indexOf('setRequestHandler(CallToolRequestSchema')
  if (end > 0) block = block.slice(0, end)
  return [...block.matchAll(/name:\s*'([^']+)',\s*\n\s*description:/g)].map(m => m[1])
}

// The access-config field set. Baseline names the type `Access`; the forks renamed it
// `AccessJson`. Baseline carries extra optional fields (mentionPatterns, delivery/UX) —
// callers that need a strict set check against GOLDEN_ACCESS_FIELDS, not against each other.
function accessFields(src: string): string[] {
  const block = src.match(/type Access(?:Json)?\s*=\s*\{([\s\S]*?)\n\}/)
  if (!block) return []
  return [...block[1].matchAll(/^\s*(\w+)\??:/gm)].map(m => m[1])
}

const has = (src: string, sym: string) => new RegExp(`\\b${sym}\\b`).test(src)

// ---- golden specs (the intended contract) ----

// Ordered — the BotFather menu shows commands in array order.
const GOLDEN_FORK_COMMANDS = [
  'help', 'status', 'stop', 'restart', 'agents', 'tasks', 'task', 'org', 'model', 'ping', 'start',
]
const GOLDEN_FORK_MCP_TOOLS = ['wait_for_message', 'reply', 'edit_message', 'react', 'download_attachment']
const GOLDEN_BASELINE_MCP_TOOLS = ['reply', 'react', 'download_attachment', 'edit_message']
const GOLDEN_ACCESS_FIELDS = ['allowFrom', 'groups', 'pending', 'dmPolicy']
// Baseline menu (non-hidden registry commands, in order) — drift here signals the forks
// may need a new command or a description sync.
const GOLDEN_BASELINE_MENU = [
  'help', 'status', 'context', 'stop', 'restart', 'clear', 'checkpoint', 'resume',
  'agents', 'tasks', 'task', 'org', 'update', 'model', 'account', 'goal',
]
const WATCHDOG_COMMON = ['startRearmWatchdog', 'REARM_IDLE_MS', 'markActivity', 'lastServerActivity']
const TURN_LIVENESS = 'newestTurnMtimeMs' // codex+grok; agy pending DIVE-14

const sorted = (a: string[]) => [...a].sort()

// ---- per-fork: matches the golden spec ----

describe.each(FORKS)('%s matches golden fork spec', plugin => {
  const src = read(plugin)

  test('command menu set + ordering', () => {
    expect(forkCommands(src)).toEqual(GOLDEN_FORK_COMMANDS)
  })

  test('registers commands for BOTH default + all_private_chats scopes', () => {
    // The recycled-token shadow-menu fix loops setMyCommands over [undefined, all_private_chats].
    expect(src).toMatch(/for\s*\(const scope of \[\s*undefined,\s*\{\s*type:\s*'all_private_chats'/)
  })

  test('access.json schema (allowFrom/groups/dmPolicy/pending)', () => {
    // Core 4 must be present; forks also share extras (ackReaction, textChunkLimit, …)
    // which the cross-fork test pins to an identical set.
    const fields = accessFields(src)
    for (const f of GOLDEN_ACCESS_FIELDS) expect(fields).toContain(f)
  })

  test('MCP tool set', () => {
    expect(sorted(mcpTools(src))).toEqual(sorted(GOLDEN_FORK_MCP_TOOLS))
  })

  test('re-arm watchdog present', () => {
    for (const sym of WATCHDOG_COMMON) expect(has(src, sym)).toBe(true)
  })
})

// ---- cross-fork consistency: the forks must not drift apart ----

describe('cross-fork consistency', () => {
  const byFork = Object.fromEntries(FORKS.map(f => [f, read(f)]))

  test('identical command menu (set + order)', () => {
    const lists = FORKS.map(f => forkCommands(byFork[f]))
    for (const l of lists) expect(l).toEqual(lists[0])
  })

  test('identical access schema', () => {
    const sets = FORKS.map(f => sorted(accessFields(byFork[f])))
    for (const s of sets) expect(s).toEqual(sets[0])
  })

  test('identical MCP tool set', () => {
    const sets = FORKS.map(f => sorted(mcpTools(byFork[f])))
    for (const s of sets) expect(s).toEqual(sets[0])
  })

  test('all forks carry the common watchdog symbols', () => {
    for (const f of FORKS) for (const sym of WATCHDOG_COMMON) expect(has(byFork[f], sym)).toBe(true)
  })
})

// ---- fork-vs-baseline relationship: the delta is exactly what we intend ----

describe('fork vs Claude baseline delta', () => {
  const baseSrc = read(BASELINE)

  test('baseline menu is unchanged (forks may need to track new commands)', () => {
    expect(baselineMenuCommands()).toEqual(GOLDEN_BASELINE_MENU)
  })

  test('baseline MCP tools = fork tools minus wait_for_message', () => {
    expect(sorted(mcpTools(baseSrc))).toEqual(sorted(GOLDEN_BASELINE_MCP_TOOLS))
    expect(sorted(GOLDEN_FORK_MCP_TOOLS.filter(t => t !== 'wait_for_message')))
      .toEqual(sorted(GOLDEN_BASELINE_MCP_TOOLS))
  })

  test('forks carry the baseline core access fields (baseline may have extras)', () => {
    // Baseline `Access` is a superset (mentionPatterns, delivery/UX). The forks must at
    // least carry the core 4; this asserts they didn't invent a field baseline lacks.
    const base = accessFields(baseSrc)
    for (const f of GOLDEN_ACCESS_FIELDS) expect(base).toContain(f)
  })

  test('baseline has no re-arm watchdog (channel-push, not wait_for_message)', () => {
    expect(has(baseSrc, 'startRearmWatchdog')).toBe(false)
  })
})

// ---- /restart redelivery-loop regression (DIVE-13) ----
//
// A /restart sitting unacked at the head of getUpdates would be redelivered after the
// agent respawned → infinite self-restart loop. The fix: restartAgent acks the
// triggering update (getUpdates offset = id+1) BEFORE respawning, and the callers must
// actually pass the update id (codex once had the ack logic but dead callers).

describe.each(FORKS)('%s: /restart acks before respawn (DIVE-13)', plugin => {
  const src = read(plugin)

  test('restartAgent takes an ack update id and advances the offset before restarting', () => {
    expect(src).toMatch(/function restartAgent\([^)]*ackUpdateId\??:\s*number/)
    expect(src).toMatch(/getUpdates\(\{\s*offset:\s*ackUpdateId\s*\+\s*1/)
  })

  test('the /restart caller actually passes the update id (not dead code)', () => {
    expect(src).toMatch(/restartAgent\([^)]*\bupdateId\b/)
  })
})

// ---- turn-based liveness (DIVE-15 / DIVE-14) ----

describe('turn-based re-arm liveness', () => {
  // All three forks must base idle on the most recent real agent turn, not just the
  // last Telegram-MCP call, or a heads-down agent gets false-kicked out of its task
  // (the 5dive-exact-swallow bug). agy got this in DIVE-14 (reads ~/.gemini conversations).
  test.each(FORKS)('%s bases idle on real turn mtime (newestTurnMtimeMs)', plugin => {
    expect(has(read(plugin), TURN_LIVENESS)).toBe(true)
  })
})
