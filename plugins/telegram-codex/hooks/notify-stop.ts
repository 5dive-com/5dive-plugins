#!/usr/bin/env bun
/**
 * Codex `Stop` hook — pings every allowFrom user via the Telegram bot
 * when codex finishes a turn (returns control to the user).
 *
 * Wire from ~/.codex/config.toml:
 *
 *   [features]
 *   hooks = true
 *
 *   [[hooks.Stop]]
 *   [[hooks.Stop.hooks]]
 *   type = "command"
 *   command = "bun /abs/path/to/telegram-codex/hooks/notify-stop.ts"
 *   async = true
 *
 * Reads token + recipients from the same state dir as server.ts:
 *   ~/.codex/channels/telegram/{.env, access.json}
 *
 * Override the ping text per session by setting CODEX_NOTIFY_TEXT in env.
 * Skip the ping entirely with CODEX_NOTIFY_DISABLED=1 (useful when the user
 * is already talking to the bot — the wait_for_message/reply loop already
 * tells them it's done, the Stop ping would be duplicate).
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

if (process.env.CODEX_NOTIFY_DISABLED === '1') process.exit(0)

const STATE_DIR = process.env.TELEGRAM_STATE_DIR
  ?? join(homedir(), '.codex', 'channels', 'telegram')
const LAST_REPLY_FILE = join(STATE_DIR, 'last-reply.stamp')
const LAST_INBOUND_FILE = join(STATE_DIR, 'last-inbound.stamp')

// Only ping when the just-finished turn left a real inbound unanswered.
// server.ts stamps last-inbound.stamp whenever wait_for_message hands the agent
// a real message, and last-reply.stamp whenever it replies. If the agent already
// replied to the latest inbound (lastReply >= lastInbound) the user saw the
// answer; if no inbound arrived at all, the turn was just an idle
// wait_for_message loop iteration. Either way a "turn complete" ping is noise —
// only the genuine "did work but didn't reply" case (lastInbound > lastReply)
// is worth a nudge.
let lastReply = 0
let lastInbound = 0
try { lastReply = Number(readFileSync(LAST_REPLY_FILE, 'utf8')) || 0 } catch {}
try { lastInbound = Number(readFileSync(LAST_INBOUND_FILE, 'utf8')) || 0 } catch {}
if (lastReply >= lastInbound) process.exit(0)

try {
  for (const line of readFileSync(join(STATE_DIR, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) process.exit(0)

let access: { allowFrom?: string[] } = {}
try {
  access = JSON.parse(readFileSync(join(STATE_DIR, 'access.json'), 'utf8'))
} catch { process.exit(0) }

const recipients = access.allowFrom ?? []
if (recipients.length === 0) process.exit(0)

const text = process.env.CODEX_NOTIFY_TEXT ?? '🟢 codex: turn complete'

await Promise.all(recipients.map(chat_id =>
  fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id, text }),
  }).catch(() => {})
))
