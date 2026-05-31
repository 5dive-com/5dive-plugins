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
import { existsSync, mkdirSync, openSync, writeSync, closeSync, statSync, unlinkSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { readPayload } from './lib/payload'
import { readEntries, findRateLimitText } from './lib/transcript'
import { getAllowedChatIds, getGroupTopics, getCallerChat, type CallerChat } from './lib/access'
import { sendMessage } from './lib/telegram'
import { capturePane, getTmuxContext } from './lib/tmux'
import { parseResetEpoch } from './lib/time'
import type { HookPayload } from './lib/types'

const payload = await readPayload<HookPayload>()
const msg = [payload.message, payload.reason, typeof payload.error === 'string' ? payload.error : undefined, payload.stopReason]
  .filter(Boolean)
  .join(' | ') || 'no details'

const raw = JSON.stringify(payload)

// A transient server-side 429 ("Server is temporarily limiting requests · Rate
// limited") is explicitly NOT a usage limit — but its text literally contains
// the substring "usage limit" (in the phrase "not your usage limit"), so the
// naive usage-limit regex below matches it and we'd report a bogus "usage limit
// hit — couldn't read the reset time" (there's no reset epoch on a transient
// throttle). Detect the transient phrasing first and exclude it from the
// usage-limit branch; it's routed to the transient-API-error recovery instead.
const isTransientRateLimit = /not your usage limit|temporarily limiting requests/i.test(raw)
const isRateLimit = !isTransientRateLimit && /rate_limit|usage.limit/i.test(raw)

const transcriptPath = payload.transcript_path
let entries = transcriptPath ? readEntries(transcriptPath) : []

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

// Transient API error (NOT a usage limit): claude exhausted its built-in
// retries on an Overloaded / 5xx response, aborted the turn, and dropped back
// to an idle prompt — no "Stop and wait" menu, no reset epoch. The
// `while true; claude; done` agent loop only restarts on process *exit*, so an
// aborted-turn-but-still-running claude just sits there until a human nudges
// it. We detect it here and fork resume-after-error.ts to type "continue" with
// backoff. Match the API status line in the pane ("API Error: Overloaded",
// "API Error: 529 …") and the raw payload ("overloaded_error" etc).
const transientHaystack = `${raw}\n${pane}`
const isTransientApiError =
  !isRateLimit &&
  (isTransientRateLimit ||
    /overloaded|API Error:\s*(?:5(?:0[234]|29))\b|"type":\s*"(?:overloaded|api)_error"/i.test(transientHaystack))

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

if (resetEpoch === null && transcriptPath) {
  // The synthetic rate-limit entry is written ~concurrently with this hook
  // firing, so the first read can miss it (flush race). findRateLimitText is
  // bounded to recent entries, so a miss returns null rather than silently
  // reusing a stale earlier-episode reset line — which means we can safely
  // retry: re-read the transcript a few times over ~2s to catch the write.
  // Well within the hook's 10s budget; the slow recovery lives in the detached
  // helper, not here. Non-rate-limit failures don't retry (no extra latency).
  const tries = isRateLimit ? 5 : 1
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 500))
      entries = readEntries(transcriptPath)
    }
    const transcriptResetText = findRateLimitText(entries)
    if (transcriptResetText) {
      const e = parseResetEpoch(transcriptResetText)
      if (e !== null) {
        resetEpoch = e
        break
      }
    }
  }
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
  } else if (tmuxCtx) {
    // Couldn't read a reset time, but we still have a pane to drive — the
    // helper below polls and resumes on its own, so this is NOT a dead end.
    text = `Usage limit hit — couldn't read the reset time. I'll keep retrying and resume automatically once it lifts.`
  } else if (timeLeft) {
    text = `Usage limit hit — resumes in ${timeLeft}.`
  } else {
    text = 'Usage limit hit — waiting for reset.'
  }
} else if (isTransientApiError) {
  // Transient server-side blip — an Overloaded/5xx, or a 429 "temporarily
  // limiting requests" that's explicitly NOT a usage limit. It self-clears on
  // retry, so lead with the reassuring framing (not "stopped with an error")
  // and surface the underlying API line. The resume-after-error helper drives
  // 'continue' with backoff when we have a pane to type into.
  const apiLine = pane?.split('\n').map(l => l.trim()).find(l => /^API Error:/i.test(l))
  const detail = apiLine ?? msg
  const recovery = tmuxCtx ? "Auto-retrying 'continue' with backoff." : 'Will resume on the next turn.'
  text = `Transient API throttle/overload — NOT a usage limit. ${recovery}\n${detail}`
} else {
  text = `The agent stopped with an error: ${msg}`
  if (pane) {
    const apiErr = pane.match(/API Error:\s+(?:\d+|Overloaded)[^.-]*/gi)?.pop()
    if (apiErr) text += `\n${apiErr}`
  }
}

// Caller-only narrowing: prefer the inbound chat (and its forum topic) the
// user actually wrote from. On an autonomous turn (no telegram inbound in the
// transcript — cron-triggered, long-running background agent, etc) fall back
// to the agent's bound group topic(s) so the alert lands in its own thread
// instead of buzzing every paired DM + the group's General channel. Only when
// no group is configured at all do we fan to all allowed chats — better a
// noisy alert than a silenced one.
let targets: CallerChat[]
const callerChat = getCallerChat(entries)
if (callerChat) {
  targets = [callerChat]
} else {
  const topics = getGroupTopics()
  targets = topics.length ? topics : getAllowedChatIds().map(chatId => ({ chatId }))
}

