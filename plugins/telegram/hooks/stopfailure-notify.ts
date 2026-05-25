#!/usr/bin/env -S bun
// StopFailure hook: relay failure info to Telegram. For rate-limit failures,
// fork the resume-after-reset helper which owns the full recovery flow
// (auto-press "1" on the menu, wait for reset, type "continue", ping). The
// hook itself stays short — well under its 10s timeout — because all the
// slow parts (menu polling, long wait) live in the detached helper.
//
// Auto-registered via the plugin manifest (hooks/hooks.json). Reads
// TELEGRAM_BOT_TOKEN from the inherited env (set by whatever launched
// claude: a 5dive-agent systemd unit, a claude-always-on user unit /
// launchd plist, an interactive shell that sourced
// ~/.claude/channels/telegram/.env, etc).

import { spawn } from 'child_process'
import { existsSync, mkdirSync, openSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { readPayload } from './lib/payload'
import { readEntries, findRateLimitText } from './lib/transcript'
import { getAllowedChatIds, getCallerChatId } from './lib/access'
import { sendMessage } from './lib/telegram'
import { capturePane, getTmuxContext } from './lib/tmux'
import { parseResetEpoch } from './lib/time'
import type { HookPayload } from './lib/types'

const payload = await readPayload<HookPayload>()
const msg = [payload.message, payload.reason, typeof payload.error === 'string' ? payload.error : undefined, payload.stopReason]
  .filter(Boolean)
  .join(' | ') || 'no details'

const raw = JSON.stringify(payload)
const isRateLimit = /rate_limit|usage.limit/i.test(raw)

const transcriptPath = payload.transcript_path
const entries = transcriptPath ? readEntries(transcriptPath) : []

// Capture the pane up front. Two uses:
//   1. Scrape "API Error: 529 ..." for non-rate-limit failures (payload only
//      carries the high-level reason; the API status line appears only in
//      claude's pane output).
//   2. Last-resort fallback for the rate-limit reset time.
//
// Not the primary source for rate-limit timing: when claude shows the
// "Stop and wait" menu, the pane switches to the alternate screen and
// the preceding "resets Xpm (TZ)" line disappears from `tmux capture-pane`.
// The transcript captures that line as a structured synthetic message
// (error="rate_limit", isApiErrorMessage=true) and is immune.
const pane = capturePane()

// Resolve an unlock/reset epoch. Order: payload → transcript → message text → pane.
let resetEpoch: number | null = null

const resetRaw =
  (payload.resetsAt as number | string | undefined) ??
  (payload.reset_at as number | string | undefined) ??
  (payload.resetAt as number | string | undefined) ??
  (typeof payload.error === 'object' && payload.error?.resetsAt) ??
  payload.rateLimit?.resetsAt

if (resetRaw !== undefined && resetRaw !== null) {
  resetEpoch = parseResetEpoch(String(resetRaw))
}

if (resetEpoch === null) {
  const transcriptResetText = findRateLimitText(entries)
  if (transcriptResetText) resetEpoch = parseResetEpoch(transcriptResetText)
}

if (resetEpoch === null) {
  resetEpoch = parseResetEpoch(msg)
}

if (resetEpoch === null && pane) {
  const line = pane.split('\n').find(l => /resets?\s+\d/i.test(l))
  if (line) resetEpoch = parseResetEpoch(line)
}

// Time-left string for the DM.
let timeLeft = ''
if (resetEpoch !== null) {
  const delta = resetEpoch - Math.floor(Date.now() / 1000)
  if (delta <= 0) timeLeft = 'any moment now'
  else if (delta < 60) timeLeft = `${delta}s`
  else if (delta < 3600) timeLeft = `${Math.floor(delta / 60)}m`
  else {
    const h = Math.floor(delta / 3600)
    const m = Math.floor((delta % 3600) / 60)
    timeLeft = m === 0 ? `${h}h` : `${h}h ${m}m`
  }
}

const tmuxCtx = getTmuxContext()

// Build the DM text. Advertise auto-resume only when BOTH reset epoch AND
// tmux context are present — that's when the resume fork below will run.
let text: string
if (isRateLimit) {
  if (timeLeft && tmuxCtx) {
    text = `Usage limit hit — resumes in ${timeLeft}. Will auto-press the menu and type 'continue' when the limit lifts.`
  } else if (timeLeft) {
    text = `Usage limit hit — resumes in ${timeLeft}.`
  } else {
    text = 'Usage limit hit — waiting for reset.'
  }
} else {
  text = `The agent stopped with an error: ${msg}`
  if (pane) {
    const apiErr = pane.match(/API Error:\s+\d+[^.-]*/g)?.pop()
    if (apiErr) text += `\n${apiErr}`
  }
}

// Caller-only narrowing: prefer the inbound chat over fanning to all
// paired chats. Falls back to all chats for autonomous turns so we don't
// silence the alert entirely.
let chatIds: string[]
const callerChat = getCallerChatId(entries)
if (callerChat) chatIds = [callerChat]
else chatIds = getAllowedChatIds()

await Promise.all(chatIds.map(cid => sendMessage(cid, text)))

// Detach the recovery helper for rate-limit failures. Skipped if we don't
// have tmux context (can't press anything) or a reset epoch (don't know
// when to resume) — DM above already covered the user, just no auto-resume.
if (isRateLimit && resetEpoch !== null && tmuxCtx) {
  const resumeHelper = join(import.meta.dir, 'resume-after-reset.ts')
  if (existsSync(resumeHelper)) {
    // Log dir: ~/.cache/5dive-telegram/resume/ is the agent-writable default.
    // Fall back to /tmp if even that fails (HOME unset, full disk).
    let logDir = join(homedir(), '.cache', '5dive-telegram', 'resume')
    try {
      mkdirSync(logDir, { recursive: true })
    } catch {
      logDir = '/tmp'
    }
    const logFile = join(logDir, `resume-${Math.floor(Date.now() / 1000)}-${process.pid}.log`)
    const out = openSync(logFile, 'a')
    const child = spawn(
      'bun',
      [resumeHelper, String(resetEpoch), tmuxCtx.socket, tmuxCtx.target, chatIds.join(',')],
      {
        detached: true,
        stdio: ['ignore', out, out],
        env: process.env,
      },
    )
    child.unref()
  }
}

process.exit(0)
