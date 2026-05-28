#!/usr/bin/env bun
/**
 * Grok `PreToolUse` hook — pings the user if Grok has been working
 * silently for too long.
 *
 * Wired by the plugin's hooks/hooks.json (PreToolUse event, no matcher =
 * every tool). Fires once per tool call. We:
 *   - read last-reply.stamp (epoch ms) — touched on every successful
 *     `reply` and also by this hook when it pings, so a single ping
 *     resets the clock
 *   - if (now - stamp) > effective threshold, send a quiet "⏳ still
 *     working…" ping to every allowFrom user, then touch the stamp so
 *     we don't ping again immediately
 *
 * Backoff: the first ping in a silence stretch trips at the base
 * GROK_SILENCE_WATCHDOG_MS. Each subsequent ping in the SAME stretch
 * needs much more additional silence — base × 10 for the 2nd, base × 15
 * (cap) for the 3rd+. A real user-visible `reply` resets the count to 0.
 * Goal: tell the user "still alive" once, early; then stay out of the
 * way unless the silence drags on dramatically.
 *
 * Knobs:
 *   - GROK_SILENCE_WATCHDOG_DISABLED=1  → bypass entirely
 *   - GROK_SILENCE_WATCHDOG_MS=N        → BASE threshold in ms (default 600000 = 10 min)
 *
 * Always returns {"decision":"allow"} — silence-watchdog is a notification,
 * never a gate. A bad ping must never block tool execution.
 */

import { readFileSync, writeFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

function exitContinue(): never {
  process.stdout.write(JSON.stringify({ decision: 'allow' }))
  process.exit(0)
}

if (process.env.GROK_SILENCE_WATCHDOG_DISABLED === '1') exitContinue()

const STATE_DIR = process.env.TELEGRAM_STATE_DIR
  ?? join(process.env.GROK_HOME ?? join(homedir(), '.grok'), 'channels', 'telegram')
const LAST_REPLY_FILE = join(STATE_DIR, 'last-reply.stamp')
const TOOL_COUNT_FILE = join(STATE_DIR, 'silence-tool-count')
const PING_COUNT_FILE = join(STATE_DIR, 'silence-ping-count')

const BASE_MS = Math.max(10_000, Math.min(3_600_000,
  Number(process.env.GROK_SILENCE_WATCHDOG_MS ?? 600_000)))

// Track tool calls + pings issued since last user-visible reply. The
// tool-count counter feeds the reset-on-reply logic below; the ping
// counter drives backoff so we don't spam the user every BASE seconds
// during a long silent stretch.
let toolCount = 0
let pingCount = 0
let lastReplyTs = 0
try { lastReplyTs = Number(readFileSync(LAST_REPLY_FILE, 'utf8')) || 0 } catch {}
try { toolCount = Number(readFileSync(TOOL_COUNT_FILE, 'utf8')) || 0 } catch {}
try { pingCount = Number(readFileSync(PING_COUNT_FILE, 'utf8')) || 0 } catch {}

// If the stamp moved forward since our last tool count snapshot, the
// agent replied — reset both counters and exit.
let countStamp = 0
try { countStamp = statSync(TOOL_COUNT_FILE).mtimeMs || 0 } catch {}
if (lastReplyTs > countStamp) {
  try { writeFileSync(TOOL_COUNT_FILE, '0') } catch {}
  try { writeFileSync(PING_COUNT_FILE, '0') } catch {}
  exitContinue()
}

toolCount += 1
try { writeFileSync(TOOL_COUNT_FILE, String(toolCount)) } catch {}

// Backoff multiplier: 1× base for the first ping per stretch, 10× for
// the second, 15× (cap) for the third and beyond. So with the default
// 120s base: ~2min, then +20min, then +30min, then +30min…
const multiplier = pingCount === 0 ? 1 : Math.min(5 * (1 + pingCount), 15)
const thresholdMs = BASE_MS * multiplier

const elapsed = Date.now() - (lastReplyTs || Date.now())
if (lastReplyTs === 0 || elapsed < thresholdMs) exitContinue()

// Threshold tripped. Load access + token to send a ping.
try {
  for (const line of readFileSync(join(STATE_DIR, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) exitContinue()

let access: { allowFrom?: string[] } = {}
try { access = JSON.parse(readFileSync(join(STATE_DIR, 'access.json'), 'utf8')) } catch {}
const recipients = access.allowFrom ?? []
if (recipients.length === 0) exitContinue()

const text = `⏳ still working…`

await Promise.all(recipients.map(chat_id =>
  fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id, text }),
  }).catch(() => {})
))

// Reset the silence-clock so we don't re-ping immediately, plus the
// tool-count snapshot. Bump the ping-count so the next ping in this
// stretch needs much more silence (backoff).
try { writeFileSync(LAST_REPLY_FILE, String(Date.now())) } catch {}
try { writeFileSync(TOOL_COUNT_FILE, '0') } catch {}
try { writeFileSync(PING_COUNT_FILE, String(pingCount + 1)) } catch {}

exitContinue()