// For a recoverable rate limit (we have a pane to drive), claim the per-agent
// resume lock BEFORE notifying. If it's already held, a helper is mid-recovery
// and this StopFailure is just the poll loop's "continue" bouncing off the
// still-active limit — stay silent (no duplicate DM, no second helper) and let
// the running helper see it through. The lock dir doubles as the helper's log
// dir. The lock auto-expires (mtime TTL) so a crashed helper can't wedge
// recovery forever.
//
// The same lock serializes BOTH recovery flows (usage-limit and transient
// API error) — only one helper should drive the pane at a time.
const needsRecovery = (isRateLimit || isTransientApiError) && !!tmuxCtx
let lockPath: string | null = null
let resumeLogDir = ''
if (needsRecovery) {
  resumeLogDir = join(homedir(), '.cache', '5dive-telegram', 'resume')
  try {
    mkdirSync(resumeLogDir, { recursive: true })
  } catch {
    resumeLogDir = '/tmp'
  }
  lockPath = join(resumeLogDir, 'resume.lock')
  if (!tryAcquireResumeLock(lockPath)) {
    process.exit(0)
  }
}

await Promise.all(targets.map(t => sendMessage(t.chatId, text, t.threadId)))

// Detach the recovery helper (we already hold the lock). Two flows share the
// same lock + ping encoding but own distinct helpers:
//   • usage limit      → resume-after-reset.ts (park menu, wait for reset,
//                         then continue + retry). Resumes even with NO reset
//                         epoch — the case that used to park the agent until a
//                         manual unlock.
//   • transient API err → resume-after-error.ts (no menu, no wait — just
//                         continue with backoff up to a cap).
// Encode the topic alongside each chat as "chatId:threadId" (bare "chatId"
// when General/DM) so the detached helper threads its resume ping back into
// the same forum topic. chat ids never contain ':' so a plain split is safe
// even for negative supergroup ids.
if (needsRecovery && tmuxCtx && lockPath) {
  const chatsCsv = targets.map(t => (t.threadId ? `${t.chatId}:${t.threadId}` : t.chatId)).join(',')
  const resumeHelper = isRateLimit
    ? join(import.meta.dir, 'resume-after-reset.ts')
    : join(import.meta.dir, 'resume-after-error.ts')
  const helperArgs = isRateLimit
    ? [resumeHelper, String(resetEpoch ?? 0), tmuxCtx.socket, tmuxCtx.target, chatsCsv, lockPath, transcriptPath ?? '']
    : [resumeHelper, tmuxCtx.socket, tmuxCtx.target, chatsCsv, lockPath, transcriptPath ?? '']
  if (existsSync(resumeHelper)) {
    const logFile = join(resumeLogDir, `resume-${Math.floor(Date.now() / 1000)}-${process.pid}.log`)
    const out = openSync(logFile, 'a')
    const child = spawn('bun', helperArgs, {
      detached: true,
      stdio: ['ignore', out, out],
      env: process.env,
    })
    child.unref()
  } else {
    // Helper missing (deploy gap): we already DM'd, so just release the lock
    // so the next episode isn't blocked by a stale one.
    try {
      unlinkSync(lockPath)
    } catch {
      /* noop */
    }
  }
}

process.exit(0)

// Best-effort cross-process lock guarding a single resume helper per agent.
// Exclusive-create wins; an existing lock is honored only if the recorded
// PID is still alive AND the lock is within TTL. A dead PID is reclaimed
// immediately (covers the common failure: agent service restart SIGKILL'd
// the helper before it could releaseLock(), leaving the lock pinned for
// hours and silencing every subsequent rate-limit episode).
//
// TTL covers helpers we can't probe (e.g. PID was recycled by an unrelated
// process). Set generously past the helper's max wait+retry budget so a
// live helper isn't ousted mid-recovery.
const RESUME_LOCK_TTL_MS = 37 * 3600 * 1000
function tryAcquireResumeLock(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, 'wx')
    writeSync(fd, `${process.pid} ${Date.now()}`)
    closeSync(fd)
    return true
  } catch {
    let stale = false
    try {
      const raw = readFileSync(lockPath, 'utf8')
      const pid = parseInt(raw.split(/\s+/)[0] ?? '', 10)
      // process.kill(pid, 0) throws ESRCH if PID is dead. Any other throw
      // (e.g. EPERM — PID alive but owned by another user) means the holder
      // is alive enough to keep the lock.
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0)
        } catch (err: any) {
          if (err?.code === 'ESRCH') stale = true
        }
      }
      if (!stale) {
        const st = statSync(lockPath)
        if (Date.now() - st.mtimeMs > RESUME_LOCK_TTL_MS) stale = true
      }
    } catch {
      /* lock vanished mid-check — let the next StopFailure retry acquire it */
      return false
    }
    if (stale) {
      try {
        const fd = openSync(lockPath, 'w')
        writeSync(fd, `${process.pid} ${Date.now()}`)
        closeSync(fd)
        return true
      } catch {
        return false
      }
    }
    return false
  }
}
