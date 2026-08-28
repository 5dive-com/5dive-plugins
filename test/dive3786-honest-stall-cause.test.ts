// DIVE-3786 — the stall alert must not name a mechanism it never tested, and
// the re-arm kick must observe its own submit.
//
// Two shipped defects, both customer-visible on every codex/grok/antigravity
// box:
//
//   1. detectStallCause() tested exactly two pane patterns and reported
//      everything else as "listen loop wedged / agent is idle outside
//      wait_for_message and won't re-arm". It reads neither the listen loop nor
//      wait_for_message nor the re-arm state — the string was the else-branch,
//      shown to a paying customer as a diagnosis.
//   2. kickListenLoop() typed with `send-keys -l` (which APPENDS to whatever is
//      already in the composer) and then fired Enter with its result discarded.
//      A dropped Enter therefore stranded text in the composer, and every later
//      kick concatenated onto it — the recovery path breaking itself, which is
//      why the customer saw the alert constantly.
//
// Static, like rearm-loop-regression.test.ts: importing a server long-polls
// Telegram. These guards fail if a regeneration or later edit restores either
// shape.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PLUGINS = join(import.meta.dir, '..', 'plugins')
const FORKS = ['telegram-codex', 'telegram-grok', 'telegram-agy'] as const

const src = (fork: string) => readFileSync(join(PLUGINS, fork, 'server.ts'), 'utf8')

describe.each(FORKS)('%s stall reporting', (fork) => {
  test('never reports "listen loop wedged" — it was the unmatched-pattern branch', () => {
    expect(src(fork)).not.toMatch(/listen loop wedged/i)
  })

  test('never claims the agent is outside wait_for_message from a pane scrape', () => {
    // The pane capture cannot see wait_for_message state at all.
    const detect = src(fork).split('function detectStallCause')[1]?.split('\nfunction ')[0] ?? ''
    expect(detect).not.toMatch(/wait_for_message/)
  })

  test('the unmatched branch admits ignorance and shows the pane instead', () => {
    const s = src(fork)
    expect(s).toMatch(/cause: 'not responding — cause unknown', detail: paneTailSummary\(tail\)/)
    expect(s).toMatch(/function paneTailSummary/)
  })

  test('the one wedged cause it does name is one it measured', () => {
    // rearmSubmitFailed is set only after kickListenLoop typed a prompt and
    // could not observe the submit landing — an observation, not an inference.
    const s = src(fork)
    expect(s).toMatch(/if \(rearmSubmitFailed\) \{/)
    expect(s).toMatch(/cause: 'stuck at the input prompt'/)
  })

  test('keeps the pane that triggered the alert on the box', () => {
    const s = src(fork)
    expect(s).toMatch(/LAST_STALL_PANE_FILE/)
    expect(s).toMatch(/writeFileSync\(LAST_STALL_PANE_FILE/)
  })
})

describe.each(FORKS)('%s re-arm kick', (fork) => {
  const kick = (fork: string) => {
    const s = src(fork)
    const i = s.indexOf('async function kickListenLoopOnce')
    expect(i).toBeGreaterThan(-1)
    return s.slice(i, s.indexOf('\n// ', s.indexOf('function kickListenLoop(): void')))
  }

  test('clears the composer before typing, because send-keys -l appends', () => {
    const k = kick(fork)
    const clear = k.indexOf("'C-u'")
    const type = k.indexOf('REARM_KICK_TEXT')
    expect(clear).toBeGreaterThan(-1)
    expect(type).toBeGreaterThan(clear)
  })

  test('submits in its own send-keys call, after the literal text', () => {
    const k = kick(fork)
    expect(k.indexOf("'Enter'")).toBeGreaterThan(k.indexOf('REARM_KICK_TEXT'))
  })

  test('verifies the submit landed instead of discarding the result', () => {
    const k = kick(fork)
    // A landed Enter clears the composer and starts a turn, so the pane changes.
    expect(k).toMatch(/return after !== typed/)
    // The old code ended the Enter call with an empty callback `() => {}`.
    expect(k).not.toMatch(/'Enter'\][^\n]*\(\) => \{\}/)
  })

  test('retries once, then stops claiming success', () => {
    const s = src(fork)
    const k = s.slice(s.indexOf('function kickListenLoop(): void'))
    expect(k).toMatch(/retrying once/)
    expect(k).toMatch(/rearmSubmitFailed = true/)
  })
})
