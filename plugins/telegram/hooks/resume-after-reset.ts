#!/usr/bin/env -S bun
// Spawned detached by stopfailure-notify.ts as soon as it detects a usage
// limit. Owns the full rate-limit recovery flow:
//
//   Phase 1 (auto-press): poll the tmux pane for claude's "1. Stop and
//     wait" menu, send "1" + Enter when it appears. Polls up to ~60s —
//     long enough for the menu to render in practice but bounded so a
//     stuck pane doesn't hold the process forever. Skipped silently if
//     the menu never appears (e.g. user pressed it themselves, or claude
//     exited instead of parking).
//
//   Phase 2 (wait): sleep until reset_epoch + 30s buffer.
//
//   Phase 3 (resume): type "continue" + Enter into the originating tmux
//     pane so claude picks up the conversation. If claude already exited,
//     the keystrokes hit a shell — "continue" is a no-op there, harmless.
//
//   Phase 4 (ping): tell the paired Telegram chats the agent is back.
//
// Argv: <reset_epoch> <tmux_socket> <tmux_target> <chat_ids_csv>
// Env:  TELEGRAM_BOT_TOKEN (required for the notification)
//
// Why this lives outside the StopFailure hook: the hook has timeout=10s but
// menu rendering can lag several seconds and the wait phase is up to 5h.
// stopfailure-notify spawns this detached so it runs free of the hook
// timeout and free of the agent's tmux session lifecycle.

import { setTimeout as sleep } from 'timers/promises'
import { capturePaneFor, sendKeys } from './lib/tmux'
import { sendMessage } from './lib/telegram'

const resetEpoch = parseInt(process.argv[2] ?? '0', 10) || 0
const socket = process.argv[3] ?? ''
const target = process.argv[4] ?? ''
const chatIdsCsv = process.argv[5] ?? ''

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

log(`resume-after-reset start: reset_epoch=${resetEpoch} socket=${socket} target=${target}`)

const ctx = socket && target ? { socket, target } : null

// Phase 1 — poll-and-press. Same regex as the bash predecessor (matches
// "1. Stop and wait" anywhere in the pane). Up to 60 attempts at 1s.
let pressed = false
if (ctx) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const pane = capturePaneFor(ctx)
    if (/1\.\s*Stop and wait/i.test(pane)) {
      sendKeys(ctx, '1', 'Enter')
      pressed = true
      log(`phase1 pressed '1' on attempt ${attempt}`)
      break
    }
    await sleep(1000)
  }
  if (!pressed) log('phase1 menu never appeared after 60s — proceeding to wait anyway')
}

// Phase 2 — sleep until reset + 30s buffer. Clamp to >=30s so a stale
// epoch never makes us skip the wait entirely.
if (resetEpoch > 0) {
  const now = Math.floor(Date.now() / 1000)
  let delay = resetEpoch - now + 30
  if (delay < 30) delay = 30
  log(`phase2 sleeping ${delay}s until reset`)
  await sleep(delay * 1000)
}

// Phase 3 — resume claude. send-keys is a no-op if the pane has gone away.
if (ctx) {
  sendKeys(ctx, 'continue', 'Enter')
  log(`phase3 sent 'continue' to ${target}`)
}

// Phase 4 — Telegram ping. Multiple chats supported (DM + group).
if (process.env.TELEGRAM_BOT_TOKEN && chatIdsCsv) {
  const cids = chatIdsCsv.split(',').filter(Boolean)
  await Promise.all(cids.map(c => sendMessage(c, 'Usage limit reset — agent resumed.')))
  log('phase4 telegram pings sent')
}

process.exit(0)
