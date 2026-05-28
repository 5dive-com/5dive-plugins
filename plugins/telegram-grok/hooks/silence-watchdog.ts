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
 *   - if (now - stamp) > GROK_SILENCE_WATCHDOG_MS (default 120s),
 *     send a quiet "⏳ still working…" ping to every allowFrom user,
 *     then touch the stamp so we don't ping again immediately
 *
 * Knobs:
 *   - GROK_SILENCE_WATCHDOG_DISABLED=1  → bypass entirely
 *   - GROK_SILENCE_WATCHDOG_MS=N        → threshold in ms (default 120000)
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

const THRESHOLD_MS = Math.max(10_000, Math.min(3_600_000,
  Number(process.env.GROK_SILENCE_WATCHDOG_MS ?? 120_000)))

// Track tool calls since last user-visible reply. We still keep the
// counter for the reset logic below — but we no longer include it in
// the user-facing text. The telemetry-style "N tool calls in, Xs since
// last reply" line read like debug output; a quiet "still working…"
// carries the same signal without the noise.
let toolCount = 0
let lastReplyTs = 0
try { lastReplyTs = Number(readFileSync(LAST_REPLY_FILE, 'utf8')) || 0 } catch {}
try { toolCount = Number(readFileSync(TOOL_COUNT_FILE, 'utf8')) || 0 } catch {}

// If the stamp moved forward since our last tool count snapshot, the
// agent replied — reset the counter and exit.
let countStamp = 0
try { countStamp = statSync(TOOL_COUNT_FILE).mtimeMs || 0 } catch {}
if (lastReplyTs > countStamp) {
  try { writeFileSync(TOOL_COUNT_FILE, '0') } catch {}
  exitContinue()
}

toolCount += 1
try { writeFileSync(TOOL_COUNT_FILE, String(toolCount)) } catch {}

const elapsed = Date.now() - (lastReplyTs || Date.now())
if (lastReplyTs === 0 || elapsed < THRESHOLD_MS) exitContinue()

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
// counter so the tool-count snapshot stays in sync with this ping.
try { writeFileSync(LAST_REPLY_FILE, String(Date.now())) } catch {}
try { writeFileSync(TOOL_COUNT_FILE, '0') } catch {}

exitContinue()
