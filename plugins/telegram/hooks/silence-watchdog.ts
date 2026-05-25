#!/usr/bin/env -S bun
// PostToolUse hook: nudge the agent when it's gone quiet on Telegram.
//
// Why: agents paired over Telegram sometimes go silent for minutes while
// they crunch through tool calls. CLAUDE.md and the notify-user skill both
// say "ack within 30s, edit your last message every ~30s", but Claude
// reads those at session start and ignores them mid-task once it's deep
// in work. This hook is the forcing function — it injects a fresh
// <system-reminder> into the next tool result after the silence threshold
// is crossed, so the model sees it in the live context window instead of
// having to recall a session-load directive.
//
// Triggers (PostToolUse, after every tool call) when ALL of:
//   - access.json has at least one allowFrom entry (paired)
//   - silence.json shows recent TG activity (inbound within last hour)
//   - EITHER (now - lastReplyAt > 90s) OR (toolCallsSinceReply >= 5)
//
// Re-firing policy (avoids one-shot fatigue without spamming):
//   - First time after a reply: fire immediately when threshold crossed
//   - After first fire: re-fire only on multiples of 5 calls OR every 60s

import { readPayload } from './lib/payload'
import { loadAccess } from './lib/access'
import { loadSilence, saveSilence } from './lib/state'
import { emitPostToolContext } from './lib/output'

// Drain stdin so claude's pipe doesn't hang. We don't need the payload.
await readPayload()

const access = loadAccess()
if (!access.allowFrom || access.allowFrom.length === 0) process.exit(0)

const now = Math.floor(Date.now() / 1000)
const state = loadSilence()
const lastInbound = state.lastInboundAt ?? 0
const lastReply = state.lastReplyAt ?? 0
const lastReminder = state.lastReminderAt ?? 0
// Bump counter unconditionally; we still want it accurate even if the
// session isn't currently in a TG conversation (a fresh inbound later
// should see real numbers, not zero).
const calls = (state.toolCallsSinceReply ?? 0) + 1

// Race window between server.ts reset and this hook's increment is benign:
// the counter ends up at 1 after a reply (instead of 0), so the threshold
// fires after 4 more tool calls — close enough for a heuristic.

const inConversation = lastInbound > 0 && now - lastInbound <= 3600

let sinceReply = 0
if (lastReply > 0) {
  sinceReply = now - lastReply
} else if (lastInbound > 0) {
  // Never replied to this TG thread — measure silence from inbound.
  sinceReply = now - lastInbound
}

let shouldFire = false
if (inConversation) {
  const crossedCount = calls >= 5
  const crossedTime = sinceReply > 90
  if (crossedCount || crossedTime) {
    if (lastReminder === 0 || lastReminder < lastReply || lastReminder < lastInbound) {
      // First time crossing the threshold since the last reply/inbound.
      shouldFire = true
    } else if (calls >= 5 && calls % 5 === 0) {
      shouldFire = true
    } else if (now - lastReminder >= 60) {
      shouldFire = true
    }
  }
}

saveSilence({
  lastInboundAt: lastInbound,
  lastReplyAt: lastReply,
  lastReminderAt: shouldFire ? now : lastReminder,
  toolCallsSinceReply: calls,
})

if (shouldFire) {
  emitPostToolContext(
    `You've gone ${sinceReply}s and ${calls} tool calls without sending a Telegram message. The user alarms at >60s silence — edit your last reply (mcp__plugin_telegram_telegram__edit_message) with a one-line status now, or send a fresh reply if a new inbound landed. Don't go silent.`,
  )
}
process.exit(0)
